# Maestro v1 — Build Roadmap

Reads together with [`V1_SCOPE.md`](./V1_SCOPE.md) (what) and
[`ARCHITECTURE.md`](./ARCHITECTURE.md) (how/why). This file is the
sequencing: what gets built in what order, why that order, and what "done"
means at each step. Checkbox-level detail lives in
[`CHECKLIST.md`](./CHECKLIST.md).

## Sequencing rationale

The riskiest, least-known part of this app is **wrapping three different
agent CLIs through headless streaming protocols with bidirectional
permission handling** — everything else (file tree, Monaco, git status) is
well-trodden VS Code-clone territory. So the plan front-loads a walking
skeleton (Phase 1–2) fast, then deliberately tackles **one agent adapter
end-to-end (Claude Code) before touching Codex or Cursor Agent**, so the
adapter abstraction in `ARCHITECTURE.md` §3.4 is validated against a real
CLI before being generalized — building all three blind in parallel would
mean discovering the abstraction is wrong three times instead of once.

Terminal, file editor, and git/SCM are independent of the agent work and of
each other, so they're parallelizable across phases 3–4 once the shell
(Phase 1) and worktree manager (Phase 2) exist.

## Phase 0 — Foundations (no UI features)

**Goal:** a repo that builds, lints, tests, and packages an empty Electron
window, on all three OS targets in CI, before any real feature work.

- Scaffold with `electron-vite` (main/preload/renderer split), TypeScript
  strict mode everywhere.
- ESLint + Prettier + `tsc --noEmit` in CI; Vitest wired but empty.
- electron-builder config for AppImage/dmg/nsis producing an installable
  "hello world" on all three platforms via GitHub Actions matrix.
- `contextIsolation`/`sandbox`/CSP baseline from `ARCHITECTURE.md` §5 in
  place from commit one — security posture is not a retrofit.
- Single-instance lock, basic window state persistence (size/position).

**Exit criteria:** `git tag v0.0.1` produces a downloadable AppImage from CI
that opens a blank frameless window and quits cleanly.

**Risks:** electron-builder/AppImage toolchain quirks are easier to fight
now, with zero feature code at stake, than in week 6.

## Phase 1 — Core shell & theming

**Goal:** the chrome from the design file, pixel-faithful, with working
theme switching — no real data yet (mock/static content is fine).

- Titlebar, window controls, activity rail, tab strip (static tabs),
  status bar — ported from `Maestro IDE.dc.html` structure/spacing.
- Theme engine (`ARCHITECTURE.md` §6): the three baseline themes ship,
  runtime CSS-variable swap, persisted choice.
- Settings modal shell (nav + panels, no functional settings yet beyond
  Appearance).
- Command palette shell (⌘/Ctrl-K opens, fuzzy-filters a static command
  list) — real command wiring happens as each feature lands.

**Exit criteria:** a designer/PM looking at the running app next to the
`.dc.html` mock can't tell them apart at the chrome level, and switching
theme is instant with no flash.

## Phase 2 — Project & worktree manager

**Goal:** the left "WORKSPACE" sidebar is fully real: add a project, see
its worktrees, create/remove worktrees, run post-create hooks.

- `GitService` (`ARCHITECTURE.md` §7): status, worktree add/remove/list,
  branch list.
- SQLite schema stood up (`projects`, `worktrees`, `worktree_hooks`).
- "Add project" (native folder picker → validate it's a git repo → index
  it), sidebar tree rendering real projects/branches/worktrees with
  ahead/behind badges.
- New-worktree flow: pick base ref, name branch, create; reconcile against
  `git worktree list --porcelain` so externally-created worktrees (via
  plain `git` in a terminal) show up too.
- Worktree removal with the dirty-tree guard from `V1_SCOPE.md` §2.
- Post-create hooks: presets (copy `.env*`, run detected install command,
  symlink `node_modules`) + custom script editor, executed with streamed
  output and a visible pass/fail result, per `ARCHITECTURE.md` §5.
- Selecting a worktree becomes the app's central piece of state — every
  other panel (explorer, SCM, tabs) keys off it starting next phase.

**Exit criteria:** create a real worktree of a real repo from the UI, watch
a hook script run and its output stream in, remove the worktree, confirm
`git worktree list` on disk matches the sidebar throughout.

## Phase 3 — File explorer & editor

**Goal:** VS Code-fidelity file browsing and editing, scoped to the active
worktree, opening as tabs.

- File tree (virtualized per `ARCHITECTURE.md` §9), scoped to active
  worktree, chokidar-backed live updates.
- File → tab wiring; Monaco mounted lazily on first file-tab open.
- Save, unsaved-changes indicator, close/quit confirmation, external
  change detection ("file changed on disk" prompt).
- Markdown Source/Preview toggle.
- Basic file ops from the tree: create/rename/delete/move.

**Exit criteria:** open, edit, save a file; kill and relaunch the app with
unsaved changes and correctly get prompted; edit the same file externally
(e.g. `echo >> file`) while open and see the reload prompt.

## Phase 4 — Git / SCM integration

**Goal:** the right-side "SOURCE CONTROL" and "COMMIT HISTORY" views, plus
the Monaco-based diff tab, fully wired to the active worktree.

- Status list (staged/changes split), stage/unstage (file + all), commit,
  push/pull/fetch, ahead/behind counts in titlebar and status bar.
- Diff tab: Monaco diff editor fed real blobs (`ARCHITECTURE.md` §7),
  stage/unstage/revert actions from within the diff view.
- Commit history: linear log, click-through to read-only commit diff.
- Debounced incremental status recompute (§9) — verified against a large
  repo (10k+ files) for no UI jank.

**Exit criteria:** make a change, see it appear in Changes within ~300ms,
stage it, open its diff (matches `git diff --staged` output), commit, push,
see ahead/behind update, browse it in history.

## Phase 5 — Agent CLI integration (Claude Code first)

**Goal:** one fully working, resumable, permission-safe agent tab —
Claude Code — validating the `AgentAdapter` interface before generalizing.

- Capability probe (`detect()`): binary on PATH, version, logged-in state;
  surfaced clearly if any check fails (`V1_SCOPE.md` §6).
- Spawn via `-p --input-format stream-json --output-format stream-json
  --permission-prompt-tool stdio` (`ARCHITECTURE.md` §3.1); NDJSON parser
  with fixture-driven unit tests covering partial/interleaved lines.
- Renderer: tool-call cards (Read/Grep/Edit/Bash), thinking-block collapse,
  inline mini-diffs on Edit — ported from the design file's agent-chat
  section.
- Permission requests render as an approve/deny affordance wired to
  `--permission-prompt-tool stdio`'s control-response protocol — this is
  the single riskiest wire in the app; budget real time for it.
- Session list/resume (`--continue`/`--resume`/`--fork-session`) surfaced
  in the new-tab menu's "Resume session" section.
- Composer: send message, @-mention file context, model/mode pickers only
  if the installed version actually exposes them.
- Process lifecycle: interrupt (soft) vs kill (hard) on tab close, orphan
  cleanup on app quit and on next-launch (in case of a previous crash).

**Exit criteria:** run a real multi-turn Claude Code session against a
scratch worktree entirely from the GUI — including approving/denying at
least one tool call — quit and relaunch the app, resume that exact session,
and confirm the transcript matches what `claude --resume` shows natively.

## Phase 6 — Agent CLI integration (Codex & Cursor Agent)

**Goal:** generalize Phase 5's adapter to the other two CLIs, only now that
one is proven.

- `CodexAdapter`: `codex exec --json` + `resume --last`/`resume <id>`
  (`ARCHITECTURE.md` §3.2), including the session-id-missing fallback
  (own SQLite cache reconciled against Codex's own session dir at
  list-time).
- `CursorAgentAdapter`: `agent -p --output-format json`, `agent ls` for
  the resume list, `--continue`/`--resume` (`ARCHITECTURE.md` §3.3).
- Shared tool-call-card renderer verified against both — any per-CLI event
  shape differences get normalized in the adapter, not leaked into
  components (if they leak, the abstraction from Phase 5 was wrong; fix
  the interface, not the component).
- Cross-agent smoke test: same worktree, three agent tabs, one per CLI,
  running concurrently without cross-talk or file-lock contention.

**Exit criteria:** parity with Phase 5's exit criteria, independently, for
both Codex and Cursor Agent.

## Phase 7 — Native terminal tab

**Goal:** a real PTY terminal tab, independent of the agent work.

- `node-pty` in main, `xterm.js` in renderer, IPC-bridged per
  `ARCHITECTURE.md` §3 diagram / §9 (throttled output batching).
- Spawned at the active worktree's path with the user's default shell
  (`$SHELL` on Unix, PowerShell/cmd on Windows).
- Resize handling, clean kill on tab close and app quit (no orphaned shell
  processes left behind — verify with `ps`/Task Manager after quitting).

**Exit criteria:** run a long-lived process (`pnpm dev`, `tail -f`) in the
terminal tab, close the tab, confirm the OS process is actually gone.

## Phase 8 — Cross-cutting polish

**Goal:** the things that turn "feature-complete" into "doesn't feel
broken."

- Command palette fully wired (file jump, all commands from every phase).
- Keybindings settings panel (view + rebind).
- Notifications/toasts for background events (hook finished, agent
  finished while tab not focused, push failed).
- Global error boundary + crash reporting (local log file, not
  remote-by-default) so a renderer exception doesn't nuke the whole app.
- Tab/window state persistence across restarts (open tabs, active
  worktree, scroll positions) — see `CHECKLIST.md` for the full edge-case
  sweep (crashed agent mid-restore, deleted worktree that was open, etc.).
- Full pass through `CHECKLIST.md`'s "Edge cases" section — this phase
  exists specifically to budget time for the long tail, not to add
  features.

**Exit criteria:** `CHECKLIST.md` edge-case section fully checked off.

## Phase 9 — Packaging, auto-update, release hardening

**Goal:** ship it.

- Finalize electron-builder config for all three targets; verify AppImage
  auto-update end-to-end against an *installed* AppImage (not a dev build
  — see the `APPIMAGE` env var gotcha in `ARCHITECTURE.md` §8).
- `.desktop`/icon integration story for Linux (AppImageLauncher doc or
  first-run self-integration).
- Release CI: tag → build matrix → publish artifacts + `latest*.yml` →
  GitHub Release.
- Final manual QA pass (kill -9 the app mid-agent-run, mid-hook-run,
  mid-commit; reboot the machine with tabs open; remove a worktree that
  has a running agent tab; etc. — full list in `CHECKLIST.md`).
- README/user-facing docs: install instructions per platform, "how to
  point Maestro at your CLI binaries," worktree hooks how-to.

**Exit criteria:** the `V1_SCOPE.md` "Definition of done for v1" paragraph,
verified literally, end to end, on a fresh machine, from the packaged
AppImage.

## Rough sequencing at a glance

```
0 Foundations
   │
1 Shell & theming
   │
2 Project & worktree manager  ──────────────┐
   │                                         │
3 File explorer & editor      4 Git/SCM      │  (3 and 4 can run in parallel
   │                             │           │   once 2 is done)
   └────────────┬────────────────┘           │
                 │                            │
5 Agent: Claude Code (prove the adapter)     7 Terminal tab (independent,
   │                                             can start anytime after 2)
6 Agent: Codex + Cursor Agent (generalize)
   │
8 Cross-cutting polish  (needs 3,4,5,6,7 all landed)
   │
9 Packaging & release hardening
```
