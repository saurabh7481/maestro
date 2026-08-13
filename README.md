# Maestro

A cross-platform (Linux-first) Electron GUI that wraps Claude Code, Codex
CLI, and Cursor Agent with a native, VS Code-grade agentic development
environment — projects and git worktrees on the left, a tab-based agent /
editor / terminal workspace in the center.

Inspired by [Conductor](https://conductor.build), built around your own
design system and theming.

## Status

Pre-implementation. v1 scope is locked; no application code has been
written yet. Start here:

1. [`docs/V1_SCOPE.md`](./docs/V1_SCOPE.md) — what v1 is and isn't.
2. [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md) — tech stack, process
   model, and the researched protocol details for wrapping each agent CLI.
3. [`docs/ROADMAP.md`](./docs/ROADMAP.md) — phased build plan and sequencing.
4. [`docs/CHECKLIST.md`](./docs/CHECKLIST.md) — actionable checklist,
   including a dedicated edge-case sweep.
5. [`docs/design/`](./docs/design/) — the baseline visual design system
   (`Maestro IDE.dc.html` + `support.js`): layout, spacing, component shape,
   and the three baseline themes (Maestro Dark, VS Code Dark+, One Dark
   Pro). This is the source of truth for v1's look — port it, don't
   redesign it.

## Core idea

- **Projects & worktrees** (left sidebar): point Maestro at a local git
  repo; create isolated `git worktree`s so multiple agents can work the
  same repo in parallel without colliding.
- **Tab-based center pane**: each tab is a Claude Code session, a Codex
  session, a Cursor Agent session, a native terminal, an open file, or a
  diff — all scoped to whichever worktree is currently active.
- **VS Code-fidelity everything else**: file tree, Monaco-powered editor
  and diff viewer, source control panel, commit history — strictly
  attached to the active worktree/branch.
- **Worktree hooks**: custom shell scripts (with presets) that run after a
  worktree is created — copy env files, install deps, whatever your repo
  needs.

## License

TBD.
