# OpenCode Integration — Plan

Companion to [`ARCHITECTURE.md`](./ARCHITECTURE.md) (§3 adapter protocol
reference gains a §3.5 when this lands), [`V1_SCOPE.md`](./V1_SCOPE.md),
and [`ROADMAP.md`](./ROADMAP.md). This is the decision record and build
plan for wrapping a fifth agent CLI — **opencode** — with the same
fidelity Maestro gives Claude Code, Codex, Cursor Agent, and Aider, plus
one thing none of the others need: **full in-app provider management**.

> **Verification status:** every CLI flag and HTTP endpoint below was
> verified live against `opencode 1.18.19` on the dev machine
> (2026-08-21), including a booted `opencode serve` instance probed with
> curl. **Integration complete — Phases O1 through O7 all shipped**:
> fixtures captured against a scripted local mock (the Aider-fixture
> precedent) plus one real-provider fixture; every §10 probe resolved;
> budgets measured live via the opt-in `OPENCODE_LIVE` test harness.
> Per repo convention, all flags are re-verified against whatever
> version is installed before each release, and capabilities are gated
> on detected version rather than hard-coded.

## 0. Goals and non-goals

**Goals**

1. **Terminal-parity provider management.** Everything a user can do
   from a terminal — `opencode auth login` against any of the ~193
   providers in the models.dev catalog, OAuth device flows included —
   must be doable from Maestro's UI. The user never opens a terminal to
   add, authenticate, or remove a provider.
2. **Agent-tab parity.** Turns, streaming, tool-call cards, thinking
   blocks, usage/cost footers, plan mode, resume/fork — the same chat
   surface the other four CLIs get, driven by capabilities.
3. **Zero-cost when unused.** The opencode integration must not consume
   resources unless the user is actively using opencode features. This
   is not a nicety: see §2's measurements.
4. **No new secret storage.** Credentials live in opencode's own store
   (`~/.local/share/opencode/auth.json`), written through its API.
   Maestro never holds provider keys — deliberately unlike Aider, where
   Maestro _is_ the credential store.

**Non-goals**

- Embedding or shelling out to opencode's interactive TUI flows
  (`auth login` is a TUI even with `--provider`; not scriptable).
- Hard-coding any provider list, auth flow, or model catalog. The
  catalog is live data (193 providers today); anything hardcoded rots.
- A PTY/raw-terminal mode. opencode has structured output; scraping
  ANSI would repeat the mistakes ARCHITECTURE.md §2 already rejects.
- Managing opencode's config file (`opencode.json`) contents beyond
  what provider ops require. v1 reads around it; editing it is a v2
  candidate.

## 1. The architectural decision: become a server client

### 1.1 Why the server API, not the CLI

opencode's own architecture is **server + thin clients** (TUI, IDE
plugins, web UI are all clients of an HTTP server). `opencode auth
login` is a TUI form over the same operations the server exposes as
REST. Verified inventory (1.18.19):

| Terminal workflow                | Server equivalent (verified)                                                                | Notes                                                                                                  |
| -------------------------------- | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Browse providers                 | `GET /provider` → `{all: Provider[], connected: string[]}`                                  | 193 providers in catalog; `connected` = authenticated ids                                              |
| See how a provider authenticates | `GET /provider/auth` → `{[id]: AuthMethod[]}`                                               | Declarative: `{type: "oauth"\|"api", label, prompts[]}` — includes conditional form prompts (see §3.3) |
| Paste an API key                 | `PUT /auth/{providerID}`                                                                    | Body matches provider schema; writes `auth.json`                                                       |
| Start OAuth/device flow          | `POST /provider/{providerID}/oauth/authorize` `{method, inputs}` → authorization URL/method | `method` = index into `/provider/auth` list; `inputs` answers the declarative prompts                  |
| Complete OAuth                   | `POST /provider/{providerID}/oauth/callback`                                                |                                                                                                        |
| Logout                           | `DELETE /auth/{providerID}`                                                                 |                                                                                                        |
| Models for connected providers   | `GET /config/providers`                                                                     | Connected only; includes default model per provider                                                    |
| Health/version                   | `GET /global/health` → `{healthy, version}`                                                 | Doubles as the version gate                                                                            |

The decisive property is `GET /provider/auth`: providers describe their
own auth as data — method list, labels, and form prompts with
conditional visibility (`when: {key, op, eq}`). One generic renderer
covers Anthropic's API key, GitHub Copilot's deployment-type question,
ChatGPT's browser-vs-headless OAuth choice, and every provider added to
models.dev tomorrow. This is the same philosophy as
`capabilities.rs` ("render what's declared, hardcode nothing"), applied
to auth.

**Decision: Maestro manages one long-lived `opencode serve` sidecar and
implements provider management, model listing, and (v1) turns against
it.** All HTTP stays in the Rust core behind `#[tauri::command]`s — the
webview never sees a URL or token, per ARCHITECTURE.md §5.

### 1.2 Turn transport: `run --attach` (v1), native SSE (v2 candidate)

Two viable transports for chat turns:

- **A. Spawn `opencode run --format json` per turn** — fits
  `manager.rs`'s one-process-per-turn model exactly. But every bare
  `run` cold-boots its own internal server (MCP/LSP/plugin init) per
  invocation.
- **B. `run --format json --attach http://127.0.0.1:<port>`** — same
  NDJSON stdout contract, but attaches to our already-running sidecar:
  one boot shared across all turns and tabs, warm MCP/LSP state.

**Decision: B, with automatic fallback to A** if the sidecar cannot
start (turns still work, just slower). The adapter therefore remains a
standard spawn→NDJSON→`AgentEvent` pipeline indistinguishable from the
other adapters at the `manager.rs` level.

Attach-mode caveat (verified in `run --help`): `--dir` means "path on
the remote server when attaching" — the adapter must always pass
`--dir <worktree_root>` explicitly rather than relying on
`current_dir()`. Verified working end-to-end in Phase O1 (fixture 06:
tool executed in the target directory, identical event stream).

**v2 candidate (explicitly deferred):** full server-native turns
(`POST /session/:id/message` + `GET /event` SSE +
`POST /session/:id/permissions/:permissionID`). The payoff is real —
it is the only path to `ManualGate::Prompt`-grade mid-run approval,
which `run` mode cannot do (see §5) — but it replaces the
spawn/parse/pause-resume machinery `manager.rs` is built around. Not
worth destabilizing four working adapters to get it early; revisit
once v1 ships.

## 2. Sidecar lifecycle & performance budget

### 2.1 The measurement that forces the design

Measured on the dev machine (idle, after health check):

```
opencode serve (single process)   RSS ≈ 366 MB
boot → healthy                    ≈ 1–2 s
```

366 MB is comparable to the entire rest of Maestro. An always-running
sidecar would double idle memory for users who never touch opencode.
Conversely, booting per turn (transport A) wastes 1–2 s plus MCP/LSP
init on every message. Both extremes are wrong; the sidecar must be
**started lazily and stopped aggressively**.

### 2.2 Consumer reference-counting (how "lazy" actually works)

A `OpencodeSidecar` supervisor in the Rust core owns zero-or-one server
process. Every feature that needs it **acquires a handle** for as long
as it needs the server, and drops it afterwards. The supervisor runs
the server iff handles > 0, plus a grace period.

```
                 acquire() xN                last release()
  Stopped ───────────────────────▶ Running ─────────────────────▶ Stopping ──▶ Stopped
     ▲                                │  spawn, wait /global/health    │ kill child,
     │                                │  (1–2 s, callers await)        │ reap, 60 s
     │        release() (handles      ▼                                ▼ grace first
     └────────────────────────────  IdleGrace ────────────────────────┘
                                      (timer armed: 120 s)
                                      any acquire() cancels timer
```

State: `Stopped { } | Starting { cancel: … } | Running { handles: u32 } |
IdleGrace { deadline: Instant }`. A tokio task owns the state machine;
`acquire()` returns a guard whose `Drop` decrements. All transitions are
awaitable so callers can `acquire().await` and get a ready base URL.

**What holds a handle (the complete list):**

| Consumer                                                        | Acquire    | Release                                                         |
| --------------------------------------------------------------- | ---------- | --------------------------------------------------------------- |
| OpenCode agent tab, from open to close                          | tab open   | tab close                                                       |
| A running turn                                                  | turn start | turn end/kill (a turn must never outlive the server mid-stream) |
| Settings → OpenCode pane, while visible                         | pane mount | pane unmount                                                    |
| OAuth flow awaiting callback                                    | flow start | completion/cancel                                               |
| Commit-message generation etc. (`commands/agents.rs` one-shots) | call       | call end                                                        |

Rules that fall out of this table and must be enforced:

- **Detection never acquires.** `registry::detect(OpenCode)` must be
  answerable with the sidecar stopped: binary presence via `--version`
  (as for all CLIs), auth state by reading `auth.json` directly (fast,
  local, no process). Opening Settings' _Agents_ list costs nothing.
- **App startup never acquires.** No OpenCode tab restored from a
  previous session auto-starts the sidecar until the tab is actually
  focused/rendered — restore count, render lazily like Monaco/xterm
  bundles (ARCHITECTURE.md §9).
- **Idle grace is short (120 s)** because boot is cheap (1–2 s);
  memory is expensive (366 MB). Err toward stopping.
- **Crash policy:** if the child dies while `handles > 0`, restart once
  immediately; if it dies again within 60 s, stop retrying, mark the
  sidecar failed, surface a toast with the captured stderr, and fail
  in-flight turns with an honest error. External kills (user ran
  `pkill opencode`) land here too — the UI says what happened.
- **App quit:** child spawned with `kill_on_drop(true)` (same pattern
  as every other child in `manager.rs`); supervisor drop kills the
  process group. No orphaned servers after crash/quit — verified by a
  test (§8).

### 2.3 Resource budget (enforced, not aspirational)

| Metric                                        | Budget                                                             | How checked                                                                                                     |
| --------------------------------------------- | ------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------- |
| Idle RSS with no opencode consumers           | **+0 MB** vs today                                                 | sidecar process must not exist; asserted in lifecycle test                                                      |
| Steady-state RSS, one open tab, no turn       | ≤ 400 MB (live: boots ~377 MB, **settles to ~310 MB** within 20 s) | `OPENCODE_LIVE=1 cargo test --lib live_tests` each release-hardening pass; multi-hour watch stays a manual step |
| Boot latency (stopped → healthy)              | ≤ 3 s p95 (**live-measured: 721 ms**)                              | lifecycle test timing; UI shows progress state meanwhile (§3.2)                                                 |
| Turn first-token delta vs non-attach baseline | attach must not regress                                            | Phase O5 fixture timing                                                                                         |
| Event delivery to webview                     | batched at animation-frame cadence                                 | existing §9 batching path reused, no per-line events                                                            |

Additional performance commitments:

- **No polling loops** except one: waiting for an OAuth callback
  (backoff 500 ms → 2 s, capped, cancellable). Everything else is
  event- or user-driven.
- **Catalog caching:** `GET /provider` (193 entries) and
  `GET /config/providers` are cached in-memory with a TTL (10 min) and
  invalidated on any successful auth write. The provider catalog also
  gets a SQLite-free fallback: if the sidecar is stopped and the user
  opens the "Add provider" catalog, that pane-open _is_ an acquire —
  the cache exists so re-opening the pane doesn't refetch.
- **Model picker data** comes from the sidecar when running, else
  `opencode models --verbose` (verified: prints one JSON object per
  model, no sidecar needed) — so the composer's picker never boots the
  sidecar by itself if the tab isn't open… and an open tab already
  holds a handle, making this moot in practice.
- **Transcript rendering** reuses the existing virtualized list and
  NDJSON backpressure rules (ARCHITECTURE.md §9); nothing opencode-
  specific is exempt.

## 3. Provider management — UX specification

This is the part no other adapter has. It gets designed to the same bar
as the rest of the app: every state drawn, honest copy, no dead ends.

### 3.1 Information architecture

New Settings pane: **OpenCode** (sibling of Agents / Aider Providers /
Editor…). Two sections:

```
┌ Settings ─ OpenCode ───────────────────────────────────────────┐
│                                                                │
│  CLI                                                           │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │ [oc icon] OpenCode          v1.18.19       ● Connected   │  │  ← mirrors AgentsPane
│  │ Binary path  [/home/…/.local/node/bin/opencode]  [Edit]  │  │     card conventions
│  └──────────────────────────────────────────────────────────┘  │
│                                                                │
│  PROVIDERS ─────────────────────────────────────  [+ Add]      │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │ OpenCode Zen            62 models   default    [Disconnect] │
│  │ Anthropic                9 models              [Disconnect] │  ← one row per
│  └──────────────────────────────────────────────────────────┘  │     connected
│                                                                │     provider
│  Models refresh from your connected providers automatically.   │
└────────────────────────────────────────────────────────────────┘
```

- Rows come from `GET /provider` filtered to `connected[]`, joined with
  `GET /config/providers` for model counts and the default badge.
- **Disconnect** opens the existing `AlertDialog` primitive: "Remove
  Anthropic credentials from opencode? Your API key is deleted from
  ~/.local/share/opencode/auth.json." Confirm → `DELETE /auth/:id` →
  row animates out. Optimistic UI with rollback on failure.
- Empty state (zero connected): illustration-free, one sentence —
  "Connect a provider to use OpenCode. Credentials are stored by
  opencode itself, not Maestro." — and the **Add provider** button.

### 3.2 Add-provider flow (the catalog)

**[+ Add]** opens a modal (Radix dialog, existing primitives):

```
┌ Connect a provider ──────────────────────────────── ⌕ Search ──┐
│  ┌──────────────────────────────────────────────────────────┐  │
│  │ Anthropic            API key · OAuth                     │  │  ← name, auth-method
│  │ OpenAI               ChatGPT · API key                   │  │    previews
│  │ GitHub Copilot       OAuth                               │  │
│  │ OpenCode Zen         API key                             │  │
│  │ … 189 more                                               │  │
└────────────────────────────────────────────────────────────────┘
```

- List = `GET /provider.all` minus `connected` (already-connected
  providers are rows in the pane, not here). Fuzzy filter client-side
  (`src/design/fuzzy.ts`) over name + id; 193 rows render fine
  unvirtualized, but the input takes focus on open and Enter selects
  the highlighted row — keyboard-first, like the command palette.
- Each row shows its auth methods inline (from `/provider/auth`) so
  users can see _how_ they'd connect before committing — e.g. seeing
  "ChatGPT (subscription)" vs "API key" for OpenAI is the whole
  decision.
- Loading state: skeleton rows while the catalog fetches (first open
  pays the sidecar boot — show "Starting OpenCode…" in the modal header
  with the spinner, per §2.2 boot latency budget).
- Error state (sidecar failed): the modal body becomes the error card
  with stderr excerpt + Retry, per §2.2 crash policy.

### 3.3 Connect sheet — rendered from the provider's own declaration

Selecting a provider opens a sheet driven entirely by its
`/provider/auth` entry. Two shapes exist in the wild (verified):

**(a) `api` method** — masked `TextInput` (same component the Aider
pane uses), placeholder from the method label, footer: Cancel / Save.
Save → `PUT /auth/{id}` → success closes the sheet, row appears in the
pane. The key travels keyboard → Rust command → loopback HTTP body →
`auth.json`. It is never logged, never in argv, never persisted by
Maestro. (O1 found that GET endpoints _do_ return key material — see
§7 — so the Rust layer strips credentials from every provider-listing
response before IPC; a response-schema test in O4 pins this.)

**(b) `oauth` method(s)** — method picker first when there are several
(OpenAI: "ChatGPT Pro/Plus (browser)" / "(headless)" / "Manually enter
API Key" — labels verbatim from the API, not Maestro copy). If the
method declares `prompts[]`, render them generically before starting:

```
┌ Connect GitHub Copilot ────────────────────────────────────────┐
│  Select GitHub deployment type                                 │
│  ( ) GitHub.com          Public                                │
│  (•) GitHub Enterprise   Data residency or self-hosted         │
│  ┌ Enterprise URL ───────────────────────────────┐              │
│  │ company.ghe.com                               │              │  ← shown because
│  └───────────────────────────────────────────────┘              │    when.deploymentType == enterprise
│                                          [Cancel] [Continue]   │
└─────────────────────────────────────────────────────────────────┘
```

`Continue` → `POST …/oauth/authorize {method, inputs}` → the response
carries the authorization URL (+ device code where the flow uses one).
Maestro then shows the waiting state:

```
┌ Waiting for GitHub ────────────────────────────────────────────┐
│  1. We opened your browser to github.com/login/device          │
│  2. Enter code:   ████-████   [Copy]                           │
│                                                                │
│  [Open browser again]                        [Cancel]          │
└─────────────────────────────────────────────────────────────────┘
```

Browser opening goes through `tauri-plugin-opener` (already a
dependency, same as Aider's console links). Completion is detected by
the callback poll (§2.3's one allowed loop); success closes with a
checkmark and the pane row appears. Cancel aborts the poll and releases
its handle.

**Copy rule (repo convention):** API-provided labels are shown
verbatim; Maestro-authored copy appears only for state framing
("Waiting for…", error cards) and never claims something the API
didn't say — the same honesty rule that produced `manual_gate_detail`.

### 3.4 States inventory (exhaustive, so nothing ships half-baked)

| Surface             | State                    | Treatment                                                  |
| ------------------- | ------------------------ | ---------------------------------------------------------- |
| Pane rows           | loading / loaded / error | skeleton / rows / error card + Retry                       |
| Catalog modal       | sidecar starting         | header spinner "Starting OpenCode…"                        |
| Catalog modal       | empty search result      | "No provider matches 'x'" + clear button                   |
| Connect sheet (api) | validating               | Save disabled while PUT in flight                          |
| Connect sheet (api) | rejected key             | inline error, verbatim API message, input keeps focus      |
| OAuth waiting       | timeout (>5 min)         | "Didn't complete in time — try again"; poll cancelled      |
| OAuth waiting       | user cancels             | poll aborted, handle released, sheet closes                |
| Disconnect          | in-flight                | row dims, button spins; rollback + toast on failure        |
| Whole pane          | sidecar crashed          | banner across pane: what died, stderr line, Restart button |

## 4. Agent tab integration

Everything below rides the existing capability-gated chat UI. If a
component finds itself matching on `"openCode"`, the fix is a
capability (types/agent.ts's standing rule).

### 4.1 Composer

- **Model picker:** grouped two-level menu — top level = connected
  provider (display name from `/provider`), second level = models
  (label + context/cost hints from `models --verbose` metadata —
  verified: `limit.context`, `cost`, `capabilities` per model). Default
  model preselected (from `/config.providers.default`). Footer link
  "Manage providers" → opens Settings at the OpenCode pane. Search box
  when >15 models visible.
- **Effort control:** opencode's `--variant` flag ("model variant
  (provider-specific reasoning effort)"). `separate_option_flags: true`
  — variant is its own argv flag, never baked into the model id.
  Variant sets are not enumerable anywhere (models.dev and
  `models --verbose` expose none — verified in O1), so v1 ships **no
  variant picker**; revisit only if opencode exposes variants
  programmatically (no fake dropdowns, V1_SCOPE §6).
- **Mode picker:** Manual / Auto / Plan. Plan maps to `--agent plan`
  (opencode ships build/plan agents — a real read-only mode, so
  `plan_mode: true`). Auto maps to `--auto`.
- **Manual honesty:** `run` mode cannot prompt mid-run — an "ask"
  permission either blocks the tool (surfacing as a denial event) or is
  governed by the project's `opencode.json`. So `manual_gate:
ExternalConfig` with detail copy: _"OpenCode can't ask Maestro for
  approval in headless runs — allow/deny rules come from your
  opencode.json permission config."_ Same posture class as Cursor/Aider
  today. (Server-native transport is the v2 path to `Prompt`; §1.2.)

### 4.2 Transcript mapping (opencode stream → `AgentEvent`)

Verified against Phase O1 fixtures (`src-tauri/tests/fixtures/opencode/`).
The stream is NDJSON, one event per line:

```
{ "type": "step_start" | "text" | "reasoning" | "tool_use" | "step_finish",
  "timestamp": ms, "sessionID": "ses_…", "part": { … } }
```

| opencode event                          | AgentEvent                                                      | Verified shape notes                                                                                                                                                                                                                          |
| --------------------------------------- | --------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `text`                                  | `Message` (+ `MessageDelta` accumulation not needed)            | `part.text` is the **complete** block; `run --format json` emits parts only when finished — even with 400 ms-spaced model chunks the text arrived as one event. `Streaming::Blocks` is a measured fact, not an assumption.                    |
| `reasoning`                             | `Thinking`                                                      | `part.text` carries the section; emitted only when `--thinking` is passed. One event per section.                                                                                                                                             |
| `tool_use`                              | `ToolCall` + `ToolResult`                                       | Arrives **once, with terminal state**: `part.tool` (`bash`, `read`, …), `part.callID`, `state.status` = `completed`\|`error`, `state.input`, `state.output`, `state.metadata.exit`, `state.time`. No pending/running transitions in run mode. |
| `tool_use` with `state.status: "error"` | `ToolResult(is_error)` and/or `PermissionDenied {gated: false}` | Distinguish denials by `state.error` = _"The user rejected permission to use this specific tool call."_ (verbatim, fixture 04).                                                                                                               |
| `step_finish`                           | usage accumulator → folded into `TurnResult`                    | `part.tokens: {total, input, output, reasoning, cache{read, write}}`, `part.cost`, `part.reason` = `stop`\|`tool-calls`. A turn = sum across its `step_finish` events; the last one's `reason: "stop"` marks natural completion.              |
| every event's `sessionID`               | `TurnResult.session_id`                                         | Present on all lines — resume capture is trivial.                                                                                                                                                                                             |
| stderr lines                            | `Error`                                                         | JSON-CLI convention (adapter.rs).                                                                                                                                                                                                             |

**Permission semantics (fixture 04 vs 05):** without `--auto`, a tool
hitting an `"ask"` rule is refused (`state.status: "error"` with the
rejection message) and **the turn terminates immediately** —
`step_finish(reason: "tool-calls")` follows and the model is _not_
re-consulted (verified by request counting against the mock). With
`--auto`, the identical call completes. Consequence for Maestro:
denials are surfaced as a terminal permission card with honest copy;
there is no mid-turn pause-and-widen in run mode (that remains the v2
server-transport payoff, §1.2).

### 4.3 Empty state (no provider connected)

Opening an OpenCode tab with zero connected providers shows an
in-tab card, not a broken composer:

```
│              Connect a provider to start                       │
│   OpenCode routes to whichever provider you authenticate.      │
│         [ Open Settings → OpenCode ]      (button)             │
```

Deep-link opens Settings pre-navigated to the pane (the same
`ConfigureProvider` remedy behavior Aider's card already implements —
`AuthRemedy::ConfigureProvider` is reused unchanged).

## 5. Registry, capabilities, detection (declarations to commit)

`capabilities_for(OpenCode)` — values verified against 1.18.19 except
where marked:

| Capability               | Value            | Basis                                                                                                                                                                                                                                                                          |
| ------------------------ | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `streaming`              | `Blocks`         | **Measured** (fixture 02): parts arrive only when complete, regardless of model chunk timing                                                                                                                                                                                   |
| `manual_gate`            | `ExternalConfig` | §4.1; denials are terminal (§4.2); detail copy mandatory (test enforces)                                                                                                                                                                                                       |
| `plan_mode`              | `true`           | `--agent plan`                                                                                                                                                                                                                                                                 |
| `resume`                 | `true`           | `--session <id>`                                                                                                                                                                                                                                                               |
| `fork_session`           | `true`           | `--fork` (rare among the five CLIs)                                                                                                                                                                                                                                            |
| `reports_usage`          | `true`           | Verified: `step_finish.tokens` on every step (fixtures 01–06)                                                                                                                                                                                                                  |
| `reports_cost`           | `true`           | Verified: `step_finish.cost`; report `None` rather than $0.00 where the catalog has no pricing (Aider precedent)                                                                                                                                                               |
| `reports_context_window` | `true`           | `opencode models --verbose` exposes `limit.context` per model (verified: Zen big-pickle = 200 000); adapter joins it at turn time                                                                                                                                              |
| `separate_option_flags`  | `true`           | `--variant` independent of `-m` — but see effort note below                                                                                                                                                                                                                    |
| `effort_label`           | `"Variant"`      | the flag's own name; **picker hidden in v1** — variant sets are not enumerable from models.dev or `models --verbose` (verified: zero models expose variant metadata), and a free-text field would be a guess generator. Revisit if opencode exposes variants programmatically. |
| `plan_exit_tool`         | `None`           | plan agent ends in prose                                                                                                                                                                                                                                                       |

Registry specifics:

- `AgentKind::OpenCode`; slug `"opencode"`; binary `"opencode"`;
  display "OpenCode".
- **Auth probe (fast path, no sidecar):** read
  `~/.local/share/opencode/auth.json`, count entries (structure
  verified: `{providerId: {type, key|refresh…}}`). ≥1 →
  `Authenticated` ("Connected: N providers"); parse failure →
  `Unknown` with detail, never guessed. When the sidecar happens to be
  running, prefer `GET /provider.connected` as the authoritative
  cross-check.
- **Remedy:** reuse `AuthRemedy::ConfigureProvider` — the one existing
  variant that means "fix this in the provider pane". Pill label:
  "Needs provider" (shared with Aider's wording).

## 6. Sessions, resume, fork

- List: `opencode session list --format json`. **Verified fields:**
  `id`, `title`, `updated`, `created`, `projectId`, **`directory`** —
  the worktree-correlation problem is solved directly: the Resume menu
  filters on `directory == active worktree root` (with our own
  `agent_sessions` index as belt-and-suspenders, ARCHITECTURE.md §4).
- Resume: `--session <id>`; Fork: `--fork` (with `--session`/`-c`).
- Transcript hydration on resume: `opencode export <sessionID>` —
  verified shape `{info, messages[]}` with `info.role` and typed
  `parts[]` (`text`, `tool`, `step-start`, `step-finish`) → simplified
  text-only `TranscriptTurn`s (same simplification the other CLIs'
  replay use).
- Titles: opencode generates session titles itself via the small model
  (verified during O1: a separate title-generation LLM call fires after
  each run); `--title` overrides if we ever need deterministic names.

## 7. Data, caching, security

- **No schema changes.** `agent_sessions.agent` gains a new enum value;
  everything else (settings keys `agent.opencode.binary_path`) follows
  existing patterns. Model/provider caches are in-memory with TTL (§2.3).
- **Secrets:** never stored, logged, or returned by Maestro. Loopback
  HTTP bodies only. The Aider keyring path is untouched.
  **Phase O1 finding that hardens this rule:** `GET /provider` and
  `GET /config/providers` **include credential material** in their
  responses (`"key": "sk-…"` per connected provider — verified during
  the probe). Therefore: (a) the Rust command layer must project these
  responses down to safe fields (id, name, model counts, connected
  flags) _before_ they cross IPC — raw bodies never reach the webview;
  (b) response bodies are never logged; (c) the sidecar password below
  is **mandatory**, not optional hardening — without it any local
  process could read the user's provider keys off the sidecar.
- **Sidecar exposure:** binds `127.0.0.1` on an OS-assigned free port.
  The supervisor generates a per-boot random password, passes it via
  `OPENCODE_SERVER_PASSWORD` (env, not argv — `/proc` visibility rule
  from `TurnCtx.extra_env`'s rationale) and sends it as basic auth on
  every request.
- **Shared store:** the user's own TUI sessions and Maestro share
  `auth.json` and the session database. That's a feature (log in once,
  use anywhere) but means Maestro must treat external edits as normal:
  re-read auth state on window focus, never cache credentials.

## 8. Testing strategy

- **Fixtures first (O1):** recorded `run --format json` streams under
  `src-tauri/tests/fixtures/opencode/` — happy path with tool calls,
  thinking-bearing turn, denied-permission turn, malformed-line case.
  Parser tests replay them exactly like Aider's `replay()` harness.
- **Supervisor unit tests:** fake child binary (sleep/echo script)
  driving the state machine — acquire→spawn, release→grace→stop,
  acquire-during-grace cancels stop, crash-restart-once, quit-kill.
  Asserts the +0 MB idle budget (no process exists when handles == 0).
- **Command-layer tests:** recorded JSON responses for
  provider/auth/config endpoints; asserts requests carry the basic-auth
  header and bodies match the verified schemas.
- **Integration (opt-in, real binary):** boot real `serve`, exercise
  connect-list-disconnect against a throwaway `OPENCODE_CONFIG_DIR`;
  skipped by default in CI like the live-git integration tests'
  philosophy inverted — cheap enough to run locally, network-free.
- **Frontend (Vitest):** connect-sheet renderer against fixture
  `/provider/auth` payloads (including conditional prompts), catalog
  fuzzy-filter, pane store logic.
- **E2E:** stub `opencode` binary on PATH speaking recorded fixtures;
  drive add-provider → open tab → send turn → assert cards render
  (mirrors the existing stub-binary E2E pattern).

## 9. Implementation phases

Sequenced so each phase is independently shippable and de-risks the
next. Numbering continues the ROADMAP's agent-adapter lineage (O =
OpenCode).

**Phase O1 — Probes & fixtures. COMPLETE (2026-08-21).**
Fixtures committed under `src-tauri/tests/fixtures/opencode/`
(01 tool turn, 02 text turn, 03 reasoning turn, 04 permission denied,
05 permission auto, 06 attach-mode turn — all captured against the
local mock). All probes resolved; answers folded into §4.2, §5, §6,
§7, and §10. Two surprises found and documented: GET endpoints leak
credentials (§7 hardened), and denials terminate the run (§4.2).

**Phase O2 — Sidecar supervisor (Rust only). COMPLETE (2026-08-21).**
`src-tauri/src/agents/opencode/{mod,sidecar,client}.rs` +
`commands/opencode.rs::opencode_sidecar_status`. Consumer
reference-counting state machine (`Stopped → Starting → Running →
Stopping`, plus `Failed`), idle reaper (120 s grace), crash policy
(restart once per window, then `Failed` with captured stderr tail,
self-heal after the window), per-boot random password over env,
loopback ephemeral port, `shutdown_now()` wired into `lib.rs`'s
`ExitRequested` sweep alongside `manager::kill_all`. Restart requests
travel through a channel to a driver task spawned on first acquire —
load-bearing indirection: `start` spawns `monitor`, so a direct
`monitor → start` call would make the two futures contain each other.
Tests: six lifecycle scenarios against a scripted Python fake binary
(auto-skipped where python3 is absent) covering started-only-on-demand,
grace reuse, concurrent acquire sharing, boot failure fail-closed,
crash-restart-then-fail, and quit teardown; plus command/env-shape and
port-discovery unit tests. 145/145 suite green, clippy clean.
_Exit criteria met:_ lifecycle tests prove started-only-on-demand and
stopped-after-grace; no frontend changes.

**Phase O3 — Registry, capabilities, detection. COMPLETE (2026-08-21).**
`AgentKind::OpenCode` through registry/capabilities and every
compiler-forced dispatch site. Auth detection reads `auth.json`
directly (`agents/opencode/auth.rs`, defensive classification with
unit tests — missing/malformed/unexpected shapes degrade to
`Unknown`/`NotAuthenticated`, never a guessed `Authenticated`); the
sidecar stays stopped. Capabilities declared per §5's verified table.
Turn-path arms (`build_turn`/`parse_line`/`finish`) are loud
`unreachable!()`s behind `manager::ensure_turns_supported`, which
start/resume/one-shot paths check first; sessions/slash-commands/models
arms return empty with their phase noted. Frontend: `"openCode"` in the
type union + display name + brand glyph; settings card renders from
`CliStatus` like every other CLI. New-tab menu and commit-message picker
are driven by a new `TAB_READY_AGENT_KINDS` subset so OpenCode becomes
startable exactly when Phase O5 lands. Also fixed: vitest was sweeping
stale worktrees under `.claude/worktrees/` (own node_modules, duplicate
React) into every run — now excluded in `vite.config.ts`.
_Exit criteria met:_ card renders for installed/not-installed/no-provider
with zero sidecar spawns (nothing on this path calls `acquire`);
152 Rust + 162 frontend tests green, clippy/tsc/fmt clean.

**Phase O4 — Providers pane (the centerpiece UX). COMPLETE (2026-08-21).**
Rust: `agents/opencode/providers.rs` (projected types + flows — the
projection rule is unit-tested against payloads carrying fake secrets
that must not survive), extended `client.rs` verbs, eight commands in
`commands/opencode.rs` including pane-lifetime acquire/release tokens
(§2.2's "pane visible" consumer across IPC) and a TTL'd catalog cache.
Frontend: `OpenCodeProviders` section inside OpenCode's agent card
(aider's inline pattern), catalog modal with fuzzy search + letter
grouping, connect sheets rendering providers' own declared methods and
conditional prompts generically, OAuth wait with poll/cancel/timeout,
disconnect confirm. The "Add a provider" remedy button now scrolls to
it.

Live smoke test (real server, isolated process): API-key connect via
the exact `PUT /auth/{id}` wire shape flipped `connected` instantly;
DELETE removed the credentials file-level. Two findings folded back
into the code/doc:

1. **A running server's `/provider.connected` keeps removed ids until
   restart** (additions appear instantly). Without compensation a just-
   disconnected row resurrects on refresh — fixed with
   `opencode_recent_disconnects` trusted over the list for 10 minutes.
2. **`OPENCODE_CONFIG_DIR` does not isolate `auth.json`** (only
   opencode.json) — the test briefly wrote to the real store (restored
   byte-identical afterwards; verified by checksum). Future integration
   tests must redirect `XDG_DATA_HOME`, not config dir.

Honest caveat: the OAuth path is spec-verified (`ProviderAuthAuthorization`
= `{url, method: auto|code, instructions}`) and its completion polling is
flow-agnostic, but no live OAuth login was performed — that needs a human
browser round-trip and lands with real usage.

_Exit criteria met:_ connect-by-key and disconnect work entirely in-app
(live-verified); every §3.4 state implemented and reachable; 156 Rust +
169 frontend tests green, clippy/tsc/fmt clean.

**Phase O5 — Turn adapter. COMPLETE (2026-08-21).**
`agents/opencode/turn.rs`: `build_turn` (`run --format json --thinking`,
attach + `--dir` + sidecar password when the supervisor is up, self-boot
fallback when not; `-m provider/model`, `--variant`, `--agent plan`,
`--auto`, `--session`/`--fork`), `parse_line` (text → `Message`,
reasoning → `Thinking`, terminal-state tool parts → call/result pairs
with permission refusals surfaced as `PermissionDenied {gated: false}`,
step usage accumulated, unknown shapes forwarded as `Raw`), and
`finish` synthesizing the `TurnResult` from step totals — where a
completed turn's true $0.00 ships as `Some(0.0)` rather than a None that
would read as "unknown". `manager.rs` holds the sidecar guard for the
whole turn (the reaper can't kill the server mid-run) and fills
`TurnCtx.attach`; the O3 gate is gone. One-shot commit-message
generation implemented on the same parser shape.

**Exit check performed live**: a real turn against opencode/big-pickle
(free model) through the actual attach path produced thinking blocks, an
executed `write` tool (file verified on disk), two steps' token totals,
and "DONE" — captured as fixture `07_real_zen_turn.jsonl` with a replay
test asserting the full pipeline. 169 Rust tests green (13 new turn
tests), clippy/fmt clean; frontend flipped to ready (`TAB_READY_AGENT_
KINDS`, new-tab entry without a fake shortcut).

**Phase O6 — Composer & sessions polish. COMPLETE (2026-08-21).**
Model picker: `list_agent_models`'s OpenCode arm prefers the running
sidecar's `/config/providers` + `/provider` (rich `Provider · Model`
labels, authoritative connected set) and falls back to `opencode
models` — plain ids, no server needed, so opening a picker never boots
one. Labels carry the provider, so the composer's existing flat fuzzy
menu self-groups under search; no bespoke grouping UI was built for it.
No effort/variant picker (still not enumerable — §5 stands). The
no-provider empty state is the generic `NotReadyCard` fed by real auth
detail ("No providers connected yet — add one to use OpenCode"), which
names the fix without a dead deep-link button.

Sessions: resume lists come from `opencode session list --format json`,
scoped to the active worktree by its verified `directory` field;
transcript hydration parses `opencode export <id>`'s `{info,
messages[].parts}` into text-only user/assistant pairs (same
simplification as every other CLI's replay). Both live-verified: a real
turn's session appeared scoped to its worktree and exported cleanly.

_Exit criteria met:_ picker lists only connected providers' models
(sidecar path) with an honest CLI fallback; resume hydrates transcript
(live-verified). 170 Rust tests green; tsc/fmt/clippy clean; 169
frontend tests.

**Phase O7 — Hardening & performance validation. COMPLETE (2026-08-21).**
Budgets re-measured live and written into §2.3: boot **721 ms** (budget
3 s), idle RSS settles **377 → ~310 MB** over 20 s with no warmup
growth (budget ≤ 400 MB) — the +0 MB idle budget was already
test-enforced. External-kill recovery (`kill -9` mid-guard → fresh pid)
validated against the real binary via a new opt-in harness
(`OPENCODE_LIVE=1 cargo test --lib live_tests`) that doubles as the
standing release-hardening check; the multi-hour soak stays manual, by
design. Version-drift posture documented (floor: verified flags of
1.18.x; older builds fail loudly at spawn) and added to CHECKLIST.md's
edge-case sweep alongside the sidecar lifecycle cases.
`ARCHITECTURE.md` gained its §3.5 protocol reference.
_Exit:_ budgets met — no deviations to rationalize.

## Integration status

Phases O1–O7 complete. OpenCode ships as Maestro's fifth agent CLI:
in-app provider management against any of models.dev's ~193 backends,
sidecar-backed turns that cost nothing when unused, plan mode,
resume/fork, usage/cost footers, and commit-message generation.

## 10. Probe results (Phase O1 — resolved 2026-08-21)

Captured against a scripted local OpenAI-compatible mock (no live
provider spend); fixtures in `src-tauri/tests/fixtures/opencode/`.

1. **`run --format json` envelope** — resolved (§4.2): NDJSON
   `{type, timestamp, sessionID, part}`; types `step_start`, `text`,
   `reasoning`, `tool_use`, `step_finish`.
2. **Streaming granularity** — resolved: `Blocks`. Parts arrive only
   when complete (fixture 02 held model chunks 400 ms apart; text still
   landed as one event).
3. **Denied "ask" permission** — resolved (§4.2): `tool_use` with
   `state.status: "error"` and a verbatim rejection message; the turn
   terminates immediately and the model is not re-consulted. `--auto`
   runs the identical call.
4. **Session↔directory** — resolved (§6): `session list --format json`
   rows carry `directory` and `projectId`.
5. **Usage/cost/context** — resolved (§5): per-step `tokens` + `cost`;
   context window via `models --verbose` → `limit.context`.
6. **Variant enumeration** — resolved: not exposed by models.dev or
   `models --verbose`; v1 ships no variant picker (§5 effort note).
7. **GET secrecy** — **resolved, and the assumption was wrong**:
   `/provider` and `/config/providers` return credential material.
   Mitigations are now requirements in §7.
8. **Sidecar RSS soak** — resolved for the short window by the opt-in
   live test (`OPENCODE_LIVE=1 cargo test --lib live_tests`):
   boot-to-healthy **721 ms**, RSS **settles 377 → ~310 MB** in 20 s
   (no warmup growth), and external `kill -9` recovers onto a fresh pid
   with consumers attached. The multi-hour stability watch remains a
   manual release-hardening step — automated only in the sense that the
   harness now exists.

Surprises that re-opened the doc before code (per Phase O1 exit
criteria): #7 above, and the terminal-denial semantics in #3 (which
simplifies v1's Manual story but confirms `ExternalConfig`).

## Sources

- opencode CLI reference — https://opencode.ai/docs/cli (flags verified
  against installed 1.18.19 `--help` output)
- opencode server reference — https://opencode.ai/docs/server
  (endpoints verified live via `/doc` OpenAPI spec + curl)
- opencode permissions — https://opencode.ai/docs/permissions
- models.dev (provider/auth catalog backing `/provider`)
- Live probes on this machine: `serve` RSS/boot measurements,
  `/provider` (193 entries), `/provider/auth` schema samples
  (github-copilot conditional prompts), `auth.json` structure,
  `session list --format json`, `models --verbose`
