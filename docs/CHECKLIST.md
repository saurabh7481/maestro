# Maestro v1 — Implementation Checklist

Actionable checklist mirroring [`ROADMAP.md`](./ROADMAP.md)'s phases, plus a
standalone edge-case sweep. Check items off as they land; this file is meant
to be edited, not archived.

## Phase 0 — Foundations

- [ ] `electron-vite` scaffold: main / preload / renderer entry points
- [ ] TypeScript strict mode, shared `tsconfig.base.json`
- [ ] ESLint + Prettier configured, runs in CI
- [ ] Vitest wired (even with zero real tests yet)
- [ ] `BrowserWindow`: `contextIsolation: true`, `nodeIntegration: false`,
      `sandbox: true`, restrictive CSP meta/header
- [ ] `contextBridge`-only preload API surface (no `ipcRenderer` leak)
- [ ] `app.requestSingleInstanceLock()` wired
- [ ] Window bounds persisted/restored
- [ ] electron-builder config: AppImage / dmg / nsis targets defined
- [ ] GitHub Actions: 3-OS build matrix produces installable artifacts
- [ ] `v0.0.1` tag → CI produces a working, quittable blank-window AppImage

## Phase 1 — Core shell & theming

- [ ] Titlebar: app icon, project/branch breadcrumb, search bar, theme
      swatches, window controls — ported from `Maestro IDE.dc.html`
- [ ] Activity rail (explorer / SCM / history / search icons + badges)
- [ ] Tab strip: render, switch, close, new-tab `+` button
- [ ] New-tab menu: agent list, resume list section, terminal entry
      (static/mock data OK for this phase)
- [ ] Status bar: branch, ahead/behind, changes count, active agent status
- [ ] Theme token schema defined (matches design file's CSS variable set)
- [ ] 3 baseline themes shipped as JSON (Maestro Dark, VS Code Dark+, One
      Dark Pro), ported verbatim from the design file's `themes` object
- [ ] Runtime theme switch: no flash, persists across restart
- [ ] Settings modal: nav + empty panels except Appearance (functional)
- [ ] Command palette: opens on ⌘/Ctrl-K, fuzzy filter over a static list

## Phase 2 — Project & worktree manager

- [ ] SQLite schema created: `projects`, `worktrees`, `worktree_hooks`
- [ ] `GitService.status/diff/log/branchList` implemented via `execa`
- [ ] `GitService.worktreeAdd/worktreeRemove/worktreeList` implemented
- [ ] "Add project": native folder picker, validate `.git` present, index
- [ ] Sidebar renders real project → branch/worktree tree with badges
- [ ] Reconciliation: external `git worktree` changes (made outside
      Maestro) reflected in sidebar on next focus/poll
- [ ] New-worktree flow: base ref picker, branch name, create
- [ ] Worktree removal: dirty-tree guard + explicit force-confirm path
- [ ] Selecting a worktree updates a single global "active worktree" store
- [ ] Hook presets: copy `.env*`, run detected install command, symlink
      `node_modules` — each toggleable
- [ ] Custom hook script editor with `$NEW_WORKTREE` / `$SOURCE_WORKTREE`
      / `$BRANCH` / `$PROJECT_ROOT` variable chips
- [ ] Hook execution: streamed stdout/stderr panel, pass/fail result,
      timeout, cancel button
- [ ] Global default hooks + per-project override, documented precedence

## Phase 3 — File explorer & editor

- [ ] Virtualized file tree component (handles 10k+ nodes smoothly)
- [ ] Tree scoped to active worktree; chokidar watcher started/stopped on
      worktree open/close (not all worktrees at once)
- [ ] Git status glyphs (M/A/D/U) in tree, matching SCM state
- [ ] File → tab open (lazy Monaco mount on first file-tab)
- [ ] Save (⌘S), unsaved-changes dot, close/quit confirm dialog
- [ ] External change detection → reload/keep-mine prompt
- [ ] Markdown tab: Source/Preview toggle
- [ ] Create/rename/delete/move from tree, with rename-in-place editing
- [ ] Large-file guard (disable full tokenization/minimap above threshold)
- [ ] Binary file detection → non-text viewer instead of garbled Monaco

## Phase 4 — Git / SCM integration

- [ ] SCM view: Staged / Changes sections, per-file and stage-all/unstage-all
- [ ] Commit box (⌘Enter to commit), push/pull/fetch buttons with counts
- [ ] Diff tab opens Monaco diff editor with real git blobs
- [ ] Stage/unstage/revert actions available from within the diff tab
- [ ] Commit history: linear log, click-through read-only commit diff
- [ ] Status recompute debounced (150–300ms) off chokidar events
- [ ] Verified on a 10k+ file repo: no jank on status refresh
- [ ] Renamed-file detection shown distinctly (not delete+add)
- [ ] Binary-file diff shows size delta, not a garbled text diff
- [ ] Conflicted file state visibly flagged (not silently shown as "modified")

## Phase 5 — Agent CLI: Claude Code

- [ ] `detect()`: binary on PATH, `--version` parse, logged-in check
- [ ] Clear UI state for "not installed" / "not logged in" / "unsupported
      version" — no silent failure
- [ ] Spawn: `-p --input-format stream-json --output-format stream-json
      --permission-prompt-tool stdio`
- [ ] NDJSON parser with unit tests for partial lines, interleaved events,
      malformed input
- [ ] `AgentEvent` normalization layer implemented
- [ ] Tool-call cards: Read, Grep, Edit (with mini-diff), Bash — ported
      from design file's agent-chat markup
- [ ] Thinking-block collapse/expand
- [ ] Permission request UI (approve/deny/allow-always) wired to
      `--permission-prompt-tool stdio` control-response protocol
- [ ] "Dangerously skip permissions" is an explicit opt-in toggle, off by
      default
- [ ] Session resume: `--continue`, `--resume <id>`, `--fork-session`
      surfaced in new-tab menu's resume list
- [ ] Composer: send, @-mention file context, attach file
- [ ] Model/mode pickers shown only if the installed CLI version exposes
      them
- [ ] Interrupt (soft, SIGINT-equivalent) vs kill (hard) on tab close
- [ ] Orphan process cleanup on app quit and on next launch after a crash
- [ ] End-to-end: multi-turn session incl. one real permission
      approve/deny, quit+relaunch, resume, transcript matches native
      `claude --resume`

## Phase 6 — Agent CLI: Codex & Cursor Agent

- [ ] `CodexAdapter`: `codex exec --json`, `resume --last`, `resume <id>`
- [ ] Codex session-id-missing fallback: SQLite cache + reconciliation
      against Codex's own session directory at list-time
- [ ] `CursorAgentAdapter`: `agent -p --output-format json`, `agent ls`,
      `--continue`, `--resume <id>`
- [ ] Shared tool-card renderer verified against both adapters' real event
      shapes (no per-CLI branching leaked into components)
- [ ] Three concurrent agent tabs (one per CLI) in the same worktree: no
      cross-talk, no lock contention
- [ ] Same parity checklist as Phase 5's end-to-end item, run for each

## Phase 7 — Native terminal tab

- [ ] `node-pty` spawn in main at active worktree's cwd, user's default
      shell
- [ ] `xterm.js` renderer, IPC-bridged, output batched (not per-byte IPC)
- [ ] Resize handling (PTY + xterm both resized together)
- [ ] Clean kill on tab close and app quit — verified no orphaned shell
      process survives (`ps`/Task Manager check)
- [ ] Long-lived process test (`pnpm dev`, `tail -f`) survives resize/scroll

## Phase 8 — Cross-cutting polish

- [ ] Command palette: real file jump + every command from phases 1–7
- [ ] Keybindings panel: view defaults, rebind, persist
- [ ] Toast/notification system for background events (hook done, agent
      done while unfocused, push failed)
- [ ] Global renderer error boundary; crash doesn't kill whole app
- [ ] Local crash/error log file (no remote telemetry by default)
- [ ] Full tab/window state persisted and restored across restart
- [ ] `⌘K` search covers files across the active worktree only (not every
      known worktree)

## Phase 9 — Packaging & release hardening

- [ ] AppImage auto-update verified against an **installed** AppImage
      (not a raw `dist/` build) — `APPIMAGE` env var present
- [ ] `latest-linux.yml`/equivalent published alongside release artifacts
- [ ] `.desktop`/icon integration documented (AppImageLauncher or
      first-run self-integration prompt)
- [ ] Release CI: tag → matrix build → publish → GitHub Release
- [ ] README: per-platform install steps, CLI binary path configuration,
      worktree hooks how-to
- [ ] `V1_SCOPE.md` "Definition of done" verified literally on a fresh
      machine from the packaged AppImage

---

## Edge cases — dedicated sweep (test explicitly, don't assume Phase work covers these)

### Worktrees / git
- [ ] Create worktree for a branch already checked out elsewhere → git's
      own error surfaced clearly, not swallowed
- [ ] Remove a worktree that has uncommitted changes → guarded, explicit
      force path
- [ ] Remove the primary/main worktree → blocked with explanation
- [ ] Remove a worktree while a hook is still running in it → hook killed
      cleanly, no zombie process
- [ ] Remove a worktree that has a running agent tab or terminal tab open
      → those are torn down first, in the right order, not left dangling
- [ ] `git worktree lock`ed worktrees respected (don't allow silent removal)
- [ ] Project containing submodules: worktree creation doesn't corrupt
      submodule state
- [ ] Detached HEAD worktree: sidebar shows commit hash, not a fake branch
      name
- [ ] Case-insensitive filesystem (macOS default, Windows) vs
      case-sensitive (Linux): path handling doesn't break switching OS
- [ ] `.git` as a file (worktree pointer), not a directory — detected and
      handled, not assumed to always be a directory
- [ ] Two worktrees of the same project both running `git` operations
      concurrently (e.g. both `fetch`) — `.git` index/lock contention
      handled (retry/backoff, not a raw error dialog)
- [ ] Deleting the project's root repo externally while Maestro has it
      open → detected, sidebar reflects "missing," doesn't crash
- [ ] Hook script exits non-zero → surfaced as failed, worktree still
      usable (not silently treated as success)
- [ ] Hook script hangs → timeout kills it, user notified
- [ ] Hook references a `$SOURCE_WORKTREE` file that doesn't exist (e.g.
      no `.env` to copy) → non-fatal, clearly logged, not a crash

### Agent CLIs
- [ ] CLI binary missing from PATH → actionable message, not a hung tab
- [ ] CLI installed but not logged in → actionable message with the CLI's
      own login instructions, not a silent failure mid-session
- [ ] CLI version too old for a flag we depend on → detected via capability
      probe before spawn, not discovered via a garbled first response
- [ ] Agent process crashes mid-session → tab shows a clear crashed state,
      offers resume/retry, doesn't leave the UI stuck on a spinner forever
- [ ] Agent process becomes a zombie after app force-quit → detected and
      reaped on next Maestro launch (tracked by PID + start-time in SQLite)
- [ ] Permission-prompt request never answered by the user → times out
      or stays pending indefinitely without blocking other tabs
- [ ] Huge tool output (e.g. a 10k-line file Read) → truncated/collapsed
      in UI by default, doesn't freeze the renderer
- [ ] Network interruption mid-stream (agent CLI's own API call fails) →
      surfaced as an agent-level error event, not a Maestro crash
- [ ] Two different agents (e.g. Claude Code + Codex) editing files in
      the *same* worktree concurrently → both see each other's on-disk
      changes correctly (this is normal filesystem behavior, but the UI's
      file-tree/editor must reflect it live, not go stale)
- [ ] Resume a session whose worktree has since been deleted → handled
      gracefully (offer to pick a new worktree or discard), not a crash
- [ ] `--fork-session` vs mutate-in-place resume: user can tell which one
      they're about to do before committing to it
- [ ] Interrupting a running agent mid-tool-call (e.g. mid-Bash) → the
      underlying process/command is actually terminated, not just the UI
      state

### File editor
- [ ] Open a very large file (e.g. >5MB or >50k lines) → warned/degraded
      mode, doesn't hang the renderer
- [ ] Open a binary file (image, PDF, compiled artifact) → appropriate
      viewer or "binary file" placeholder, not garbled text
- [ ] File deleted externally while open in a tab → clearly flagged, no
      silent data loss on next save-attempt
- [ ] File permissions error on save (read-only file) → clear error, not
      a silently failed save
- [ ] Mixed line endings (CRLF/LF) preserved on save, not silently
      normalized
- [ ] Non-UTF-8 encoded file → detected/handled, not mis-rendered
      mojibake with a silent corrupting save

### App lifecycle
- [ ] `kill -9` the app mid-agent-run → on relaunch, session state is
      consistent (no partial/corrupt SQLite writes — use transactions)
- [ ] `kill -9` mid-hook-run → same
- [ ] `kill -9` mid-commit → git's own atomicity protects the repo; verify
      Maestro's UI state on relaunch matches actual repo state, not a
      stale cached view
- [ ] Machine reboot with tabs open → on relaunch, tabs restore or fail
      gracefully per tab (one broken tab doesn't block restoring the rest)
- [ ] Two Maestro instances launched simultaneously → single-instance
      lock prevents the second from touching shared state
- [ ] Disk full during a hook run / git operation / SQLite write →
      surfaced as an error, not silent data loss

### Cross-platform
- [ ] Git executable discovery works when not on default PATH (e.g.
      macOS app launched from Finder without shell profile PATH)
- [ ] Default shell detection correct per OS (bash/zsh/fish on Unix,
      PowerShell/cmd on Windows) for the terminal tab
- [ ] AppImage runs on at least 2 different distros/desktop environments
      without needing `--no-sandbox` as a workaround (or documents why it's
      needed if unavoidable)
- [ ] Wayland vs X11 rendering checked on Linux (window controls, drag
      regions for the frameless titlebar)
- [ ] Path separator handling correct everywhere paths are displayed or
      constructed (no hardcoded `/`)
