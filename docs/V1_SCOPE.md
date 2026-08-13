# Maestro v1 — Scope Lock

This document is the contract for v1. Anything not listed under **In Scope** is
either explicitly deferred (**v2 candidate**) or explicitly rejected
(**Non-goal**). When in doubt during implementation, this file wins over
enthusiasm.

Locked: 2026-08-13. Framework updated to Tauri v2 on 2026-08-13 after a
rendering spike validated Monaco + xterm.js on this project's actual Linux
target (WebKitGTK) — see `ARCHITECTURE.md` header note. Scope is
unaffected; only the implementation stack changed.

## Product one-liner

A cross-platform (Linux-first) Tauri desktop app that gives Claude Code,
Codex CLI, and Cursor Agent a native, VS Code-grade GUI, organized around
git projects and worktrees, so you can run several agents on the same repo
in parallel without them stepping on each other.

## In scope for v1

### 1. Shell & theming

- Frameless custom titlebar, window controls, single-instance app.
- Dark-mode-first. Three baseline themes shipped from the design file
  (Maestro Dark, VS Code Dark+, One Dark Pro) plus a theme JSON schema so
  more can be added without code changes.
- Command palette (⌘/Ctrl-K) for files, symbols-lite (file names only in v1),
  and commands.

### 2. Project & worktree manager (left sidebar)

- "Add project" by pointing at an existing local git repository (no clone-from-URL in v1).
- Tree of projects → branches/worktrees.
- Create worktree (new branch off a ref, or attach to an existing branch).
- Remove/prune worktree (with uncommitted-changes guard).
- Per-project **post-create hooks**: shell script run after a worktree is
  created, with `$NEW_WORKTREE`, `$SOURCE_WORKTREE`, `$BRANCH`,
  `$PROJECT_ROOT` env vars, plus one-click presets (copy `.env*`, run
  detected install command, symlink `node_modules`). Hook stdout/stderr is
  streamed into a small result panel; failures are surfaced, not silent.
- Everything below (explorer, SCM, terminal, agent tabs) is scoped strictly
  to whichever worktree is currently selected.

### 3. Tab-based center pane

- Tabs for: Claude Code, Codex CLI, Cursor Agent, native terminal, file
  editor, markdown preview, diff viewer.
- New-tab menu offers "start fresh" per agent **and** "resume session" listing
  each CLI's own recent sessions for the active worktree.
- Tabs are per-worktree; switching worktrees swaps the tab strip (agent
  processes for background worktrees keep running; see §5).
- Tab state (which tabs, scroll/cursor position for editors, active tab)
  persists across app restarts.

### 4. File explorer & editor

- VS Code-style file tree (expand/collapse, create/rename/delete/move,
  reveal-in-tree, git status glyphs) scoped to the active worktree.
- Files open as tabs in the center pane, rendered with Monaco:
  syntax highlighting, minimap, find/replace, multi-cursor — the baseline
  Monaco feature set, not a full LSP (no go-to-definition/IntelliSense in v1;
  see v2 candidates).
- Markdown files get a Source/Preview toggle matching the design file.
- Unsaved-changes indicator + confirm-on-close/quit.
- External file-change detection (file changed on disk while open →
  reload-or-keep-mine prompt).

### 5. Git integration (SCM view)

- Status list split into Staged / Changes, stage/unstage per file or all,
  commit (with message box), push, pull, fetch, branch indicator with
  ahead/behind counts.
- Diff viewer tab opens Monaco's side-by-side diff editor, VS Code-styled,
  for any changed file; stage/unstage/revert (discard) from the diff tab.
- Commit history view: linear log for the current branch, author/time/hash,
  click a commit to see its diff (read-only).
- Conflict _display_ (a file in a conflicted state is clearly flagged) but
  a full 3-way merge editor is a v2 candidate — v1 lets you drop to the
  native terminal or an editor to resolve, then re-stage normally.

### 6. Agent CLI wrapping (the core of the product)

- Claude Code, Codex CLI, and Cursor Agent each launched in their
  **non-interactive/headless streaming JSON mode** (not a raw PTY) so
  Maestro can render structured, VS Code/Cursor-style tool-call cards
  (Read/Edit/Bash/Grep/etc.), thinking blocks, and diffs — matching the
  design file, not a terminal transcript.
- Bidirectional permission handling: tool-use approval requests from the
  CLI are rendered as an in-UI approve/deny affordance, not auto-approved
  and not blindly skipped via a "dangerously skip permissions" flag by
  default (that remains an explicit, opt-in per-session toggle).
- Session resume: list + resume each CLI's own on-disk sessions for the
  active worktree; Maestro does not invent its own transcript format, it
  indexes what the CLI already persists.
- Composer: model/mode pickers (surfaced only if the underlying CLI
  exposes them via flags — no fake dropdowns for unsupported options),
  @-mention file context, attach files.
- One live agent tab per (worktree, agent) at a time in v1 — running the
  _same_ agent twice in the _same_ worktree concurrently is a non-goal
  (see below); different agents, or the same agent in different worktrees,
  run fully in parallel.
- Pre-flight capability checks: detect CLI not installed, wrong/untested
  version, not logged in — and say so in the UI instead of failing silently
  mid-session.

### 7. Native terminal tab

- Real PTY (node-pty + xterm.js) opened at the worktree's working directory,
  full ANSI/color support, resizable, one per tab, killed cleanly on close.

### 8. Settings

- General, Appearance (theme picker + custom theme JSON import), Agents &
  CLI (binary paths, detected versions, default flags), Worktree Hooks
  (per-project, with a global default), Keybindings (view + rebind the
  built-in map; no plugin/extension system in v1).

### 9. Packaging & distribution

- Tauri's built-in bundler producing: AppImage (Linux, primary
  target/daily-driven platform; deb/rpm also available), dmg (macOS),
  msi/nsis (Windows).
- Auto-update wired via `tauri-plugin-updater` (minisign-signed artifacts)
  for AppImage/deb/rpm; mac/Windows auto-update scaffolding present but
  code-signing for those platforms is explicitly **not** blocking v1 (see
  non-goals). The Linux target must additionally be verified on NVIDIA
  hardware, not just the Intel machine the initial rendering spike used —
  see `ARCHITECTURE.md` §9.

## v2 candidates (deliberately deferred, not forgotten)

- Full LSP integration in Monaco (go-to-definition, hover, diagnostics).
- Three-way merge conflict editor.
- Multiple concurrent sessions of the _same_ agent in the _same_ worktree
  (tab-per-session fan-out).
- Clone-from-URL project onboarding; remote/SSH worktrees.
- Plugin/extension system; custom keybinding _scripting_ beyond remapping.
- Sandboxed/containerized agent execution (Docker/VM isolation per worktree).
- Telemetry/analytics dashboards beyond local crash logs.
- Team features: shared sessions, comments, PR review UI beyond opening the
  browser.
- In-app terminal split panes / multiple terminals per tab.
- Symbol/full-text code search beyond filename fuzzy-match.
- Full code-signing + notarization pipeline for macOS/Windows.

## Non-goals (rejected for the product, not just v1)

- Re-implementing an LLM agent loop ourselves — Maestro only ever wraps the
  official CLIs; it never talks to model APIs directly.
- Becoming a general-purpose IDE for non-agentic editing — the file
  editor exists to support the agent workflow (review, tweak, resolve),
  not to compete with a daily-driver editor's full feature set.
- Cloud-hosted/multiplayer sessions in v1's architecture.

## Definition of done for v1

A single user can: add a project → create a worktree → run a post-create
hook → open Claude Code, Codex, and Cursor Agent tabs against it (each
resumable across restarts) → review and stage/commit/push a diff produced
by an agent → do all of the above again in a second worktree of the same
project at the same time without cross-talk → and do it all from a signed(-ish),
auto-updating AppImage that survives a killed agent process, a killed app,
and a machine reboot without corrupting worktree or session state.
