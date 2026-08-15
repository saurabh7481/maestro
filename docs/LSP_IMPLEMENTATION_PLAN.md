# Maestro v2 — LSP implementation plan

Status: design/research complete; no implementation started.  
Scope: Phase 11 language intelligence, with the shared Problems model needed by Phase 14's task runner.

## 1. Outcomes and non-goals

Maestro will provide hover, completion, signature help, go-to-definition,
references, document symbols, rename, code actions, formatting, semantic tokens,
inlay hints, and diagnostics when the selected server advertises them. Every
feature is capability-gated; unsupported features remain absent rather than
failing or presenting a fake action.

The first supported adapters are:

| Language family       | File/project detection                                | Default command                      |
| --------------------- | ----------------------------------------------------- | ------------------------------------ |
| TypeScript/JavaScript | `tsconfig.json`, `jsconfig.json`, or JS/TS files      | `typescript-language-server --stdio` |
| Rust                  | `Cargo.toml` or `.rs` files                           | `rust-analyzer`                      |
| Python                | `pyproject.toml`, `requirements*.txt`, or `.py` files | `pyright-langserver --stdio`         |
| Go                    | `go.work`, `go.mod`, or `.go` files                   | `gopls`                              |

Initial release quality is judged on TypeScript and Rust (Maestro dogfooding);
Python and Go validate that the registry is genuinely data-driven.

Not in the first release: downloading executables without consent, container/
SSH execution, an extension marketplace, DAP, or pretending LSP diagnostics are
a complete build. The task runner remains the authority for compiler, lint, and
test problems that a server does not publish.

## 2. Core architecture decision

**Spike result (implemented):** use the lightweight `vscode-jsonrpc` connection
over a custom Tauri transport and explicit Monaco providers. The current
`monaco-languageclient` release pulls the full Codingame/VS Code service-
override stack; Maestro does not need that compatibility layer for its existing
standalone Monaco architecture. Do not add a localhost WebSocket server merely
to bridge the webview to Rust.

```text
Monaco model / providers
        │
vscode-jsonrpc + Maestro Monaco adapters
        │ ordered Tauri Channel down / invoke write up
Rust LspManager (process, framing, limits, restart, logs)
        │ Content-Length framed stdio
language server process, cwd = worktree root
```

Why this split:

- The existing architecture correctly keeps child processes in Rust. It gives
  Maestro reliable cleanup, PIDs, stderr capture, and future Process Manager
  integration.
- `monaco-languageclient` avoids hand-implementing dozens of providers and LSP
  capability/dynamic-registration rules.
- Tauri Channels are intended for fast, ordered streams, including child output
  and WebSocket-like traffic. Ordinary global events are not appropriate for a
  high-volume protocol stream.
- A custom `MessageReader` consumes the Rust-to-webview channel. A custom
  `MessageWriter` calls one `lsp_send` command. Writes enter a bounded per-server
  Tokio queue; the command must not write directly to child stdin concurrently.

Before committing the dependency, build a time-boxed spike proving initialize,
hover, completion, diagnostics, restart, and clean shutdown with current
`monaco-editor` 0.56. Record the exact compatible package versions in the
lockfile. If classic mode requires the heavyweight VS Code service override
stack or cannot use a custom transport cleanly, retain the Rust manager and
replace only the frontend layer with explicit Monaco providers for the MVP
feature set. Do not switch to a localhost socket as a shortcut.

## 3. Identity, roots, and URIs

The durable server key is `(worktree_id, adapter_id)`. Never key by branch name,
display name, PID, tab id, or raw relative path.

Each process starts with:

- `cwd`: canonical worktree root;
- `rootUri`: that same root encoded as an RFC 8089 `file://` URI;
- `workspaceFolders`: one folder for the worktree (when supported);
- `processId`: Maestro's Rust process ID;
- `clientInfo`: Maestro name/version;
- a conservative client capability set matching only implemented UI behavior.

The current Monaco URI (`maestro-file:///<tab-id>`) must change. LSP-backed
models need a canonical absolute `file://` URI. The model registry remains
keyed by tab id internally, but constructs the URI from
`worktreeRoot + safe relative path`. This fixes cross-file definitions,
diagnostics, edits, Windows drive letters, spaces, Unicode paths, and symlinks.

Path rules:

- Canonicalize the worktree root once, but do not canonicalize a non-existent
  new file.
- Normalize only for identity/comparison; preserve server-returned URI spelling
  where possible.
- Compare Windows paths case-insensitively and normalize drive-letter case.
- Reject any URI/edit outside the worktree by default. Offer an explicit prompt
  before opening an external dependency file; never allow a workspace edit to
  write outside the worktree silently.
- Translate LSP positions as UTF-16 code units (Monaco's convention), not Rust
  byte offsets. Clamp malformed server ranges instead of crashing the renderer.

One process per worktree/language is the default. A future adapter may declare
`multi_root: true`, but unrelated worktrees must never share a server: their
dependency installs, build output, environment, and uncommitted contents differ.
Nested project roots initially stay in one worktree server unless a specific
adapter requires per-root processes; root selection must be adapter-owned and
covered by fixtures for monorepos.

## 4. Server registry and configuration

Create a typed built-in registry, not scattered extension conditionals:

```text
adapter id, display name, language IDs, extensions, project markers,
command candidates, args, version probe, install guidance,
initialization options, default settings, environment policy,
restart policy, workspace-diagnostic support notes
```

Settings are stored in SQLite. Suggested keys/tables:

```sql
-- global default, defaults true
settings['lsp.enabled'] = true

CREATE TABLE project_lsp_settings (
  project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  enabled_override INTEGER NULL, -- NULL inherits; 0 off; 1 on
  config_json TEXT NOT NULL DEFAULT '{}'
);

-- global per-adapter command/config overrides can remain in `settings`
-- under lsp.server.<adapter>.{command,args,env,settings}.
```

Effective enablement is exactly:

```text
project override true/false if present, otherwise global lsp.enabled
```

Use a tri-state project control: **Inherit global**, **Enabled**, **Disabled**.
A two-state switch plus “override enabled” checkbox is harder to understand.
Global Settings → Language Intelligence contains the global toggle and server
cards. Project Settings → Language Intelligence shows the tri-state override,
its resolved value, and project-specific adapter configuration. Changing the
effective value takes effect immediately: enabling detects/starts needed
servers; disabling cancels requests, clears that worktree's LSP diagnostics and
markers, sends graceful shutdown, then kills after a deadline.

Config precedence:

```text
built-in adapter defaults
  < global adapter overrides
  < project adapter overrides
```

Arrays replace rather than merge. Environment maps merge by key. Validate and
version `config_json`; invalid entries are reported and the last valid config is
retained. Never execute a repo-controlled command automatically in v2. Project
configuration may tune a known adapter, but adding an arbitrary executable is a
trusted-user Settings action, not something read from a checkout.

## 5. Detection, absence, and installation

Detection is centralized in Rust and cached, following `agents/registry.rs`:

1. Resolve an explicit configured absolute path if present.
2. Resolve built-in command candidates against the GUI process environment.
3. Also probe common toolchain locations that desktop GUI apps often miss
   (`~/.cargo/bin`, rustup proxy/toolchain, npm/pnpm global bin locations,
   Go bin); show where the binary was found. Do not silently mutate `PATH`.
4. Run a server-specific, non-interactive version probe with a 5–10 second
   timeout, captured stderr, output-size cap, and no network.
5. Classify the result as `ready`, `missing`, `not executable`, `probe timed
out`, `incompatible`, or `dependency missing` rather than one boolean.
6. Cache by adapter + resolved command + relevant environment hash. Recheck at
   app start, on Settings “Recheck”, after installation, and after spawn returns
   `NotFound`; do not probe per editor mount.

Presence does not mean health. The first initialize handshake is the definitive
health check. Surface spawn errors, immediate exit, malformed framing, and
initialize timeout separately.

Installation UX:

- Missing server never blocks opening/editing/saving a file. Monaco falls back
  to its existing syntax services and shows a non-modal status item.
- Server cards contain copied, platform-aware official installation commands
  and an editable binary path.
- “Install” is an explicit user action with the exact command, destination,
  network/toolchain implications, live task-style output, cancel support, and a
  final version recheck. It must never run merely because a file was opened.
- Prefer ecosystem ownership: `rustup component add rust-analyzer`, global npm
  install for TypeScript server + TypeScript, documented Pyright mechanism, and
  `go install .../gopls@latest`. A later managed-download mode must verify
  checksums/signatures, pin versions, use atomic rename, and support rollback.
- TypeScript must prefer the workspace's `typescript` SDK when compatible, so
  project semantics match its lockfile. Report which TypeScript version/source
  is active.
- In sandbox/package formats, report host/sandbox visibility explicitly rather
  than claiming the server is absent.

## 6. Lifecycle and state machine

Each server has an explicit state:

```text
disabled → detecting → missing | starting → initializing → ready
                                      ↘ failed / crashed / restarting
ready → stopping → stopped
```

Every transition carries a generation number. Async results from an older
generation (worktree switch, toggle, restart) are ignored. `start` and `stop`
are idempotent and serialized per key.

Start lazily when all are true: effective setting enabled, a supported file is
opened (or the Problems view explicitly requests workspace diagnostics), and a
matching server is ready. Do not start every installed server merely because a
worktree contains a matching extension.

Keep servers alive while their worktree has open LSP-backed models or is the
active worktree. When neither is true, start a configurable idle timer (default
five minutes), then shut down. Worktree removal, project removal, disabling,
and app quit stop immediately. Switching worktrees need not throw away a warm
server immediately, but apply a global memory/process cap (initially four LSP
processes); evict least-recently-used idle servers first. Never evict a server
with an in-flight workspace edit.

Shutdown sequence: stop accepting requests → cancel outstanding requests →
send `shutdown` request with deadline → send `exit` notification → close stdin
→ wait briefly → terminate process tree → hard kill after grace period → await
stdout/stderr reader tasks. On Unix use a process group; on Windows use a Job
Object so child processes such as `tsserver` cannot orphan. Also execute this
from Tauri's application-exit hook, not only React cleanup.

Crash policy: retain the last diagnostics but mark them stale; restart with
exponential backoff (1s, 2s, 5s, 15s, capped), maximum three crashes in five
minutes. Reset the budget after sustained health. Never restart after an
intentional stop. A user action can reset a tripped circuit breaker. Log the
last bounded stderr and exit code.

Protocol safety: enforce maximum header/message size, strict `Content-Length`
framing, valid UTF-8/JSON, request timeout by method, bounded outbound queue,
unique monotonically increasing request IDs, response correlation, and
`$/cancelRequest`. Unknown notifications are logged at debug level and ignored;
unknown requests receive MethodNotFound. Server `window/showMessage`,
`window/logMessage`, `window/workDoneProgress`, `workspace/configuration`,
`client/registerCapability`, and `workspace/applyEdit` require real handlers.

## 7. Worktree indexing and file changes

Maestro does **not** scan/read/send the entire file tree to the language server.
During `initialize`, it provides the worktree root. The server discovers and
indexes its project from `Cargo.toml`, `tsconfig.json`, `go.mod`, imports, and
other language-specific configuration. Only open buffers are sent through
`didOpen`/`didChange`.

Document synchronization:

- Send `didOpen` once per model with language id, URI, version, and full text.
- Honor the server's negotiated `textDocumentSync` kind. Coalesce rapid changes
  (roughly 50 ms) while preserving monotonically increasing versions. Full-sync
  fallback is acceptable initially; incremental sync is preferred for large
  buffers.
- Send `didSave` according to capability, including text only if requested.
- Send `didClose` before model disposal/server detach.
- LSP is fed the in-memory buffer, so diagnostics reflect unsaved edits.

Filesystem synchronization:

- Extend the existing one-per-active-worktree native watcher rather than add a
  second recursive watcher. Fan its normalized create/change/delete/rename
  events to Explorer, SCM, and the LSP manager.
- Honor dynamic `workspace/didChangeWatchedFiles` registrations and glob
  patterns. Filter before forwarding; batch/debounce bursts; preserve create vs
  change vs delete. The current watcher event type loses that distinction and
  therefore must be enriched.
- Support `workspace/didCreateFiles`, `didRenameFiles`, and `didDeleteFiles`
  when advertised, especially for Explorer operations. Do not send duplicate
  semantic operations plus raw watcher echoes; correlate Maestro-originated
  mutations for a short suppression window.
- `.git`, dependency caches, and build output stay ignored unless a server
  explicitly registers a needed path. Watcher overflow/error triggers a visible
  degraded state and a server restart/rescan, not silent stale intelligence.
- Atomic saves, case-only renames, symlink loops, deleted-open files, generated
  file storms, and a worktree disappearing underneath the process need tests.

“Scan whole worktree” has two meanings:

1. **Index/navigation:** the language server owns this after receiving the root;
   expose server progress and “Indexing…” state.
2. **All problems:** request `workspace/diagnostic` only when the server
   advertises it, using result IDs for unchanged reports and cancellation. Many
   servers use push diagnostics or only guarantee open-file diagnostics. Never
   force coverage by opening every file. Run the task runner's build/typecheck/
   lint tasks for authoritative repository-wide errors.

## 8. Diagnostics and the shared Problems service

Build the Problems service as a source-agnostic backend/frontend contract in
Phase 11 so Phase 14 plugs into it without rewriting UI.

```text
Problem {
  id, worktreeId, sourceKind: 'lsp' | 'task', sourceId, ownerRunId?,
  uri, relativePath?, range, severity, code?, message, relatedInformation?,
  tags?, observedDocumentVersion?, timestamp, stale
}
```

Storage rules:

- LSP publish diagnostics replace the prior set for `(server, URI)`; an empty
  publish clears it. Ignore diagnostics for an older open-document version.
- Pull diagnostics honor `full`, `unchanged`, and related-document reports.
- Task problems belong to one task run. Starting a new run clears that task's
  prior run (configurable later); stopping a run marks incomplete results, not
  LSP data, stale.
- Deduplicate only within the same source/run using a stable fingerprint. Do
  not merge an LSP error with a compiler error just because text/range match.
- Remove LSP data on clean shutdown/disable; mark it stale on crash or watcher
  overflow until a successful republish. Never show old worktree diagnostics
  under a new worktree just because relative paths match.
- Bound retained results per source/worktree and truncate with an explicit UI
  notice rather than exhausting memory.

Presentation:

- Monaco markers use an owner such as `maestro-lsp:<server-key>`, allowing
  surgical replacement/removal without disturbing Monaco's built-in markers.
- Problems panel groups by worktree (when showing all), then file, then source;
  filters severity/source/text; sorts error before warning and by path/range;
  virtualizes large lists; and exposes counts plus stale/running state.
- Clicking a problem selects its worktree, opens the file, waits for the model,
  then reveals the exact range. Missing/deleted/external files show an
  actionable state instead of opening a broken tab.
- Explorer aggregates the highest severity and counts from descendants. Tab
  badges use exact-file counts. Status bar shows worktree error/warning totals
  and indexing/restarting/missing-server state.
- Related information is expandable and clickable. Codes link only after URL
  scheme validation. Diagnostic markdown is rendered as untrusted content.

## 9. Workspace edits and trust boundary

Completion text edits, code actions, rename, and formatting can modify several
files. Route every `workspace/applyEdit` through one Rust-validated transaction:

1. Validate all URIs are in the same authorized worktree; reject unsupported
   schemes and overlapping/malformed edits.
2. Verify optional document versions and current disk mtimes.
3. Convert UTF-16 ranges safely and stage all new contents in memory.
4. For destructive or multi-file edits, show a preview/confirmation initially.
5. Write atomically, record enough data for one undo operation, then update open
   Monaco models without double-applying watcher echoes.
6. Return an honest `ApplyWorkspaceEditResponse` with failure reason/index.

Never execute a server-provided command in a shell. `workspace/executeCommand`
is an LSP request back to the already-selected server; unknown editor commands
returned in code lenses/actions are disabled until Maestro explicitly maps
them. Sanitize hover markdown and command/link URIs.

## 10. API/module layout

Rust:

```text
src-tauri/src/lsp/
  mod.rs, manager.rs, process.rs, framing.rs, registry.rs,
  detection.rs, settings.rs, paths.rs, diagnostics.rs
src-tauri/src/commands/lsp.rs
```

`AppState` gains `lsp_servers`, keyed by `(worktree_id, adapter_id)`, and a
shared Problems repository or event publisher. Public commands: list/detect
servers, read/write global and project settings, start/connect, send, stop,
restart, request workspace diagnostics, retrieve logs/status. Prefer one
connection command returning a Tauri Channel over one global event per message.

Frontend:

```text
src/api/lsp.ts, lspEvents.ts
src/types/lsp.ts, problem.ts
src/lsp/clientManager.ts, transport.ts, adapters.ts, uri.ts
src/state/lspStore.ts, problemsStore.ts
src/components/problems/*
src/components/settings/LanguageIntelligencePane.tsx
```

Keep process/protocol truth in Rust; Zustand mirrors status and normalized
problems for rendering. Monaco client/model lifecycle belongs outside
`MonacoHost` React effects in a session-level manager so remounts, tab switches,
and future multi-pane/multi-window support do not duplicate connections.

## 11. Delivery sequence

### Milestone 0 — protocol/transport spike

- Pin compatible Monaco client packages.
- Run a fixture server over stdio through a Tauri Channel.
- Prove real file URIs, initialize, hover, completion, diagnostics, cancellation,
  malformed-message isolation, and graceful/forced cleanup.
- Measure sustained diagnostic burst throughput and webview responsiveness.

Exit: architecture decision recorded; no zombie process after app quit or
webview reload.

### Milestone 1 — process foundation and settings

- Implement registry, resolver/probes, state machine, bounded framing/queues,
  logs, restart circuit breaker, process-tree cleanup.
- Add global toggle, project tri-state override, adapter cards/path overrides,
  status and recheck.
- Add fixture binaries/scripts for missing, timeout, crash, bad JSON, huge
  message, stderr flood, ignores-shutdown, and child-spawning server.

Exit: every failure becomes a stable, actionable state; toggle precedence and
cleanup pass unit/integration tests.

### Milestone 2 — document intelligence (TypeScript)

- Replace model URIs; wire open/change/save/close and negotiated capabilities.
- Ship hover, completion, signature, definition/references, symbols, rename,
  formatting, code actions, and sanitized hover rendering incrementally.
- Prefer project TypeScript and expose its selected version.

Exit: TypeScript dogfood workflow works with saved and unsaved buffers,
monorepo navigation, Unicode paths/content, and server restart.

### Milestone 3 — diagnostics and Rust

- Implement normalized Problems service/panel, Monaco markers, tree/tab/status
  badges, related info, workspace diagnostic pull, and stale semantics.
- Add rust-analyzer initialization/progress/config handling.
- Enrich/fan out filesystem events and dynamic watcher registration.

Exit: TS and Rust run simultaneously in one worktree; diagnostic replacement,
clearing, navigation, watcher changes, and crash recovery are correct.

### Milestone 4 — safe edits, Python/Go, hardening

- Add transactional workspace edits and mapped server/editor commands.
- Validate registry abstraction with Pyright and gopls.
- Add idle eviction/resource caps and large-repo load tests.
- Finish accessibility, telemetry-free local observability, docs, and manual
  cross-platform matrix.

Exit: Phase 11 roadmap criteria plus the test matrix below pass.

### Milestone 5 — task-runner integration

- Task matcher output writes to the shared Problems service with `sourceKind =
task` and a run owner.
- Problems panel filters/grouping/navigation work unchanged.
- Optional “Run project checks” invokes configured tasks; it is never disguised
  as LSP scanning.

## 12. Required verification matrix

Automate wherever possible:

- Enablement: global on/off × project inherit/on/off; change while starting,
  indexing, crashed, and with unsaved files.
- Detection: PATH hit, absolute override, spaces/Unicode, non-executable,
  version non-zero, timeout, GUI PATH mismatch, dependency missing.
- Lifecycle: simultaneous languages/worktrees, rapid switching, duplicate start,
  app quit, webview reload, project/worktree removal, process cap eviction,
  server child processes, shutdown timeout.
- Protocol: split/coalesced stdio frames, `\r\n` headers, invalid/oversize JSON,
  response after cancellation, duplicate/unknown IDs, dynamic registration,
  server-to-client requests, progress token collisions, stderr flood.
- Documents: unsaved edits, auto-save, external change conflict, create/delete/
  rename, atomic save, case-only rename, LF/CRLF, emoji/non-BMP UTF-16 ranges,
  very large/binary/read-only files, symlinks, files outside root.
- Diagnostics: push/pull, empty clear, version race, related docs, duplicate
  sources, truncation, task rerun ownership, stale on crash, clear on disable,
  deleted file click, worktree isolation.
- Projects: TS monorepo/project references, Cargo workspace, Go workspace,
  Python virtual environment, gitignored generated sources required by builds,
  missing package installs, dependency folder storm.
- UX/accessibility: keyboard-only Problems navigation, screen-reader labels,
  color-independent severity, missing server does not steal focus, actionable
  error details, no editor typing latency during indexing.

Performance gates should be established on small, Maestro-sized, and synthetic
large repositories. At minimum track startup time to first usable completion,
typing-to-diagnostic latency, IPC queue depth, message bytes/rate, server RSS,
CPU during idle/indexing, problem count, dropped/truncated events, restarts, and
shutdown duration. Keep logs bounded and redact document text, environment
values, and user paths from exported diagnostics unless the user opts in.

## 13. Decisions and open questions

Decided:

- Project setting is tri-state and overrides the global default.
- Servers are user/toolchain installed in v2; installation is explicit.
- Process and byte-stream ownership stays in Rust.
- Monaco uses real file URIs.
- Servers index roots; Maestro never opens every file to manufacture problems.
- Problems is source-agnostic from day one and task runs own their results.
- Failures degrade to syntax-only editing.

Resolve during Milestone 0 with measurements, not preference:

- Exact `monaco-languageclient` integration mode/version and bundle cost.
- Whether Tauri `invoke` per outbound message is sufficient or needs a second
  channel/long-lived upload primitive after measuring change bursts.
- Default warm-server process/memory cap per platform.
- Which multi-file edit classes require confirmation after undo support exists.

## 14. Primary references

- [Language Server Protocol specification 3.17](https://microsoft.github.io/language-server-protocol/specifications/lsp/3.17/specification/)
- [LSP home and current specification status](https://microsoft.github.io/language-server-protocol/)
- [Tauri v2 commands, events, and channels](https://v2.tauri.app/develop/calling-rust/)
- [Tauri frontend streaming guidance](https://v2.tauri.app/develop/calling-frontend/)
- [monaco-languageclient repository and examples](https://github.com/TypeFox/monaco-languageclient)
- [typescript-language-server installation and stdio invocation](https://github.com/typescript-language-server/typescript-language-server)
- [rust-analyzer installation](https://rust-analyzer.github.io/book/installation.html)
- [rust-analyzer binary discovery](https://rust-analyzer.github.io/book/rust_analyzer_binary.html)
- [gopls official repository](https://github.com/golang/tools/tree/master/gopls)
