# Maestro v1 — Implementation Checklist

Actionable checklist mirroring [`ROADMAP.md`](./ROADMAP.md)'s phases, plus a
standalone edge-case sweep. Check items off as they land; this file is meant
to be edited, not archived.

## Phase 0 — Foundations

- [x] Framework viability spike: Monaco + xterm.js rendered cleanly in a
      Tauri v2 window on WebKitGTK 2.52.5 / Wayland / Intel iGPU — no
      blank window, no `AcceleratedSurfaceDMABuf`/`Gdk-Message` errors, see
      `ARCHITECTURE.md` header note. NVIDIA hardware still untested — carried
      to Phase 9.
- [x] `create-tauri-app` scaffold (React + TS template): Cargo workspace
      (`src-tauri/`) + Vite frontend (`src/`)
- [x] TypeScript strict mode on the frontend; `cargo clippy -D warnings` +
      `cargo fmt --check` on the core — both verified clean
- [x] ESLint + Prettier configured (runs locally; CI job added, not yet
      exercised by a real push)
- [x] Vitest wired on the frontend (smoke test passing); `cargo test`
      wired on the core (0 tests, passes)
- [x] Capabilities/permissions baseline: default-deny, only
      `core:default`/`opener:default` granted, restrictive CSP in
      `tauri.conf.json` — verified the app still renders correctly under
      this CSP (live window screenshot, not just "it compiled")
- [x] `tauri-plugin-single-instance` wired
- [x] `tauri-plugin-window-state` wired
- [x] Tauri bundler config: `targets: "all"` (per-host default covers
      AppImage/deb/rpm on Linux, dmg on macOS, msi/nsis on Windows)
- [x] GitHub Actions workflows written (`ci.yml` fast checks,
      `release.yml` tag-triggered 3-OS `tauri-action` matrix) — **not yet
      run**, no push to a remote/tag has happened yet
- [ ] `v0.0.1` tag → CI produces a working, quittable blank-window AppImage
      (blocked on pushing to a remote — local run confirmed the window
      itself opens, renders, and quits cleanly)

## Phase 1 — Core shell & theming

- [x] Titlebar: app icon, project/branch breadcrumb, search bar, theme
      swatches, window controls — ported from `Maestro IDE.dc.html`, window
      controls wired to real `@tauri-apps/api/window` calls, drag region
      via `data-tauri-drag-region`
- [x] Activity rail (explorer / SCM / history / search icons + badges)
- [x] Tab strip: render, switch, close, new-tab `+` button
- [x] New-tab menu: agent list, resume list section, terminal entry
      (static/mock data, per this phase's scope)
- [x] Status bar: branch, ahead/behind, changes count, active agent status
      (static/mock, real wiring lands with git/agent phases)
- [x] Design token system: color (per-theme), typography (incl. a rem-based
      zoom scale), spacing, radius, shadow, motion, z-index — see
      `src/styles/tokens.css`
- [x] 3 baseline themes shipped as data (Maestro Dark, VS Code Dark+, One
      Dark Pro), ported verbatim from the design file's `themes` object —
      `src/design/themes.ts`
- [x] Runtime theme switch: no flash (direct `style.setProperty`, no
      re-render/recompile), persists across restart via `tauri-plugin-store`
      — verified end-to-end by editing the persisted prefs file and
      confirming the relaunched window hydrates with the new theme _and_
      zoom, not just by clicking through the UI once
- [x] Adjustable UI zoom (Ctrl/Cmd +/-/0), rem-based so the whole UI scales
      together rather than only font-size in isolation — verified visually
      at 1.3x, not just unit-tested
- [x] Self-hosted fonts (Inter Variable + JetBrains Mono via `@fontsource*`,
      no CDN) + WebKitGTK's ~100-unit font-weight-bolding bug compensated
      via a `data-platform="linux"` CSS override (tauri-apps/tauri#14286)
- [x] Settings modal: nav + Appearance panel functional (theme picker +
      zoom control), other panels show an honest "not wired yet" placeholder
      rather than fake controls
- [x] Command palette: opens on ⌘/Ctrl-K, in-order-subsequence fuzzy filter
      over a static command list, wired to real store actions (theme,
      zoom, sidebar toggles, new terminal tab)
- [x] Found and fixed a real bug during visual verification: raw
      `<button>` elements without an explicit background/border fell back
      to WebKitGTK's native button chrome (a glossy gray rounded rect) —
      fixed with a global form-element reset in `src/styles/global.css`
      rather than patching the one instance found

## Phase 2 — Project & worktree manager

- [x] SQLite schema created: `projects`, `worktrees` (reconciled cache, not
      source of truth — see `ARCHITECTURE.md` §4), `worktree_hooks`
- [x] `GitService` implemented in Rust (`src-tauri/src/git.rs`): shells out
      to system `git` via `tokio::process::Command`, not `execa` (that was
      the Electron-era plan — see the Tauri pivot commit) — status/dirty
      check, branch list, worktree add/remove/list (porcelain parser)
- [x] "Add project": native folder picker (`tauri-plugin-dialog`), validates
      `.git` present via `git rev-parse --is-inside-work-tree`, indexes
- [x] Sidebar renders real project → branch/worktree tree with ahead/behind
      badges (dirty-file count surfaced in the status bar, not a sidebar
      dot — see `ARCHITECTURE.md`/component comments for why)
- [x] Reconciliation: external `git worktree` changes reflected on window
      focus (`window.addEventListener("focus", ...)` in `WorkspaceSidebar`)
- [x] New-worktree flow: base ref picker (defaults to current worktree's
      branch), branch name, create — dialog transitions into the hook run
- [x] Worktree removal: dirty-tree guard (checked both in the Tauri command
      and by git itself) + explicit force-confirm path via `AlertDialog`,
      primary worktree removal blocked
- [x] Selecting a worktree updates a single global "active worktree" store
      (`workspaceStore`), which now drives the titlebar breadcrumb, explorer
      header, and status bar — not just the sidebar highlight
- [x] Hook presets: copy `.env*`, run detected install command (lockfile
      sniffing in `git::detect_install_command`), symlink `node_modules` —
      each toggleable, persisted per project
- [x] Custom hook script editor with `$NEW_WORKTREE` / `$SOURCE_WORKTREE`
      / `$BRANCH` / `$PROJECT_ROOT` variable chips (click-to-insert at
      cursor)
- [x] Hook execution: streamed stdout/stderr panel (Tauri events, one per
      line), pass/fail/cancelled/timed-out result, 120s timeout, cancel
      button (oneshot-channel based, doesn't require holding the child
      process handle across the command boundary)
- [ ] Global default hooks + per-project override — **simplified for v1**:
      each project gets sensible built-in defaults at add-time (env-copy
      on, install-command on with auto-detected command, symlink off) via
      SQL column defaults, not a separately editable global template. A
      true global-defaults editor is deferred; not blocking, since the
      per-project experience is what V1_SCOPE actually requires.

**Bugs found and fixed during real end-to-end testing** (against the
user's actual multi-worktree production repo, not just the scratch demo
repo) — kept here because both were the kind of thing that only shows up
under real use, not code review:

- `cp`/`ln -s` succeed silently, so a working hook produced zero streamed
  lines and the UI showed a misleading "No hooks configured" — fixed by
  making the generated script always echo what it did (or didn't do).
- The source-worktree fallback for the post-create hook resolved to the
  _newly created_ worktree itself, because `createWorktree()` flips the
  store's active-worktree pointer to the new worktree as part of that
  call, and the fallback was computed reactively _after_ that flip instead
  of captured before it. Fixed by capturing the source path synchronously
  before calling `createWorktree()`.

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

> **Protocol note:** the live spike (see `agents/claude.rs`'s module
> doc) found the installed CLI has no `--permission-prompt-tool` flag —
> `ARCHITECTURE.md`'s assumption was stale. Real mechanism: `--permission-
mode manual` + `--allowedTools` gates tools; a gated call auto-denies
> inline (no live control-request/response round-trip exists); "approve"
> is implemented as a fresh `--resume`'d spawn with the tool added to the
> allow-list. Centralized CLI availability (`agents/registry.rs` +
> `agentAvailabilityStore.ts`) also covers Codex/Cursor detection, per the
> "usable elsewhere" requirement — see `generate_commit_message`.

- [x] `detect()`: binary on PATH, `--version` parse, logged-in check — via
      each CLI's own real local auth-status command (`claude auth status
--json`, `cursor-agent status --format json`); Codex's is
      unverified (not installed anywhere this project could test against)
      and reported as `Unknown`, never guessed
- [x] Clear UI state for "not installed" / "not logged in" — `AgentTab`'s
      not-ready cards, `AgentsPane` status pills, `NewTabMenu` disabled
      items with reason tooltips. "Unsupported version" gating not
      implemented (no version floor identified to gate on)
- [x] Spawn: `--print --input-format stream-json --output-format
stream-json --permission-mode manual --allowedTools ...` (real flag
      surface, not the stale assumed one — see note above)
- [x] NDJSON parser with unit tests for partial lines, interleaved events,
      malformed input — fixture-driven against real captured CLI output
      (`src-tauri/tests/fixtures/claude/`)
- [x] `AgentEvent` normalization layer implemented
- [x] Tool-call cards: Read, Grep, Edit (with mini-diff), Bash — ported
      from design file's agent-chat markup
- [x] Thinking-block collapse/expand
- [x] Permission request UI (approve/deny/allow-always) — real mechanism
      per the protocol note above, not the originally-assumed one
- [x] "Dangerously skip permissions" is an explicit opt-in toggle, off by
      default
- [x] Session resume: `--resume <id>`, `--fork-session` surfaced in
      new-tab menu's resume list (sessions discovered by reading
      `~/.claude/projects/.../*.jsonl` directly — no non-interactive list
      command exists)
- [x] Composer: send, @-mention file context (fuzzy-matched against the
      explorer tree's already-loaded entries)
- [x] Model picker (`--model`, a confirmed real flag) shown; no separate
      mode picker (Claude Code's `--permission-mode` is what Maestro
      itself drives, not a user-facing picker)
- [x] Interrupt (soft, SIGINT via `nix`, Unix) vs kill (hard) on tab close
- [x] Process cleanup on app quit (`RunEvent::ExitRequested` sweep). PID
      based orphan-reaping _across restarts_ after a `kill -9` is **not**
      implemented — tracked as the same pre-existing gap the hook runner
      has, per the dedicated Edge cases sweep below, not this phase's own
      list
- [ ] End-to-end manual QA (multi-turn session incl. a real permission
      approve/deny, quit+relaunch, resume, transcript matches native
      `claude --resume`) — not run in this session (sandboxed, no
      interactive verification); typecheck/lint/`cargo test`/`cargo
clippy`/full `cargo build` all pass, but this line item specifically
      needs a human pass

## Phase 6 — Agent CLI: Codex & Cursor Agent

> **Generalization note:** Phase 5's Claude-only `claude_code.rs` was
> split into `agents/manager.rs` (shared spawn/stream/lifecycle,
> CLI-agnostic) + `agents/adapter.rs` (the one `match AgentKind` dispatch
> point) + one module per CLI (`claude.rs`, `cursor_agent.rs`,
> `codex.rs`), per `ARCHITECTURE.md` §3.4's normalization principle — no
> per-CLI branching leaked into `manager.rs` or any frontend component.
>
> **Cursor Agent got the same live-spike rigor as Claude** (it's the
> user's primary tool): real flag surface confirmed (`--trust` workspace-
> gate, positional prompt arg, `--resume`, `--list-models`), real
> stream-json event shapes captured as fixtures
> (`src-tauri/tests/fixtures/cursor/`), and two real bugs caught by
> testing against that captured data before shipping — a raw (unescaped)
> newline byte inside a `call_id` splitting one JSON object across two
> physical lines, and `tool_call.tool_call` being misidentified because
> it's a flat multi-key object (`serde_json`'s default `BTreeMap` sorted
> an unrelated key first), not the single-key object assumed.
>
> **Cursor's permission model is config-file-driven** (`~/.cursor/
cli-config.json`'s `approvalMode`/`permissions.allow`/`deny`), not
> per-invocation like Claude's `--allowedTools` — Maestro deliberately
> doesn't read/rewrite that file (global, shared with the user's IDE).
> With this machine's config already set to `unrestricted`, a live tool
> denial was never actually observed; the "denied" detection heuristic
> (a `tool_call` result with no `success` key) is documented as unverified
> against a real denial in `cursor_agent.rs`'s module doc.
>
> **Codex is unverified** — not installed anywhere this project could
> test against. `codex.rs`/its detection/session-list are best-effort
> from `ARCHITECTURE.md` §3.2 plus general knowledge of the CLI's event
> shapes, clearly labeled as such in-code; unrecognized events forward as
> a visible "raw event" card rather than vanishing silently either way.

- [x] `CodexAdapter`: `codex exec --json`, `resume <id>` — best-effort/
      unverified (see note above); `resume --last` (most-recent-in-cwd,
      no explicit id) not implemented since the interactive tab always
      has a specific session id once one exists
- [ ] Codex session-id-missing fallback / SQLite reconciliation — moot
      until Codex is actually installed somewhere to observe whether the
      gap `ARCHITECTURE.md` §3.2 flagged is still real in a current build
- [x] `CursorAgentAdapter`: `-p <prompt> --output-format stream-json
--trust [--resume <id>]` (real flag surface, confirmed live —
      `agent -p --output-format json`/`agent ls` from `ARCHITECTURE.md`
      §3.3 don't match: `ls` is an interactive TUI, confirmed live, and
      one-shot uses `--output-format json` not the streaming form)
- [x] Shared tool-card renderer verified against both adapters' real event
      shapes: `ToolCallCard.tsx` needed zero Cursor-specific branching —
      both adapters normalize edit/write results into diff-ish text +
      `diffAdded`/`diffRemoved` server-side
- [ ] Three concurrent agent tabs (one per CLI) in the same worktree: no
      cross-talk, no lock contention — not run in this session (see Phase
      5's identical end-to-end caveat)
- [ ] Same parity checklist as Phase 5's end-to-end item, run for each —
      same caveat; Cursor Agent's turn-taking/resume was verified via the
      live spike (individual commands), not a full multi-turn GUI session

## Phase 7 — Native terminal tab

- [x] Hand-rolled directly on `portable-pty` (not `tauri-plugin-pty`) —
      consistent with every other long-running child process in this
      codebase already being a hand-rolled `AppState`-keyed manager
      (`hooks.rs`, `agents/`); spawns `$SHELL` (fallback `/bin/bash`) at
      the active worktree's cwd
- [x] `xterm.js` (`@xterm/xterm` + `@xterm/addon-fit`) frontend,
      event-bridged, output batched at ~16ms (not per-byte)
- [x] PTY reads run on a dedicated OS thread (not the async runtime's
      workers), forwarded through a channel to the batching task
- [x] Resize handling (PTY + xterm both resized together, via a
      `ResizeObserver`)
- [x] Kill on tab close (`TabStrip`'s teardown) and app quit
      (`RunEvent::ExitRequested` sweep, alongside agent runs) — not
      independently verified with a live `ps` check in this session (see
      Phase 5's end-to-end line item, same constraint)
- [ ] Long-lived process test (`pnpm dev`, `tail -f`) survives
      resize/scroll — needs a human/interactive pass

## Phase 8 — Cross-cutting polish

- [x] Command palette: real file jump (⌘P quick-open, `CommandPalette.tsx`);
      ⌘K's static command list audited against every phase 1–7 feature and
      filled in (Search view, OLED theme, Fetch/Pull/Push, per-kind "New
      Agent Session" for ready CLIs only, "Go to File") — also caught and
      fixed a real bug in the process: the palette's "New Terminal" never
      set `worktreeRoot`, so `TerminalTab.tsx` silently bailed before
      spawning and the tab just sat blank forever
- [x] Keybindings panel: view defaults, rebind, persist — `design/keymap.ts`
      (action registry, combo matching/formatting), `keybindingsStore.ts`
      (overrides, persisted via `design/persistence.ts`'s
      `keybindings.json`), `settings/KeybindingsPane.tsx`. The four
      previously-hardcoded global shortcuts (zoom, save, new terminal,
      command palette/quick-open) now all read from the keymap instead of
      a literal key check
- [x] Toast/notification system for background events (hook done, agent
      done while unfocused, push failed) — `state/toastStore.ts` +
      `chrome/ToastHost.tsx`. "Agent done"/"agent crashed" only toast when
      that tab isn't the focused one in a focused window
      (`agentSessionStore.ts`'s `notifyIfBackgrounded`); hook-finished and
      push-failed toast unconditionally
- [x] Global renderer error boundary; crash doesn't kill whole app
      (`ErrorBoundary.tsx`, wraps `<AppShell />`)
- [x] Local crash/error log file (no remote telemetry by default) —
      `tauri-plugin-log` writing to `app.log_dir()`, wired to a Rust panic
      hook (`install_panic_log_hook` in `lib.rs`, meaningful given
      `panic = "abort"` in the release profile) and, on the frontend, to
      `ErrorBoundary`'s `componentDidCatch` plus `window`'s `error`/
      `unhandledrejection` listeners — replacing the TEMPORARY DOM crash
      overlay `main.tsx` had carried since Phase 0 for exactly this gap
- [x] Full tab/window state persisted and restored across restart — window
      geometry was already covered by `tauri-plugin-window-state` (Phase
      0); `design/useSessionPersistence.ts` adds the rest (open tabs,
      active tab, active project/worktree), persisted to `session.json`
      and restored once the real worktree list has loaded, dropping any
      restored tab whose worktree no longer exists (the "deleted worktree
      that was open" edge case). Scope note: agent tabs restore as an
      empty shell, not a resumed transcript — `agentSessionStore`'s
      transcript is intentionally not persisted (would mean persisting
      potentially large conversation histories to a prefs file), so a
      restored agent tab's next message starts a fresh CLI session rather
      than silently pretending to continue the old one; using the
      explicit Resume Session picker still reaches the real prior session
      via the CLI's own on-disk history
- [x] Quick-open (⌘P, kept distinct from ⌘K's command list) covers files
      across the active worktree only (not every known worktree) — plus a
      full-text search/replace panel (⌘K's "Search" rail item),
      `commands/search.rs`

## Phase 9 — Packaging & release hardening

- [ ] `tauri signer generate` keypair created; public key in
      `tauri.conf.json`, private key stored securely (never committed)
- [ ] `tauri-plugin-updater` verified end-to-end against an **installed**
      AppImage/deb/rpm (not a raw dev build)
- [ ] Updater manifest published alongside release artifacts
- [ ] `.desktop`/icon integration documented (AppImageLauncher or
      first-run self-integration prompt)
- [ ] **NVIDIA/WebKitGTK check**: packaged AppImage tested on at least one
      NVIDIA Linux machine (Phase 0's spike only covered Intel/Mesa);
      `WEBKIT_DISABLE_DMABUF_RENDERER=1` workaround documented if needed
- [ ] Release CI: tag → matrix build (`tauri-action`) → publish → GitHub
      Release
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
      the _same_ worktree concurrently → both see each other's on-disk
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
