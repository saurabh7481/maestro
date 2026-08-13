# Maestro — v1 Architecture

Companion to [`V1_SCOPE.md`](./V1_SCOPE.md) and [`ROADMAP.md`](./ROADMAP.md).
This is the technical decision record: what we build with, why, and the
protocol-level detail needed to wrap three different agent CLIs without
guessing at their interfaces mid-implementation.

## 1. Process model

Electron gives us three process kinds; Maestro's job is to keep the renderer
dumb and the main process the sole owner of anything that touches the OS
(git, filesystem, PTYs, child processes).

```
┌─────────────────────────────────────────────────────────────────────┐
│ Main process (Node.js, TypeScript)                                   │
│                                                                        │
│  WindowManager        single BrowserWindow (v1), frameless            │
│  ProjectStore (SQLite) projects, worktrees, sessions, hook configs    │
│  GitService            shells out to system `git`                     │
│  WorktreeHookRunner    spawns hook scripts, streams output            │
│  AgentSessionManager   one controller per running (worktree, agent)   │
│    ├─ ClaudeCodeAdapter   spawns `claude -p --input-format stream-json│
│    │                       --output-format stream-json                │
│    │                       --permission-prompt-tool stdio`            │
│    ├─ CodexAdapter        spawns `codex exec --json [resume ...]`     │
│    └─ CursorAgentAdapter  spawns `agent -p --output-format json`      │
│  TerminalManager       node-pty instances, one per terminal tab       │
│  FileWatcher           chokidar, scoped per open worktree             │
│  UpdateService         electron-updater (AppImage/dmg/nsis)           │
│                                                                        │
│  ── contextBridge-exposed IPC surface only, no raw ipcRenderer ──     │
├─────────────────────────────────────────────────────────────────────┤
│ Preload (isolated world)                                              │
│   window.maestro.{projects,git,agents,fs,terminal,settings}           │
│   — typed, narrow, promise/event based. No node/electron leakage.     │
├─────────────────────────────────────────────────────────────────────┤
│ Renderer (React + TypeScript, sandboxed, contextIsolation: true,      │
│           nodeIntegration: false, sandbox: true)                      │
│   Zustand stores mirror main-process state (projects, tabs, theme)    │
│   Monaco (editor + diff), xterm.js (terminal tab), custom agent-      │
│   transcript renderer (tool cards, thinking blocks, diffs)            │
└─────────────────────────────────────────────────────────────────────┘
```

**Why one BrowserWindow, not one-per-tab.** Conductor/Cursor-style apps read
best as a single-window, tab-multiplexed app (matches the design file
exactly: one titlebar, one tab strip). Multi-window is a v2 nicety
(`docs/V1_SCOPE.md`), not a v1 need, and it roughly doubles IPC/state-sync
complexity.

**Why agent processes live in main, not renderer.** They're long-running,
must survive a renderer reload (Ctrl+R while debugging shouldn't kill a
20-minute agent run), and must be reachable for cleanup on app quit/crash.
The renderer only ever sees a stream of typed events over IPC.

## 2. Tech stack

| Layer | Choice | Why |
|---|---|---|
| Shell | Electron (latest stable) | Only realistic way to hit AppImage + dmg + exe from one codebase with native PTY/FS access. |
| Bundler | Vite + `electron-vite` | Fast HMR for the renderer during UI-heavy work; first-class multi-entry (main/preload/renderer) config. |
| Language | TypeScript everywhere (main, preload, renderer) | Shared types for the IPC contract and agent event schemas — the #1 source of "GUI shows garbage" bugs is main/renderer type drift. |
| UI framework | React 18+ | Team familiarity assumed, huge ecosystem for Monaco/xterm React wrappers, and the design file's component shape (lots of small conditional views) maps directly onto components. |
| State | Zustand | The design file's own logic (`state`, `setState`, derived `renderVals()`) is already store-shaped; Zustand is the least-ceremony match. No Redux boilerplate needed at this scale. |
| Styling | CSS custom properties (theme tokens, 1:1 with the design file's `--bg`, `--accent`, etc.) + CSS Modules. Tailwind v4 is an acceptable swap *if* its `@theme` tokens map onto the same CSS-variable set — either way, **themes are runtime CSS-variable swaps on the root element**, never compiled-in colors. | Preserves the design file's theming mechanism exactly (`applyTheme` walks a token map and calls `style.setProperty`), so "add a theme" stays a JSON-drop, not a rebuild. |
| Primitives | Radix UI (unstyled) for menus, dialogs, dropdowns, tooltips | Accessibility (focus trap, keyboard nav, ARIA) for free; we only supply the design file's visual skin. |
| Icons | Phosphor Icons (already used in the design file) | Zero migration cost from the mock. |
| Editor | Monaco Editor (`monaco-editor` + `@monaco-editor/react` or a hand-rolled loader) | Same engine as VS Code — closest possible fidelity to "pure VS Code style" for both the file editor and the diff view, and its diff editor is a solved problem, not something to hand-build. |
| Terminal | `node-pty` (main) + `xterm.js` (renderer), IPC-bridged | Standard, battle-tested pairing (VS Code's own architecture) for the native-terminal tab. |
| Agent transport | Each CLI's own headless/stream-json mode over `child_process.spawn` stdio — **not** PTY. | These CLIs already emit structured NDJSON events (tool calls, diffs, thinking, results). PTY+ANSI-scraping would throw that structure away and force us to re-parse terminal output, which is exactly the fragility we're trying to avoid. PTY is reserved for the one tab that's supposed to be a raw terminal. |
| Local persistence | `better-sqlite3` | Synchronous, embedded, zero-server — fits an Electron main process well; used for projects/worktrees/hook-configs/session index (small structured data), not for full agent transcripts (those stay wherever each CLI already persists them — see §4). |
| Git operations | Shell out to the system `git` binary via `execa` (not `isomorphic-git`/`nodegit`) | `git worktree` support in JS git libraries is incomplete/unreliable; shelling to the real binary is what VS Code's own Git extension does, and it's the only way to get worktree semantics right. |
| File watching | `chokidar`, one watcher per **open** worktree (not every known worktree) | Bounds fd/CPU usage; a project with 10 worktrees shouldn't run 10 watchers if only 2 are open in tabs. |
| Packaging | `electron-builder` | De facto standard; native AppImage/dmg/nsis targets, `latest-linux.yml` auto-update metadata out of the box. |
| Auto-update | `electron-updater`, generic or GitHub-releases provider | Ships an `AppImageUpdater` specifically for the Linux target we care most about. |
| Testing | Vitest (unit) + Playwright's Electron driver (`_electron`) (E2E) | Playwright can drive the actual packaged/unpacked Electron app, which is the only way to catch main/renderer IPC bugs before a user does. |
| CI | GitHub Actions, 3-OS build matrix | Needed regardless of where source is hosted, to produce AppImage/dmg/exe on every tag. |

## 3. Agent CLI protocol reference (researched, not assumed)

This is the load-bearing part of the whole app. Each adapter is a small
state machine: spawn → stream NDJSON out → (maybe) stream NDJSON in for
permission responses → normalize into Maestro's internal `AgentEvent` union
→ hand to the renderer.

> These CLIs evolve fast. Before Phase 5 (see `ROADMAP.md`) starts, re-verify
> every flag below against `<tool> --help` / official docs for whatever
> version is actually installed, and gate on `--version` capability
> detection rather than hard-coding behavior.

### 3.1 Claude Code CLI

- Headless/non-interactive mode: `claude -p "<prompt>"` (`--print`).
- Structured, streamable I/O: `--output-format stream-json` (NDJSON, one
  event per line: assistant messages, tool_use, tool_result, result
  summary with `session_id`/`total_cost_usd`). For **bidirectional**
  control (required for in-UI permission approval), pair it with
  `--input-format stream-json` and `--permission-prompt-tool stdio`  —
  without `--permission-prompt-tool`, tool calls auto-deny in non-interactive
  mode, which would make the whole app look broken ("agent refuses to do
  anything"). This is the actual approve/deny mechanism, not a decoration.
- Session continuity: `--continue` (most recent), `--resume <session_id>`
  (specific), `--fork-session` (branch instead of mutate — offer as an
  "resume as new" option in the resume list UI).
- `claude` also has its own hook system (`PreToolUse`, `PostToolUse`,
  `SessionStart`, ~30 events, configured in `.claude/settings.json`). This is
  **orthogonal** to Maestro's worktree-creation hooks (§V1_SCOPE §2) — do not
  conflate the two in the settings UI; label them distinctly ("Claude Code
  hooks" belong to the project's own `.claude/` config and are Claude Code's
  business, not Maestro's).

### 3.2 OpenAI Codex CLI

- Headless mode: `codex exec "<prompt>"`.
- JSON events: `codex exec --json` → NDJSON, one event per state change.
- Resume: `codex exec resume --last` (most recent in cwd), `codex exec
  resume <SESSION_ID>` (specific), `--all` to search beyond cwd.
- **Known gap to design around**: at least one shipped version's
  `--json` output does not reliably surface a `session_id` in the stream,
  which breaks the naive "capture id → resume by id" pattern. Maestro's
  adapter must not assume the id is present — fall back to `resume --last`
  scoped to the worktree's cwd, and independently track our own
  (worktree → last-session) mapping in SQLite as a belt-and-suspenders
  cache, reconciling against whatever Codex's own session directory shows
  at resume-list time (Codex is the source of truth if the two disagree).
- Treat Codex's permission/approval model as a capability to probe for at
  startup (`--help` diffing) rather than assumed identical to Claude Code's
  `--permission-prompt-tool` — do not hard-code a shared abstraction across
  adapters until the real flag surface is confirmed per-version.

### 3.3 Cursor Agent CLI

- Headless mode: `agent -p` / `--print`.
- Output shaping: `--output-format json` (structured) or `text`.
- Session management: `agent ls` (list sessions — use this to populate the
  "Resume session" menu), `agent --continue` (continue most recent),
  `agent --resume <id>` (specific), `agent resume` (shorthand for latest).
- Exposes a `--mode` flag mirroring the editor's modes — surface it in the
  composer's mode picker *only* if present for the installed version
  (per the "no fake dropdowns" rule in `V1_SCOPE.md` §6).

### 3.4 Adapter interface (shared shape, per-CLI implementation)

```ts
interface AgentAdapter {
  readonly id: 'claude-code' | 'codex' | 'cursor-agent';
  detect(): Promise<{ installed: boolean; version?: string; authenticated?: boolean }>;
  listResumableSessions(worktreePath: string): Promise<AgentSessionSummary[]>;
  start(opts: { worktreePath: string; resumeSessionId?: string; forkSession?: boolean }): AgentRun;
}

interface AgentRun extends EventEmitter {
  send(userMessage: string, context?: { files?: string[] }): void;
  respondToPermission(requestId: string, decision: 'allow' | 'deny' | 'allow-always'): void;
  interrupt(): void;   // SIGINT-equivalent, not SIGKILL — let the CLI checkpoint
  kill(): void;        // last resort on tab close / app quit
  // events: 'message' | 'tool_call' | 'tool_result' | 'diff' | 'permission_request'
  //       | 'thinking' | 'result' | 'error' | 'exit'
}
```

Normalizing to one `AgentEvent` union lets the renderer's tool-call-card
components (Read/Grep/Edit/Bash, per the design file) stay agent-agnostic —
only the three adapters know each CLI's raw JSON shape.

## 4. Data model

SQLite (`better-sqlite3`) owns structured, small, relational data:

```
projects(id, name, root_path, added_at)
worktrees(id, project_id, path, branch, created_at, is_primary,
          last_opened_at)
worktree_hooks(id, project_id, kind['preset'|'custom'], config_json,
               enabled)
agent_sessions(id, worktree_id, agent['claude-code'|'codex'|'cursor-agent'],
               cli_session_id, started_at, last_active_at, title)
ui_state(window_bounds, open_tabs_json, active_tab_id, theme, ...)
settings(key, value_json)   -- keybindings, agent binary paths, etc.
```

**Full agent transcripts are not duplicated into SQLite.** Each CLI already
persists its own session history on disk (that's what `--resume`/`agent ls`/
`codex exec resume` read from). `agent_sessions` is an index/cache row
pointing at `cli_session_id`, used to populate "Resume session" quickly and
to remember which session a given worktree/tab was last bound to — if it
ever disagrees with what the CLI itself reports, the CLI wins (see §3.2).

Rationale: don't build a second source of truth for something the wrapped
tools already own — that's exactly the kind of drift that produces "resume
opened the wrong conversation" bugs.

## 5. IPC contract & security model

- `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true` on
  every `BrowserWindow` — non-negotiable baseline (Electron's own security
  guidance; a single unpatched V8 bug otherwise becomes RCE).
- Preload exposes a **narrow, typed** `window.maestro` API via
  `contextBridge.exposeInMainWorld` — never `ipcRenderer` itself. Every
  method is enumerated (no wildcard "invoke any channel" escape hatch).
- Renderer never receives raw file-system paths it didn't ask for and never
  constructs shell commands — all git/hook/agent invocation happens in
  main, parameterized (`execa(bin, args[])`, never string-interpolated
  shell).
- Content Security Policy set restrictively (no remote script execution;
  Monaco/xterm assets are bundled locally, not CDN-loaded, unlike the raw
  design file's Google Fonts/unpkg `<script>` tags — those are fine for a
  throwaway mock, not for the shipped app).
- Worktree hook scripts are **trusted-by-design** (the user wrote them) but
  still run through a visible, cancelable, output-streamed execution path
  with a timeout — never silently in the background. If a project was
  added from an untrusted clone, the hook editor should show existing
  hook content before first run, not auto-execute something already
  committed to the repo.
- Single-instance lock (`app.requestSingleInstanceLock`) — two Maestro
  processes touching the same worktree's SQLite/index concurrently is a
  corruption risk, not just a UX wrinkle.

## 6. Theming system

Directly generalizes the design file's `themes` map + `applyTheme()`:

- A theme is a flat JSON map of CSS custom properties (`--bg`, `--bg-2`,
  `--accent`, `--green`, `--mono`, …) — the exact token set already defined
  in `Maestro IDE.dc.html`.
- Built-in themes ship as JSON files (`maestro-dark.json`, `vscode-dark-plus
  .json`, `one-dark-pro.json`) derived verbatim from the mock's `themes`
  object — don't redesign colors, port them.
- `setTheme(name)` sets `document.documentElement.style.setProperty` for
  each token — no CSS-in-JS recompilation, no flash of unstyled content.
- Settings → Appearance allows importing an arbitrary theme JSON matching
  the schema (v1: import only; a visual theme editor is a v2 candidate).

## 7. Git & worktree operations

- All git calls go through `execa('git', [...args], { cwd })` in main,
  wrapped in a `GitService` with typed methods (`status`, `diff`, `stage`,
  `commit`, `push`, `worktreeAdd`, `worktreeRemove`, `log`, …) — no ad hoc
  string-built commands scattered through the codebase.
- `git worktree add <path> <branch>` (new branch: `-b`), `git worktree
  remove <path>` (guarded — refuse on dirty tree unless `--force` is
  explicitly confirmed in the UI), `git worktree list --porcelain` to
  reconcile Maestro's SQLite view against actual on-disk state on every
  project open (external `git worktree` CLI use outside Maestro must not
  desync the sidebar).
- Status/diff computation is **debounced and incremental**: chokidar events
  coalesce (150–300ms) before triggering `git status --porcelain=v2`, and
  only the active worktree's SCM view recomputes eagerly; background
  worktrees refresh lazily when selected.
- Diff rendering: feed Monaco's diff editor the two blobs (`git show
  HEAD:<path>` vs working tree, or index vs working tree for unstaged) —
  reuses Monaco's own diff algorithm/rendering rather than hand-rolling a
  line-diff UI.

## 8. Packaging & auto-update specifics

- `electron-builder` targets: `AppImage` (Linux, primary), `dmg`+`zip`
  (macOS), `nsis` (Windows). AppImage is never wrapped in a further
  zip/tar — it must stay directly executable.
- Desktop integration (`.desktop` file, icon registration) is **not**
  bundled by electron-builder ≥21 for AppImage — document
  AppImageLauncher (or a first-run "integrate with system" prompt that
  writes the `.desktop` file ourselves) rather than assuming double-click
  installs it.
- Auto-update: `electron-updater`'s `AppImageUpdater`, fed by
  `latest-linux.yml` published alongside releases (GitHub Releases is
  the default provider; self-hosted generic provider is a drop-in swap).
  Known gotcha: update checks rely on the `APPIMAGE` env var being set,
  which is only true for an *installed/launched* AppImage, not a
  freshly-built one run straight out of `dist/` during dev — test
  auto-update against an actually-installed AppImage, not the build
  output directly.
- Code signing for macOS (notarization) and Windows (Authenticode) is
  explicitly non-blocking for v1 per `V1_SCOPE.md` — scaffold the
  electron-builder config for it, but shipping an unsigned dmg/exe with a
  clear "unidentified developer" doc note is acceptable for v1.

## 9. Performance techniques (the "fast/fluid" requirement)

- **File tree**: virtualized list (render only visible rows) — required
  the moment a repo has thousands of files; do not defer this to "later"
  since retrofitting virtualization onto a naive tree is a rewrite, not a
  patch.
- **Editor tabs**: Monaco models are created lazily on first open and
  disposed when a tab closes past some LRU cap (e.g. keep last 10 models
  warm) — an agent session that touches 200 files over an hour must not
  leave 200 live Monaco models in memory.
- **Agent transcript virtualization**: long sessions (hundreds of tool
  calls) render via a virtualized list, not a naive `.map()` over every
  message — this is exactly the kind of view the design file's chat pane
  will accumulate unbounded content in.
- **NDJSON backpressure**: an agent that dumps a huge tool result (e.g. a
  10k-line `Read`) must be truncated/collapsed in the UI by default
  (expandable), never rendered as one giant DOM node.
- **IPC volume**: batch/throttle high-frequency events (PTY output,
  streaming agent tokens) to animation-frame cadence on the way to the
  renderer instead of one IPC message per byte/token.
- **Startup**: lazy-load Monaco and xterm.js bundles only when their first
  tab type is actually opened, not on app boot — keeps cold-start snappy
  for a user who only wants to talk to an agent.

## 10. Testing strategy

- Unit (Vitest): `GitService`, each `AgentAdapter`'s NDJSON parser (feed
  recorded fixture streams, including malformed/partial lines), theme
  loader, hook-variable substitution.
- Integration: spin up a real scratch git repo per test, exercise
  `worktreeAdd`/`worktreeRemove`/status/diff against it — no mocking git
  itself, it's cheap and the whole point is trusting real worktree
  semantics.
- E2E (Playwright `_electron`): launch the built app, drive it through
  add-project → create-worktree → open each agent tab against a stub
  binary that speaks the recorded NDJSON fixtures (no live API calls in
  CI) → assert tool cards render, diff tab opens, commit flow works.
- Manual QA pass before every release against the edge-case list in
  `CHECKLIST.md` §"Edge cases" — automate what's cheap to automate, but
  process-crash/reboot/killed-agent scenarios are worth a human pass every
  release.

## Sources consulted while researching this document

- [Headless mode — Claude Code Docs](https://cld-docs.onlinetool.cc/en/docs/claude-code/headless.html)
- [10 Claude Code CLI flags you probably aren't using](https://www.mager.co/blog/2026-04-20-claude-code-cli-flags/)
- [Wrapping Claude CLI for Agentic Applications](https://avasdream.com/blog/claude-cli-agentic-wrapper)
- [claude-cli-agent-protocol skill notes](https://raw.githubusercontent.com/NeverSight/skills_feed/refs/heads/main/data/skills-md/bohdan-shulha/skills/claude-cli-agent-protocol/SKILL.md)
- [`--input-format stream-json` usage is undocumented — anthropics/claude-code#24594](https://github.com/anthropics/claude-code/issues/24594)
- [Claude Code Hooks reference](https://code.claude.com/docs/en/hooks)
- [Headless Execution Mode (`codex exec`) — DeepWiki](https://deepwiki.com/openai/codex/4.2-headless-execution-mode-(codex-exec))
- [Non-interactive mode — ChatGPT Learn (Codex)](https://developers.openai.com/codex/noninteractive)
- [No way to resume in non-interactive mode when session id is not outputted — openai/codex#3817](https://github.com/openai/codex/issues/3817)
- [CLI flag to save trajectory/output as JSON for non-interactive `codex exec` runs — openai/codex#2288](https://github.com/openai/codex/issues/2288)
- [Cursor CLI Overview — Cursor Docs](https://cursor.com/docs/cli/overview)
- [Using Agent in CLI — Cursor Docs](https://cursor.com/docs/cli/using)
- [electron-builder Configuration](https://www.electron.build/docs/configuration/)
- [AppImage — electron-builder](https://www.electron.build/appimage.html)
- [Linux — electron-builder](https://www.electron.build/docs/linux/)
- [Auto Update — electron-builder](https://www.electron.build/auto-update)
- [`AppImageUpdater` class — electron-builder](https://www.electron.build/electron-updater.Class.AppImageUpdater.html)
- [Auto Updater not working with Linux AppImage — electron-userland/electron-builder#4349](https://github.com/electron-userland/electron-builder/issues/4349)
- [Security — Electron docs](https://www.electronjs.org/docs/latest/tutorial/security)
- [Process Sandboxing — Electron docs](https://www.electronjs.org/docs/latest/tutorial/sandbox)
- [Electron App Security: Context Isolation, nodeIntegration, and the RCE Class That Keeps Coming Back](https://appsecbrief.com/articles/electron-app-security-context-isolation-rce/)
- [node-pty Electron example — microsoft/node-pty](https://github.com/Microsoft/node-pty/tree/main/examples/electron)
- [Electron Forge + node-pty: Bundle a terminal in your Electron app](https://thomasdeegan.medium.com/electron-forge-node-pty-9dd18d948956)
- [Conductor.build: Run a Team of Parallel AI Coding Agents on Your Mac](https://codepick.dev/en/guides/conductor-build-intro/)
- [The Parallel Agent Multiplier with Git Worktrees and Conductor](https://elite-ai-assisted-coding.dev/p/the-parallel-agent-multiplier-conductor-with-charlie-holtz)
- [9 Open-Source Agent Orchestrators for AI Coding (2026)](https://www.augmentcode.com/tools/open-source-agent-orchestrators)
