# Maestro v2 — Roadmap

v1 (`ROADMAP.md`, `V1_SCOPE.md`) proved the core bet: three agent CLIs
wrapped through one normalized adapter, organized around git worktrees,
in a VS Code-fidelity shell. Everything below assumes that foundation is
solid and asks the next question — what makes Maestro worth reaching for
over the CLI directly, or over VS Code + a terminal tab running the same
CLI?

Two answers recur across the phases below: **Maestro sees things the bare
CLI can't** (which worktree, which file, which language symbol, which
git state), and **Maestro can do things across worktrees that a single
terminal can't** (parallel agent runs, unattended background runs,
aggregated cost). Phases are ordered so a quick correctness fix (session
resume, currently living in the wrong place in the UI) closes out first;
then the highest-leverage, most on-brand work (closing the "doesn't feel
like a real IDE yet" gap, deepening the agent-CLI wrapping) follows; the
most ambitious item (an autonomous task queue for unattended agent runs)
is last, as a capstone that composes everything built along the way
rather than a day-one commitment.

Each phase lists a goal, concrete scope, and exit criteria, same as
`ROADMAP.md`. Sequencing notes call out real dependencies; phases without
a noted dependency are parallelizable the same way v1's Phase 3/4 and
Phase 5/7 were.

## Why these, not others

Considered and deliberately **not** included, with reasons:

- **Plugin/extension marketplace** — a real plugin system (arbitrary
  third-party code, sandboxing, versioning, a registry) is a multi-month
  project on its own and doesn't compound with anything else here. If
  demand shows up, start with something much smaller: a config-driven way
  to add custom command-palette entries and worktree-hook presets (this
  is a natural extension of Phase 15 below, not a separate phase).
- **Debugger integration (DAP)** — high implementation cost (per-language
  adapter config, breakpoint UI, variable inspection) for a tool whose
  primary workflow is agent-driven edits, not step-through debugging.
  Revisit only if user research says otherwise.
- **Mobile/voice companion** — out of scope for a desktop ADE; no signal
  this is what users of a git-worktree-centric tool want.
- **Vim/modal editing mode** — genuinely useful to a vocal subset of
  users, but Monaco's vim-mode extension is a well-known, low-risk
  integration (days, not weeks) whenever it's prioritized — not
  substantial enough to earn its own phase; fold it into Phase 13 as a
  settings toggle if picked up.
- **Same-task fan-out across agents/worktrees** — running one prompt
  across N agents or N worktrees simultaneously for comparison sounds
  appealing but doesn't earn capstone status: it's a narrower,
  harder-to-land version of Phase 19's job queue (N-way live comparison
  UI vs. N independent unattended jobs reviewed on your own time), and
  the queue delivers more day-to-day throughput for the same
  architectural investment.

## Phase 10 — In-tab session resume (starting point)

**Goal:** fix a v1 design mistake before building further UI on top of
it — resuming a session is a per-tab, per-agent action fed by that
agent's own session store, not a decision made in the tab-strip's `+`
menu before a tab even exists.

- Remove `NewTabMenu.tsx`'s "Resume session" section and its "Search all
  projects" checkbox entirely — the `+` menu goes back to offering only
  "start fresh" per agent (Claude Code, Codex, Cursor Agent).
- Inside each agent tab, add a "Sessions" affordance that lists every
  session for that specific agent, reusing the same on-disk scan its own
  CLI already relies on for commands like `cursor-agent ls`
  (`sessions.rs`'s `list_claude_sessions`/`list_cursor_sessions`, plus a
  Codex equivalent once its on-disk layout is confirmed) — rendered
  natively in the tab instead of shelling out to an interactive TUI.
- Picking a session from that in-tab list resumes it in place (hydrate
  via the existing `get_session_transcript`) — no new tab opens, you
  never leave the tab you're in.
- No settings toggle, no project/global scope distinction to build or
  maintain: the list is simply every session that agent's own store
  knows about, using the title/branch/last-active/turn-count metadata
  the current picker already renders to tell sessions apart.

**Exit criteria:** open a fresh Cursor Agent tab, open its Sessions list,
see every on-disk Cursor session regardless of which worktree it came
from, resume one, confirm the transcript hydrates correctly and further
turns append to that same session rather than starting a new one.

## Phase 11 — Language intelligence (LSP)

**Goal:** Monaco stops being "a text editor with syntax highlighting" and
starts being a real code-intelligence surface — go-to-definition,
find-references, hover docs, inline diagnostics, real autocomplete. This
is the single biggest remaining gap between Maestro and "a real IDE,"
and it's well-trodden ground (VS Code, Zed, and every Monaco-based tool
solve it the same way), which makes it the highest-confidence, highest-
value item to build first.

- Wire `monaco-languageclient` (or a lighter hand-rolled JSON-RPC bridge,
  evaluate both against Tauri's IPC model before committing) between
  Monaco and a per-worktree language server process, spawned and
  lifecycle-managed the same way `terminal.rs`/`agents/manager.rs`
  already manage other long-lived child processes.
- Ship first-class support for the servers Maestro's own stack already
  needs to dogfood: `typescript-language-server`, `rust-analyzer` — then
  generalize to a small config-driven table (extension → server command)
  covering `pyright`/`gopls` so it's not hardcoded to two languages.
- Detect-or-prompt: if a matching server binary isn't found, degrade to
  today's syntax-only Monaco rather than blocking the file from opening
  (same "clear state, no dead end" principle as v1's CLI-not-installed
  handling).
- One LSP process per (worktree, language) pair, not per open file —
  reuse `explorerStore`'s existing per-worktree lifecycle hook as the
  model for start/stop.
- Diagnostics surfaced in three places already wired for exactly this:
  the file tree (a red/yellow dot, same slot `git status` glyphs use),
  the tab bar, and a Problems panel (new, modeled on the existing
  Search panel's list UI).

**Exit criteria:** open a TypeScript and a Rust file in the same
worktree, get working go-to-definition/hover/autocomplete/diagnostics in
both, confirm the LSP process is killed when its worktree closes (no
orphaned `rust-analyzer` processes after quitting, checked the same way
Phase 7's terminal-kill criteria was).

## Phase 12 — MCP & agent configuration management

**Goal:** lean further into "GUI for the CLIs you already trust" — right
now Maestro reads each CLI's config (`~/.cursor/cli-config.json`,
`~/.claude/...`) but never helps a user _edit_ it. MCP servers,
subagents, and project instruction files (`CLAUDE.md`, `.cursor/rules`,
`AGENTS.md`) are exactly the kind of config a GUI is better at than
hand-editing JSON.

- MCP server manager: list configured servers per CLI, add/remove/edit
  (command, args, env), test-connect, surfaced from Settings → Agents &
  CLI (already the home for CLI-level config) rather than a new top-level
  section.
- Project instruction file editor: detect and edit `CLAUDE.md`/
  `.cursor/rules`/`AGENTS.md` in the active worktree with the same Monaco
  pane used for any other file, plus a "create from template" action for
  worktrees that don't have one yet.
- Subagent manager (Claude Code's `.claude/agents/*.md` definitions):
  list, create from template, edit — same treatment as hooks got in v1's
  Phase 2 (presets + custom editor).
- Respect each CLI's config ownership boundary the same way v1's Cursor
  permission-model note already establishes: **write** to files that are
  unambiguously project-scoped (`CLAUDE.md`, `.claude/agents/`); for
  genuinely global/shared files (`~/.cursor/cli-config.json`), offer a
  read-only view with an "open in $EDITOR" affordance rather than
  Maestro silently rewriting a file the user's other tools also depend
  on — the same reasoning that already kept v1 from touching that file.

**Exit criteria:** add an MCP server through the GUI, start a fresh agent
tab, confirm the server actually appears in that CLI's own `/mcp` output;
edit a `CLAUDE.md` through Maestro and confirm a CLI run in a plain
terminal against the same worktree picks up the change.

## Phase 13 — Multi-pane & multi-window layout

**Goal:** the tab strip stops being the only way to see two things at
once. Comparing a diff against the file it came from, or watching an
agent work while editing a different file, currently means tab-switching
back and forth.

- Split the editor region horizontally/vertically (drag a tab to an
  edge, or a command-palette action); each pane keeps its own tab strip,
  sharing the rest of the shell (sidebar, titlebar, status bar).
- Detach a tab into a real second OS window via Tauri's multi-webview-
  window support — most valuable for agent tabs (watch an agent work on
  a second monitor while editing in the main window) and terminals.
- Persist pane/window layout the same way Phase 8 persisted tabs
  (`design/useSessionPersistence.ts` is the natural place to extend,
  not a parallel mechanism).
- Vim-mode toggle (Monaco's existing vim extension) rides along here as
  a small Settings addition, per the "Why these, not others" note above.

**Sequencing note:** depends on Phase 8's tab-persistence groundwork
(v1) being solid, since layout state is tab state's superset — no
dependency on Phases 11/12.

**Exit criteria:** split the editor, open different files in each pane,
detach an agent tab to its own window, restart the app, confirm the
layout (panes + detached window) restores.

## Phase 14 — Task runner

**Goal:** a first-class way to run and re-run project commands (`pnpm
test`, `cargo build`, a custom script) without hand-typing them into a
terminal tab every time, building directly on Phase 7's PTY
infrastructure rather than a parallel execution path.

- `.maestro/tasks.json` per project (or a Settings-driven equivalent):
  named tasks with a command, cwd, and optional problem matcher (regex →
  file/line/severity, VS Code's `tasks.json` format is a reasonable
  starting schema rather than inventing a new one).
- Tasks panel: run/re-run/stop, live output (reusing the terminal
  rendering path — a task is really just a PTY run with structured
  output parsing layered on top, not a new execution primitive).
- Matched problems feed the same Problems panel Phase 11 introduces —
  one place for "things that are wrong," whether from a language server
  or a failed test run.
- Auto-detected default tasks from lockfile sniffing, reusing
  `git::detect_install_command`'s existing pattern (same idea, applied to
  `test`/`build`/`lint` scripts instead of just install).

**Sequencing note:** benefits from Phase 11's Problems panel existing
first, but can ship its own minimal output view if built earlier —
not a hard dependency.

**Exit criteria:** define a task, run it, see live output and (for a
task with a matcher) clickable problem entries that jump to the right
file/line; re-run and cancel both work correctly.

## Phase 15 — Operational visibility tabs

**Goal:** give the user the same visibility into running state that
Maestro's own lifecycle code already has internally, via new tab types
beyond agent/terminal/editor — all reusing existing process/worktree/git
plumbing rather than opening new architecture.

- **Process Manager tab** (core): one view of every process Maestro has
  spawned across all worktrees/projects — agent CLI processes, PTY
  terminals, hook scripts, and (once Phase 11/14 land) LSP servers and
  tasks. Columns: worktree, kind, PID, uptime, CPU/mem, status; actions:
  tail live output, kill, restart. Directly closes the orphaned-process
  class of issue the v1 checklist worries about at every phase (Phase
  5–9) by surfacing the bookkeeping Maestro's process-lifecycle code
  already does internally, instead of leaving it invisible.
- **Worktree Dashboard tab** (core): one tab per project — a grid of all
  its worktrees showing git ahead/behind, dirty/clean, which agents are
  currently running and their last activity, last commit; click a cell
  to jump into that worktree. Answers "what's happening across my
  worktrees right now" without clicking through each one — the concrete
  version of this doc's "Maestro sees things the bare CLI can't" thesis.
- **Activity/audit timeline tab** (fold-in): reverse-chronological feed
  of what agents did project-wide (tool calls, edits, commits, hook
  runs), filterable by worktree/agent — useful for reviewing
  agent-authored work before merging, or catching up after being away.
- **Web preview tab** (fold-in): embedded webview on a local dev server
  URL, dockable beside the editor; auto-opens once Phase 14's task
  runner can match a "server started" pattern in task output.

**Exit criteria:** kill a hook script mid-run from the Process Manager
tab and confirm the underlying OS process actually dies; open the
Worktree Dashboard for a project with 3+ worktrees and correctly see
which ones have a running agent without opening any of them.

## Phase 16 — Cost & activity insights

**Goal:** every agent turn already reports `totalCostUsd` and
`durationMs` (v1 Phase 5); this phase is almost entirely about
surfacing data already being collected, not collecting new data — low
implementation risk, direct value for anyone paying per-token.

- Persist per-turn cost/duration (currently held only in
  `agentSessionStore`'s in-memory `lastResult`, lost on tab close) to
  SQLite, keyed by worktree/project/agent kind.
- A spend dashboard: cost over time, broken down by project/worktree/
  agent kind — a new Settings pane or a dedicated panel, reusing the
  existing per-project aggregation patterns from the worktree sidebar's
  ahead/behind counts.
- Notification history: Phase 8 (v1) shipped ephemeral toasts; this
  phase adds a persistent log behind a bell icon in the titlebar so a
  toast missed while away from the machine isn't gone for good —
  natural extension of `state/toastStore.ts`, not a new system.
- Optional per-project/per-worktree budget alerts (toast when a session's
  running cost crosses a user-set threshold) — reuses the toast system
  again rather than inventing a new alert mechanism.

**Exit criteria:** run a real multi-turn session, confirm its cost is
queryable after the tab is closed and the app restarted; open the
notification history and find a toast that already auto-dismissed from
view.

## Phase 17 — Additional agent CLI adapters

**Goal:** generalize the adapter abstraction a second time (v1 Phase 6
was the first), now against CLIs with genuinely different shapes than
Claude/Cursor/Codex, to pressure-test that the abstraction is actually
general and not just "general enough for three CLIs that happen to be
similar."

- Candidates, evaluated in this order (most similar to already-supported
  shapes first, to bank confidence before the harder ones): Gemini CLI,
  Amp, OpenCode, Aider.
- Same rigor v1 demanded: no adapter ships without a live capability
  probe against the real installed binary, real captured event-shape
  fixtures, and an honest module-doc note for anything unverified —
  copy Phase 5/6's methodology exactly rather than relaxing it now that
  the pattern is familiar.
- If any candidate's event model doesn't fit the current
  `AgentEvent`/`ToolCallCard` normalization, that's a signal to widen the
  shared shape (same principle v1's Phase 6 note states: "if per-CLI
  differences leak into a component, the abstraction was wrong — fix the
  interface, not the component").

**Exit criteria:** at least one new adapter reaches the same parity bar
v1's Phase 5/6 exit criteria set (real multi-turn session, resume across
restart, permission handling if the CLI has one).

## Phase 18 — Diff, merge & history power features

**Goal:** v1's git integration covers the common path well; this phase
covers what a team actually hits in practice — real conflicts, blame,
stash — which v1 explicitly deferred (`CHECKLIST.md`'s edge cases:
"conflicted file state visibly flagged" was as far as v1 went).

- Merge conflict resolution UI: a real 3-way view (ours/theirs/result)
  in the existing Monaco diff tab infrastructure, not a new editor
  surface — accept-ours/accept-theirs/edit-manually per hunk.
- `git blame` inline (toggle in the editor gutter) and a blame-aware
  "who last touched this line" hover, both read-only and low-risk.
- Stash management: list, apply, pop, drop — from the SCM panel, next to
  the existing commit/push/pull actions.
- Interactive rebase UI is explicitly **not** in this phase's scope —
  genuinely high-risk (destructive, easy to get wrong in a GUI), and the
  existing terminal tab is a perfectly good escape hatch for it; revisit
  only if conflict-resolution UI usage data says it's worth the risk.

**Exit criteria:** create a real merge conflict, resolve it entirely
through the GUI, confirm the resulting commit matches what resolving it
by hand in a terminal would have produced; stash and re-apply changes
without data loss.

## Phase 19 — Autonomous task queue / background agent runs (capstone)

**Goal:** the most ambitious item on this roadmap, placed last
deliberately — a queue of agent jobs that run unattended, instead of
live in a tab you're watching turn-by-turn. This is "Maestro can do
things across worktrees that a single terminal can't" pushed from
_simultaneous_ to _unattended-over-time_: a real throughput multiplier,
built entirely out of primitives the rest of this roadmap already
lands, rather than a new deployment model.

- A queue of jobs: each job pairs an agent + prompt with a target — an
  existing worktree, or "create a fresh worktree off ref X," reusing
  v1 Phase 2's worktree creation directly.
- Jobs run through the existing adapter layer (v1 Phase 5/6) exactly as
  a live tab does, just without a human watching turn-by-turn; a tool
  call needing approval pauses that job into a "needs attention" state
  instead of blocking forever or auto-approving silently.
- A Job Queue tab: pending/running/needs-attention/completed, surfaced
  next to Phase 15's Process Manager, since a running job is,
  mechanically, just another Maestro-spawned process.
- Review flow reuses the existing diff viewer (v1 Phase 4): open a
  completed job's diff, accept (commit, optionally open a PR) or discard
  (worktree cleanup in one action) per job.
- Completion/needs-attention states feed Phase 16's notification history
  rather than inventing a separate alert mechanism.

**Exit criteria:** queue 3 independent jobs against a real repo, walk
away, come back to find them completed or paused for approval; review
and accept one job through the diff viewer, discard another and confirm
its worktree is actually gone from disk.

## Rough sequencing at a glance

```
10 In-tab session resume (starting point, fixes a v1 mistake)
   │
11 Language intelligence (LSP)         12 MCP & agent config
   │                                       │
   │         (parallelizable — both build on v1's stable core,
   │          neither depends on the other)
   │                                       │
   └────────────────┬──────────────────────┘
                     │
   13 Multi-pane/window layout      14 Task runner
        │                                │
        │        (parallelizable)        │
        │                                │
        └───────────────┬────────────────┘
                         │
   15 Operational visibility tabs   16 Cost & activity insights   17 More agent CLIs
        │                          │                             │
        └──────────┬───────────────┴─────────────┬───────────────┘
                    │        (all three parallelizable —
                    │         independent of each other)
                    │
        18 Diff/merge/history power features
                    │
        19 Autonomous task queue / background agent runs (capstone)
```

</content>
