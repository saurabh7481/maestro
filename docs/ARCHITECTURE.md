# Maestro — v1 Architecture

Companion to [`V1_SCOPE.md`](./V1_SCOPE.md) and [`ROADMAP.md`](./ROADMAP.md).
This is the technical decision record: what we build with, why, and the
protocol-level detail needed to wrap three different agent CLIs without
guessing at their interfaces mid-implementation.

> **Framework note (2026-08-13):** v1 was originally scoped on Electron.
> Before any real scaffolding, we ran a live rendering spike — a Tauri v2
> window with Monaco (TypeScript, syntax highlighting, selection, an
> edit-decoration band) and xterm.js (ANSI colors, bold/reverse badges)
> mounted side by side — on this project's actual target environment
> (WebKitGTK 2.52.5, Wayland, Linux). It rendered cleanly: no blank
> window, no flicker, no `AcceleratedSurfaceDMABuf`/`Gdk-Message` errors
> (the documented WebKitGTK failure signatures), crisp text, and correctly
> rendered decorations/ANSI colors. Combined with direct prior art —
> [Heroi](https://github.com/danielss-dev/heroi), a shipped Tauri v2 +
> React + Rust app doing git-worktree + multi-agent-CLI orchestration —
> this was enough to commit to **Tauri v2** for v1. Everything below
> reflects that decision. The one open risk carried forward: the
> WebKitGTK/DMABUF bug class that motivated the spike is specifically
> NVIDIA-driver-triggered and untested on this (Intel iGPU) machine — see
> §9 for the mitigation.

## 1. Process model

Tauri splits the app into a Rust **core process** (native, one per app) and
one or more **WebView** windows (OS-native webview: WebKitGTK on Linux,
WebView2 on Windows, WKWebView on macOS) rendering the frontend. Unlike
Electron, there is no bundled Chromium and no Node.js runtime anywhere in
the shipped app — the frontend webview only ever has JavaScript, never
Node/filesystem/process APIs, unless a Rust `#[tauri::command]` explicitly
exposes one.

```
┌─────────────────────────────────────────────────────────────────────┐
│ Rust core process (native)                                           │
│                                                                        │
│  WindowManager        single WebviewWindow (v1), frameless            │
│  AppState (rusqlite)   projects, worktrees, sessions, hook configs    │
│  GitService            shells out to system `git` via                 │
│                          std::process::Command / tokio::process       │
│  WorktreeHookRunner    spawns hook scripts, streams output as events  │
│  AgentSessionManager   one Tokio task per running (worktree, agent)   │
│    ├─ ClaudeCodeAdapter   spawns `claude -p --input-format stream-json│
│    │                       --output-format stream-json                │
│    │                       --permission-prompt-tool stdio`            │
│    ├─ CodexAdapter        spawns `codex exec --json [resume ...]`     │
│    └─ CursorAgentAdapter  spawns `agent -p --output-format json`      │
│  TerminalManager       PTY sessions (portable-pty or                  │
│                          tauri-plugin-pty), one per terminal tab      │
│  FileWatcher           `notify` crate, scoped per open worktree       │
│  UpdateService         tauri-plugin-updater (AppImage/deb/rpm/        │
│                          dmg/nsis), minisign-signed                   │
│                                                                        │
│  ── every cross-boundary call is a #[tauri::command] or an event ──  │
│  ── gated by the capabilities/permissions system, default-deny ──    │
├─────────────────────────────────────────────────────────────────────┤
│ WebView (React + TypeScript, OS-native: WebKitGTK / WebView2 /       │
│          WKWebView — no Node.js, no filesystem access except via     │
│          explicitly-allowed commands)                                 │
│   Zustand stores mirror core-process state (projects, tabs, theme)    │
│   Monaco (editor + diff), xterm.js (terminal tab), custom agent-      │
│   transcript renderer (tool cards, thinking blocks, diffs)            │
│   `@tauri-apps/api`: `invoke()` for commands, `listen()` for events   │
└─────────────────────────────────────────────────────────────────────┘
```

**Why one WebviewWindow, not one-per-tab.** Same reasoning as before the
framework switch: Conductor/Cursor-style apps read best as a single-window,
tab-multiplexed app, matching the design file's one titlebar/one tab strip.
Tauri supports multiple windows/webviews natively if this changes later,
but it's not a v1 need.

> **v2 update (Phase 13).** "Later" arrived: a tab can now be pulled out
> into a detached window (`chrome/satelliteWindows.ts`), and the editor
> area splits into panes within a window. The default is unchanged — one
> window, one tab strip per pane — and the reason multi-window is cheap
> to add is exactly the property this section already relied on: agent
> runs and PTYs live in the Rust core and stream over app-wide events,
> so a second webview receives the same stream without any shared
> frontend state layer. Moving a tab moves its descriptor, never its
> process.

**Why agent processes live in the Rust core, not the webview.** Same
rationale as before: they're long-running, must survive a webview
reload during development, and must be reachable for cleanup on app
quit/crash. The frontend only ever sees a stream of typed Tauri events.
Rust's `tokio` async runtime is arguably a _better_ fit for this than
Node's event loop was — multiplexing several long-lived child processes'
stdio (agents + PTYs + hook scripts) concurrently is exactly what `tokio`
is for, with no GC pauses to worry about under load.

## 2. Tech stack

| Layer                 | Choice                                                                                                                                                                                                                        | Why                                                                                                                                                                                                                                                                                                                                                                                                             |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Shell                 | Tauri v2                                                                                                                                                                                                                      | No bundled Chromium — uses the OS's native webview + a Rust core. ~30–50MB idle RAM and 3–15MB installers vs Electron's 150–300MB+/80–150MB, ~4x faster cold start (per current benchmarks). Validated on this project's own target environment via the rendering spike above.                                                                                                                                  |
| Backend language      | Rust                                                                                                                                                                                                                          | Tauri's core process is Rust-only; no Node runtime is present in the shipped app. This is also just a good fit for what the backend actually does — spawning/multiplexing child processes (git, three agent CLIs, PTYs, hook scripts) — Rust's ecosystem (`tokio`, `portable-pty`) is mature here.                                                                                                              |
| Bundler/dev server    | Vite                                                                                                                                                                                                                          | Same choice as before the framework switch — fast HMR, first-class React support, and Tauri's own tooling (`@tauri-apps/cli`) is built to sit in front of any Vite-based frontend.                                                                                                                                                                                                                              |
| Language (frontend)   | TypeScript                                                                                                                                                                                                                    | Shared types for the command/event contract (generated or hand-mirrored from the Rust side) and agent event schemas — still the #1 defense against "GUI shows garbage" bugs from frontend/backend drift.                                                                                                                                                                                                        |
| UI framework          | React 18+                                                                                                                                                                                                                     | Unchanged reasoning: team familiarity, ecosystem for Monaco/xterm wrappers, and the design file's component shape maps directly onto components.                                                                                                                                                                                                                                                                |
| State                 | Zustand                                                                                                                                                                                                                       | Unchanged: least-ceremony match for the design file's already-store-shaped `state`/`setState`/`renderVals()` logic.                                                                                                                                                                                                                                                                                             |
| Styling               | CSS custom properties (theme tokens, 1:1 with the design file's `--bg`, `--accent`, etc.) + CSS Modules, or Tailwind v4 with `@theme` mapped onto the same variable set.                                                      | Unchanged: themes are runtime CSS-variable swaps on the root element, never compiled-in colors — preserves the design file's `applyTheme()` mechanism exactly.                                                                                                                                                                                                                                                  |
| Primitives            | Radix UI (unstyled) for menus, dialogs, dropdowns, tooltips                                                                                                                                                                   | Unchanged: accessibility for free, we only supply the visual skin.                                                                                                                                                                                                                                                                                                                                              |
| Icons                 | Phosphor Icons                                                                                                                                                                                                                | Unchanged: zero migration cost from the design file.                                                                                                                                                                                                                                                                                                                                                            |
| Editor                | Monaco Editor                                                                                                                                                                                                                 | Unchanged choice, **now validated to render cleanly in a Tauri/WebKitGTK window** by the spike in this document's header note. Needs explicit Vite worker configuration (`vite-plugin-monaco-editor` or manual `MonacoEnvironment.getWorker`) — the spike surfaced this as a dev-time warning, not a blocker.                                                                                                   |
| Terminal              | `xterm.js` (webview) + a Rust PTY backend (core process), IPC-bridged via Tauri commands/events                                                                                                                               | Same architecture as the Electron plan, different plumbing: evaluate **`tauri-plugin-pty`** first (a maintained Tauri plugin built exactly for this — spawn a shell, pipe `onData`/`write` to xterm.js) before hand-rolling on top of the lower-level `portable-pty` crate (what `tauri-plugin-pty` itself and wezterm are built on) — validated in prior art by Heroi's `xterm.js` + `tauri-pty` terminal tab. |
| Agent transport       | Each CLI's own headless/stream-json mode, spawned via `tokio::process::Command` in the core process — **not** PTY.                                                                                                            | Unchanged rationale: these CLIs already emit structured NDJSON (tool calls, diffs, thinking, results); PTY+ANSI-scraping would throw that structure away. PTY stays reserved for the native-terminal tab. (Note: this is a deliberate divergence from Heroi's simpler raw-PTY-per-agent approach — Heroi doesn't attempt structured tool-call-card rendering; Maestro's design file requires it.)               |
| Local persistence     | `rusqlite` (embedded SQLite, accessed directly from Rust, no separate server)                                                                                                                                                 | Same embedded/zero-server reasoning as `better-sqlite3` before it — Rust's SQLite bindings are mature and this keeps the whole persistence layer inside the core process, no IPC round-trip needed to query it. (`tauri-plugin-sql`, which fronts `sqlx`, is a reasonable alternative if async-from-the-frontend access is ever needed — not needed for v1 since all persistence is core-process-side.)         |
| Git operations        | Shell out to the system `git` binary via `std::process::Command`/`tokio::process::Command` (not `git2`/libgit2)                                                                                                               | Unchanged rationale: `git worktree` support in libgit2-based bindings (Rust's `git2` included) is incomplete/unreliable; shelling to the real binary is what VS Code's own Git extension does and is the only way to get worktree semantics right. Confirmed as the right call independent of language — this isn't an Electron-vs-Tauri question.                                                              |
| File watching         | `notify` crate (Rust's cross-platform equivalent of `chokidar`), one watcher per **open** worktree                                                                                                                            | Same bounding rationale as before: a project with 10 worktrees shouldn't run 10 watchers if only 2 are open in tabs.                                                                                                                                                                                                                                                                                            |
| App lifecycle plugins | Official Tauri plugins: `tauri-plugin-single-instance`, `tauri-plugin-window-state`                                                                                                                                           | Purpose-built, maintained by the Tauri org, cover exactly the single-instance-lock and window-bounds-persistence needs called out in `V1_SCOPE.md`/`ROADMAP.md` Phase 0 — no need to hand-roll either.                                                                                                                                                                                                          |
| Packaging             | Tauri's built-in bundler (`tauri build`, via `tauri-cli`)                                                                                                                                                                     | Native support for AppImage/deb/rpm (Linux), dmg (macOS), msi/nsis (Windows) — no separate tool (no electron-builder equivalent needed, it's built into the Tauri CLI).                                                                                                                                                                                                                                         |
| Auto-update           | `tauri-plugin-updater`                                                                                                                                                                                                        | Supports all the Linux bundle types we care about (deb/rpm/AppImage) as well as Windows/macOS, minisign-signed update artifacts (§9).                                                                                                                                                                                                                                                                           |
| Testing               | Rust: `cargo test` (unit) for `GitService`, adapters, hook runner. Frontend: Vitest (unit). E2E: `tauri-driver` + WebdriverIO (Tauri's WebDriver-based E2E story, analogous to Playwright's Electron driver in the old plan). | Mirrors the old testing pyramid one-for-one, swapped onto Tauri's actual tooling.                                                                                                                                                                                                                                                                                                                               |
| CI                    | GitHub Actions, 3-OS build matrix, using `tauri-action` (official GitHub Action for building/releasing Tauri apps)                                                                                                            | Same need as before (produce AppImage/dmg/msi on every tag); `tauri-action` is the maintained, purpose-built way to do it rather than hand-rolling the matrix from scratch.                                                                                                                                                                                                                                     |

## 3. Agent CLI protocol reference (researched, not assumed)

This section is **unchanged by the framework switch** — the three CLIs'
own interfaces don't care what spawns them. Only the spawning mechanism
changes (Rust's `tokio::process::Command` instead of Node's
`child_process.spawn`/`execa`); the flags, event shapes, and edge cases
below are identical to the Electron-era plan.

> These CLIs evolve fast. Before Phase 5 (see `ROADMAP.md`) starts,
> re-verify every flag below against `<tool> --help` / official docs for
> whatever version is actually installed, and gate on `--version`
> capability detection rather than hard-coding behavior.

### 3.1 Claude Code CLI

- Headless/non-interactive mode: `claude -p "<prompt>"` (`--print`).
- Structured, streamable I/O: `--output-format stream-json` (NDJSON, one
  event per line: assistant messages, tool_use, tool_result, result
  summary with `session_id`/`total_cost_usd`). For **bidirectional**
  control (required for in-UI permission approval), pair it with
  `--input-format stream-json` and `--permission-prompt-tool stdio` —
  without `--permission-prompt-tool`, tool calls auto-deny in non-interactive
  mode, which would make the whole app look broken ("agent refuses to do
  anything"). This is the actual approve/deny mechanism, not a decoration.
- Session continuity: `--continue` (most recent), `--resume <session_id>`
  (specific), `--fork-session` (branch instead of mutate — offer as a
  "resume as new" option in the resume list UI).
- `claude` also has its own hook system (`PreToolUse`, `PostToolUse`,
  `SessionStart`, ~30 events, configured in `.claude/settings.json`). This
  is **orthogonal** to Maestro's worktree-creation hooks (§V1_SCOPE §2) —
  do not conflate the two in the settings UI; label them distinctly
  ("Claude Code hooks" belong to the project's own `.claude/` config and
  are Claude Code's business, not Maestro's).

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
  composer's mode picker _only_ if present for the installed version
  (per the "no fake dropdowns" rule in `V1_SCOPE.md` §6).

### 3.4 Adapter interface (shared shape, per-CLI implementation)

Same conceptual contract as before, expressed as a Rust trait instead of a
TypeScript interface. Each adapter is spawned as a `tokio` task; its NDJSON
output is parsed into a normalized `AgentEvent` enum and forwarded to the
frontend as a Tauri event (`agent://{run_id}/event`), which the renderer's
agent-agnostic tool-card components subscribe to via `listen()`.

```rust
#[async_trait]
trait AgentAdapter: Send + Sync {
    fn id(&self) -> AgentKind; // ClaudeCode | Codex | CursorAgent

    async fn detect(&self) -> DetectResult; // installed / version / authenticated

    async fn list_resumable_sessions(&self, worktree_path: &Path)
        -> Result<Vec<AgentSessionSummary>>;

    fn start(&self, opts: StartOpts) -> AgentRunHandle;
}

trait AgentRunHandle {
    fn send(&self, user_message: &str, context: MessageContext);
    fn respond_to_permission(&self, request_id: &str, decision: PermissionDecision);
    fn interrupt(&self); // SIGINT-equivalent — let the CLI checkpoint
    fn kill(&self);      // last resort on tab close / app quit
    // emits AgentEvent::{Message, ToolCall, ToolResult, Diff,
    //                    PermissionRequest, Thinking, Result, Error, Exit}
    //   over a Tauri event channel, one per run_id
}
```

Normalizing to one `AgentEvent` enum keeps the renderer's tool-call-card
components (Read/Grep/Edit/Bash, per the design file) agent-agnostic — only
the three adapters know each CLI's raw JSON shape. This is unchanged from
the Electron-era plan; only the language moved.

## 4. Data model

`rusqlite` (embedded SQLite, opened once in the core process, wrapped in a
managed `Mutex<Connection>` or a small connection pool) owns structured,
small, relational data:

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

Unchanged from the Electron-era plan (this section is framework-agnostic):
**full agent transcripts are not duplicated into SQLite.** Each CLI already
persists its own session history on disk (that's what `--resume`/`agent
ls`/`codex exec resume` read from). `agent_sessions` is an index/cache row
pointing at `cli_session_id`; if it ever disagrees with what the CLI itself
reports, the CLI wins (see §3.2). `window_bounds`/`open_tabs_json` overlap
with what `tauri-plugin-window-state` already persists for window
geometry — use the plugin for raw window bounds, and this table only for
Maestro-specific UI state (open tabs, active worktree) the plugin doesn't
know about.

## 5. IPC contract & security model

Tauri v2's security model is **capability-based and default-deny**, which
is a stronger starting point than Electron's contextIsolation/preload
pattern (which is secure only if every preload script is disciplined about
what it exposes):

- Every command the frontend can call is an explicit
  `#[tauri::command]` function in Rust. Nothing is reachable unless it's
  both defined _and_ granted to the calling window via a **capability**
  file (`src-tauri/capabilities/*.json`).
- **Three-layer model**: _Capabilities_ (JSON files binding permissions to
  specific windows/platforms) → _Permissions_ (which commands/features are
  allowed) → _Scopes_ (fine-grained limits within a permission, e.g. which
  filesystem paths). All three are additive-only and default-deny — an
  unlisted command simply cannot be invoked from the webview, full stop.
- The frontend never receives raw file-system paths it didn't ask for and
  never constructs shell commands — all git/hook/agent invocation happens
  in the Rust core, parameterized (`Command::new(bin).args([...])`, never
  string-interpolated shell).
- Content Security Policy is configured in `tauri.conf.json`
  (`app.security.csp`) — restrictive by default, no remote script
  execution. Monaco/xterm assets are bundled locally, not CDN-loaded
  (unlike the raw design file's Google Fonts/unpkg `<script>` tags — fine
  for a throwaway mock, not for the shipped app).
- Worktree hook scripts are **trusted-by-design** (the user wrote them) but
  still run through a visible, cancelable, output-streamed execution path
  with a timeout — never silently in the background. If a project was
  added from an untrusted clone, the hook editor should show existing
  hook content before first run, not auto-execute something already
  committed to the repo.
- Single-instance lock via `tauri-plugin-single-instance` — two Maestro
  processes touching the same worktree's SQLite/index concurrently is a
  corruption risk, not just a UX wrinkle.

## 6. Theming system

Unchanged from the Electron-era plan — this is purely a frontend/CSS
concern and doesn't care what shell hosts the webview:

- A theme is a flat JSON map of CSS custom properties (`--bg`, `--bg-2`,
  `--accent`, `--green`, `--mono`, …) — the exact token set already defined
  in `Maestro IDE.dc.html`.
- Built-in themes ship as JSON files (`maestro-dark.json`,
  `vscode-dark-plus.json`, `one-dark-pro.json`) derived verbatim from the
  mock's `themes` object — don't redesign colors, port them.
- `setTheme(name)` sets `document.documentElement.style.setProperty` for
  each token — no CSS-in-JS recompilation, no flash of unstyled content.
- Settings → Appearance allows importing an arbitrary theme JSON matching
  the schema (v1: import only; a visual theme editor is a v2 candidate).

## 7. Git & worktree operations

- All git calls go through a `GitService` in the Rust core, wrapping
  `Command::new("git").args([...]).current_dir(cwd)` — no ad hoc
  string-built commands scattered through the codebase, and no shell
  interpolation of user-controlled strings (args passed as an array, not a
  formatted shell string).
- `git worktree add <path> <branch>` (new branch: `-b`), `git worktree
remove <path>` (guarded — refuse on dirty tree unless `--force` is
  explicitly confirmed in the UI), `git worktree list --porcelain` to
  reconcile Maestro's SQLite view against actual on-disk state on every
  project open (external `git worktree` CLI use outside Maestro must not
  desync the sidebar).
- Status/diff computation is **debounced and incremental**: `notify`
  events coalesce (150–300ms) before triggering `git status
--porcelain=v2`, and only the active worktree's SCM view recomputes
  eagerly; background worktrees refresh lazily when selected.
- Diff rendering: feed Monaco's diff editor the two blobs (`git show
HEAD:<path>` vs working tree, or index vs working tree for unstaged) —
  reuses Monaco's own diff algorithm/rendering rather than hand-rolling a
  line-diff UI.

## 8. Terminal architecture

- Evaluate `tauri-plugin-pty` first (a maintained Tauri plugin purpose-built
  for exactly this: spawn a shell, bridge `onData`/`write` between the
  process and `xterm.js`). Fall back to hand-rolling directly on
  `portable-pty` (the crate `tauri-plugin-pty` and wezterm are themselves
  built on) only if the plugin is missing some needed capability (e.g.
  fine-grained resize timing, custom shell discovery per OS).
- Spawned at the active worktree's path with the user's default shell
  (`$SHELL` on Unix, PowerShell/cmd on Windows).
- PTY reads are blocking at the OS level — run them on a dedicated blocking
  thread/task (`tokio::task::spawn_blocking` or the plugin's own handling)
  rather than the async runtime's main worker threads, so one busy
  terminal can't starve agent-process I/O.
- Output batched toward the frontend at animation-frame cadence (§9), not
  one Tauri event per byte.

## 9. Performance & platform risk notes (the "fast/fluid" requirement)

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
  message.
- **NDJSON backpressure**: an agent that dumps a huge tool result (e.g. a
  10k-line `Read`) must be truncated/collapsed in the UI by default
  (expandable), never rendered as one giant DOM node.
- **Event volume**: batch/throttle high-frequency Tauri events (PTY
  output, streaming agent tokens) to animation-frame cadence on the way to
  the frontend instead of one event per byte/token — the IPC bridge is
  cheaper than Electron's but still not free at thousands of messages/sec.
- **Startup**: lazy-load Monaco and xterm.js bundles only when their first
  tab type is actually opened, not on app boot.
- **WebKitGTK/NVIDIA risk (Linux)**: the spike at the top of this document
  validated clean rendering on Intel/Mesa + Wayland. The documented
  WebKitGTK failure mode (blank/flickering window, "AcceleratedSurfaceDMABuf
  was unable to construct a complete framebuffer") is specifically tied to
  NVIDIA driver + DMABUF renderer conflicts and is **not yet validated on
  NVIDIA hardware**. Mitigation, to document in the app's troubleshooting
  guide and consider as a first-run fallback: the `WEBKIT_DISABLE_DMABUF_RENDERER=1`
  environment variable workaround. Track this explicitly as a Phase 9
  release-hardening item — test on at least one NVIDIA Linux box before
  calling v1 done, not just this (Intel) dev machine.
- **Monaco + Vite worker wiring**: the spike surfaced a dev-time warning
  about Monaco's TypeScript worker not being found by Vite's dep
  optimizer. Solvable with `vite-plugin-monaco-editor` or manual
  `MonacoEnvironment.getWorker` configuration — budget this explicitly in
  Phase 3, don't rediscover it as a surprise.

## 10. Testing strategy

- **Rust unit tests** (`cargo test`): `GitService`, each `AgentAdapter`'s
  NDJSON parser (feed recorded fixture streams, including
  malformed/partial lines), hook-variable substitution, SQLite schema
  migrations.
- **Integration** (Rust, real scratch git repos): exercise
  `worktree_add`/`worktree_remove`/status/diff against a throwaway repo
  created per test — no mocking git itself, it's cheap and the whole point
  is trusting real worktree semantics.
- **Frontend unit** (Vitest): theme loader, tool-card rendering given
  fixture `AgentEvent` streams, Zustand store logic.
- **E2E** (`tauri-driver` + WebdriverIO): launch the built app, drive it
  through add-project → create-worktree → open each agent tab against a
  stub binary that speaks the recorded NDJSON fixtures (no live API calls
  in CI) → assert tool cards render, diff tab opens, commit flow works.
- Manual QA pass before every release against the edge-case list in
  `CHECKLIST.md` §"Edge cases" — automate what's cheap to automate, but
  process-crash/reboot/killed-agent scenarios, and the NVIDIA/WebKitGTK
  check from §9, are worth a human pass every release.

## Sources consulted while researching this document

Agent CLI protocols (unchanged by the framework switch):

- [Headless mode — Claude Code Docs](https://cld-docs.onlinetool.cc/en/docs/claude-code/headless.html)
- [10 Claude Code CLI flags you probably aren't using](https://www.mager.co/blog/2026-04-20-claude-code-cli-flags/)
- [Wrapping Claude CLI for Agentic Applications](https://avasdream.com/blog/claude-cli-agentic-wrapper)
- [`--input-format stream-json` usage is undocumented — anthropics/claude-code#24594](https://github.com/anthropics/claude-code/issues/24594)
- [Claude Code Hooks reference](https://code.claude.com/docs/en/hooks)
- [Headless Execution Mode (`codex exec`) — DeepWiki](<https://deepwiki.com/openai/codex/4.2-headless-execution-mode-(codex-exec)>)
- [Non-interactive mode — ChatGPT Learn (Codex)](https://developers.openai.com/codex/noninteractive)
- [No way to resume in non-interactive mode when session id is not outputted — openai/codex#3817](https://github.com/openai/codex/issues/3817)
- [Cursor CLI Overview — Cursor Docs](https://cursor.com/docs/cli/overview)
- [Using Agent in CLI — Cursor Docs](https://cursor.com/docs/cli/using)

Tauri vs Electron / framework decision:

- [Tauri vs Electron 2026: Tauri Wins on Size, RAM, and Speed — Rustify](https://rustify.rs/articles/rust-tauri-vs-electron-2026)
- [Tauri vs. Electron: performance, bundle size, and the real trade-offs](https://www.gethopp.app/blog/tauri-vs-electron)
- [Tauri vs Electron [2026]: 96% Smaller Apps, 1 Winner](https://tech-insider.org/tauri-vs-electron-2026/)
- [Linux Graphics Issues — Tauri docs](https://v2.tauri.app/develop/debug/linux-graphics/)
- [Problem with WebKitGTK — tauri-apps/tauri Discussion #9088](https://github.com/tauri-apps/tauri/discussions/9088)
- [Webkit is totally unstable... — tauri-apps/tauri Discussion #8524](https://github.com/tauri-apps/tauri/discussions/8524)
- [tauri-monaco-demo — reproduced Monaco/Tauri bug repo](https://github.com/xuchaoqian/tauri-monaco-demo)
- [Heroi — Tauri v2 + React + Rust local AI agent orchestrator](https://github.com/danielss-dev/heroi)
- [tauri-plugin-pty — crates.io](https://crates.io/crates/tauri-plugin-pty)
- [`portable_pty` — docs.rs](https://docs.rs/portable-pty/latest/portable_pty/index.html)
- [AppImage — Tauri docs](https://v2.tauri.app/distribute/appimage/)
- [Updater — Tauri docs](https://v2.tauri.app/plugin/updater/)
- [Capabilities — Tauri docs](https://v2.tauri.app/security/capabilities/)
- [Security and Capabilities System — DeepWiki](https://deepwiki.com/tauri-apps/tauri-docs/5.8-security-and-capabilities-system)
- [Single Instance plugin — Tauri docs](https://v2.tauri.app/plugin/single-instance/)
- [SQL plugin — Tauri docs](https://v2.tauri.app/plugin/sql/)
