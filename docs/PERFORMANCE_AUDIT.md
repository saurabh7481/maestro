# Maestro Performance Audit

Scope: full-stack audit (React renderer, Tauri IPC boundary, Rust backend, bundle,
CSS) for RAM and CPU footprint and interaction latency. Every finding below is
anchored to a specific file and line, with a concrete fix and an estimate of what
it buys.

Measured baseline (from the checked-in `dist/` build, 2026-08-15):

| Asset                          | Size        | Loaded               |
| ------------------------------ | ----------- | -------------------- |
| `index-*.js`                   | **1.19 MB** | eagerly, at startup  |
| `index-*.css`                  | **126 KB**  | eagerly, at startup  |
| `languages-*.js` (Monaco core) | **2.65 MB** | on first file tab    |
| `languages-*.css`              | 79 KB       | on first file tab    |
| `editor.worker-*.js`           | 273 KB      | on first file tab    |
| `MonacoHost-*.js`              | 92 KB       | on first file tab    |
| fonts (23 × woff2 + 4 × woff)  | 416 KB +    | on demand per subset |
| **total `dist/`**              | **5.0 MB**  |                      |

The Rust release profile is already well-tuned (`lto = true`,
`codegen-units = 1`, `opt-level = "s"`, `strip`, `panic = "abort"` —
`src-tauri/Cargo.toml`). The problems are almost entirely on the renderer
side and at the IPC boundary.

---

## Status: Tier 1 is implemented

All five Tier 1 items are done. Measured against the same `pnpm build`:

| Eager (blocks first paint) | Before         | After        |
| -------------------------- | -------------- | ------------ |
| entry JS                   | 1,215.8 kB     | 451.7 kB     |
| `react` chunk (new)        | —              | 180.3 kB     |
| `radix` chunk (new)        | —              | 116.6 kB     |
| entry CSS                  | 126.2 kB       | 52.8 kB      |
| **total eager**            | **1,341.9 kB** | **801.4 kB** |
| **total eager, gzipped**   | ~—             | **210.5 kB** |

Moved behind a dynamic import (loaded only when the feature is used):
`TerminalTab` + xterm 333.1 kB JS / 4.4 kB CSS, `AgentTab` 63.8 kB JS /
23.9 kB CSS, `marked` 42.5 kB, `dompurify` 29.0 kB.

Fonts: 27 files (23 woff2 + 4 woff, 416 kB, 31 `@font-face` rules) → 6
woff2 files (220 kB, 6 rules). Total `dist/` 5.0 MB → 4.6 MB.

Runtime changes not visible in the bundle table:

- Terminal output no longer touches reactive state at all; the per-chunk
  O(n²) array copy and store notification are gone, and xterm's scrollback
  is 2000 lines instead of 8000 (~4–5 MB less resident RAM per terminal).
- Agent and terminal tabs stay mounted while open (MRU-capped at 6) and
  hide with CSS, so switching tabs no longer disposes xterm or rebuilds a
  transcript.
- The agent transcript is virtualized, every row-level component is
  `memo`'d against stable group identities, the 1 Hz working-timer tick is
  isolated in a leaf component, and autoscroll is instant and gated on the
  user actually being at the bottom.

Verified: `pnpm typecheck`, `pnpm lint` (0 errors), `pnpm test` (12/12),
`pnpm build`, and a live `tauri dev` reload confirming the renderer boots
clean and the lazily-loaded markdown chunk resolves and renders. The
interactive paths this touches — switching between several open agent and
terminal tabs, scrolling a long transcript, a noisy terminal command —
have not been exercised by hand.

---

## Tier 1 — biggest wins, do these first

### 1.1 Terminal output does an O(n²) array copy per frame, and duplicates the whole scrollback in JS

`src/state/terminalSessionStore.ts:87`

```ts
const chunks = [...tab.chunks, bytes];
```

Every PTY batch (the backend flushes at ~16 ms, `src-tauri/src/terminal.rs`)
rebuilds the entire chunk array _and_ the entire `byTerminalId` map, then
`set()` fires a store notification. At a 2 MB budget with ~4 KB chunks that's a
~500-element array copied ~60×/s during any noisy command (a build, `cat`, a
test watcher) — pure garbage generation, plus a store notification storm.

Worse, this buffer is **redundant memory**. xterm.js already keeps its own
scrollback (`scrollback: 8000` at `src/components/terminal/TerminalTab.tsx:78`,
roughly 6 MB of cell buffer per terminal at 200 columns). The JS replay buffer
exists only because `MainContent` unmounts the terminal when you switch tabs
(see 1.2) — fix that and most of this buffer's reason to exist disappears.

**Fix:**

- Replace the array-spread with a mutable ring buffer held **outside** zustand
  (a module-level `Map<string, {chunks, bytes}>`). Nothing renders off it; it
  does not belong in reactive state at all. Keep only `exitCode`/`started` in
  the store.
- Drop `MAX_BUFFER_BYTES` from 2 MB to ~256 KB once terminals stop unmounting.
- Lower xterm `scrollback` from 8000 to 2000 (still generous) and make it a
  setting. Saves ~4–5 MB of RAM per open terminal tab.

**Expected:** several MB of RAM per terminal, and the per-frame CPU cost of a
busy terminal drops to roughly the `term.write()` call alone.

### 1.2 Every non-editor tab is destroyed and rebuilt on tab switch

`src/components/chrome/MainContent.tsx:53-100`

`MonacoHost` is correctly kept alive and hidden with `display: none`. Terminal
and agent tabs are not — they only render when `activeTab.type` matches, so
switching tabs disposes the xterm.js instance (`TerminalTab.tsx:118`
`term.dispose()`) and unmounts the entire agent transcript. Coming back
re-instantiates xterm, re-parses and replays the whole buffer, and re-renders
every transcript node from scratch.

This is the single largest contributor to "navigation doesn't feel snappy."

**Fix:** apply the same pattern `MonacoHost` already uses — render every _open_
terminal and agent tab, toggling visibility with `display: none` on the
non-active ones. Cap it (e.g. keep the 6 most-recently-used mounted, unmount
beyond that) so a user with 30 tabs doesn't pay for all of them. The backend
processes already survive independently, so this is purely a renderer-side
change.

**Expected:** tab switching becomes an O(1) CSS change instead of an
unmount/remount/replay cycle.

### 1.3 The agent transcript re-renders in full on every streamed event, and once per second while working

Three compounding problems in `src/components/agent/AgentTab.tsx`:

1. **`groupItems` is unmemoized** (line 347) and builds fresh group objects on
   every render, so no child can bail out.
2. **Nothing is memoized.** `AgentMarkdown`, `ToolCallCard`, `ThinkingBlock` are
   plain components. A single token event re-renders every node in the
   transcript. (The markdown _parse_ is cached by `useMemo` inside
   `AgentMarkdown`, so the cost is reconciliation, not re-parsing — but on a
   long transcript that's still thousands of vDOM nodes per event.)
3. **`useElapsedSeconds` (line 90) ticks `setState` every second** while the
   agent is working, re-rendering `AgentTab` — and therefore the entire
   transcript — once per second for the whole duration of a turn, even with
   zero incoming events.
4. **`behavior: "smooth"` autoscroll** (line 280) fires on every
   `items.length` change; overlapping smooth-scroll animations during streaming
   are a known jank source in WebKitGTK.

**Fix:**

- `useMemo(() => groupItems(items), [items])`.
- Wrap `AgentMarkdown`, `ToolCallCard`, `ThinkingBlock`, `RawEventCard` in
  `React.memo`.
- Move the elapsed-seconds counter into its own leaf component so its 1 Hz
  re-render can't touch the transcript.
- Switch autoscroll to `behavior: "auto"` and gate it on "user is already
  pinned to the bottom" (standard chat-scroll behavior) — this also fixes the
  annoyance of being yanked back down while reading scrollback.
- Virtualize the transcript with `@tanstack/react-virtual` (already a
  dependency, already used by `FileTree`). Long sessions currently hold every
  tool-call card, diff line, and markdown block in the DOM simultaneously.

**Expected:** streaming a turn should cost roughly one appended node per event
instead of a full-tree reconciliation, and an idle-but-working agent tab should
cost zero renders.

### 1.4 ~1.3 MB of eager JS/CSS at startup, most of it not needed to show the window

`dist/index.html` loads a single 1.19 MB `index-*.js` and 126 KB `index-*.css`
synchronously. That's parse + compile + execute before first paint.

Confirmed contents that should not be eager:

| Module                                                    | Approx. minified  | Needed at startup?                                 |
| --------------------------------------------------------- | ----------------- | -------------------------------------------------- |
| `@xterm/xterm` (+ `xterm.css`, 81 refs in `index.css`)    | ~250 KB           | No — only when a terminal tab opens                |
| `marked`                                                  | ~45 KB            | No — only for agent transcripts / markdown preview |
| `dompurify`                                               | ~25 KB            | No — same                                          |
| all 31 `@font-face` rules incl. cyrillic/greek/vietnamese | in the 126 KB CSS | Latin only, in practice                            |

**Fix:**

- Lazy-load `TerminalTab` via `React.lazy` exactly the way `MonacoHost` and
  `DiffView` already are in `MainContent.tsx:20-25`. This moves xterm and
  `xterm.css` into an on-demand chunk.
- Make `renderMarkdownToHtml` (`src/design/renderMarkdown.ts`) dynamically
  import `marked` and `dompurify` on first use, or lazy-load
  `AgentMarkdown`/`MarkdownPane` at the component boundary.
- Add a `build.rollupOptions.output.manualChunks` split in `vite.config.ts`
  (react/react-dom, radix, app shell) so incremental rebuilds and the webview's
  code cache behave better.

**Expected:** eager bundle from ~1.19 MB to roughly 600–700 KB, and the eager
CSS from 126 KB to ~45 KB. Directly shortens cold-start time to first paint.

### 1.5 Fonts ship 27 files and 31 `@font-face` rules for a Latin-only UI

`src/styles/fonts.ts` imports `@fontsource-variable/inter` (all 7 subsets) and
four separate static weights of JetBrains Mono (4 subsets each = 16 files), plus
Vite emits legacy `.woff` fallbacks that a Tauri webview (WebKitGTK / WebView2 /
WKWebView) will never use.

**Fix:**

```ts
import "@fontsource-variable/inter/latin.css";
import "@fontsource-variable/jetbrains-mono/latin.css"; // variable, replaces 4 static weights
```

and drop `.woff` from the asset pipeline. Keeps every weight the UI actually
uses (the variable JetBrains Mono covers 400/500/600/700 in one file).

**Expected:** 27 font files → 2, ~416 KB → ~130 KB on disk, 31 `@font-face`
rules → 2. Smaller installer, less CSS to parse at startup.

---

## Status: Tier 2 is implemented

Done: **2.1, 2.2, 2.3, 2.4, 2.5**. **2.7** was already delivered as part of
Tier 1 (it was a prerequisite for hiding terminals with `display: none`).
**2.6 is withdrawn** — the finding was wrong; see that section for why the
CSS was deliberately left alone.

What changed:

- **2.1** `MonacoHost`'s fs-event listener is registered once per worktree
  and reads `tabs` from the store at event time. Opening/closing/switching a
  tab no longer costs two async IPC round-trips to re-register it.
- **2.2** The watcher's `git status` is paced by a long-lived task per
  worktree: bursts coalesce into one pass, with a 750 ms floor between
  passes and a guaranteed trailing pass. Debounce went 250 ms → 400 ms, and
  touched paths are de-duplicated into a set. Under sustained churn this
  adds latency, never staleness.
- **2.3** SCM and search results are virtualized. Both were flattened into
  single row lists (`scmRows.ts`, `resultRows.ts`) — extracted as pure
  functions and unit-tested, since the collapse/key/ordering rules are the
  actual behavior.
- **2.4** The search scan runs each round's files in parallel on the
  blocking pool and emits one `Match` event per round instead of one per
  matching file. Results stay in `git ls-files` order (handles are awaited
  in spawn order — covered by a test). A 2,000-file ceiling now stops
  runaway queries, surfaced in the panel as "stopped early, narrow it"
  rather than silently truncating.
- **2.5** LSP writes batch into one `invoke` per microtask turn via a new
  `send_lsp_messages` command, and `write()` no longer blocks on the IPC
  round-trip. Strictly one batch is in flight at a time — concurrent
  `invoke`s have no ordering guarantee, so letting two overlap could deliver
  a `didChange` before its `didOpen`. Four tests cover the batching,
  non-blocking resolve, in-flight ordering, and error propagation.

Verified: `pnpm typecheck`, `pnpm lint` (0 errors), `pnpm test` (28 passing,
up from 12), `cargo test` (56 passing, up from 54), `pnpm build`. On the live
`tauri dev` session, the renderer boots clean and both rewritten panels — the
virtualized SCM view against a worktree with ~40 changed files, and the
virtualized search panel — were driven through a mount cycle with no
ErrorBoundary crash or unhandled rejection.

Not exercised by hand: scrolling either virtualized list, running a real
search on a large repo, or typing in an editor with a language server
attached.

---

## Tier 2 — real, cheaper to fix

### 2.1 `MonacoHost` tears down and re-registers a global Tauri event listener on every tab change

`src/components/editor/MonacoHost.tsx:286` — the fs-events effect depends on
`tabs`, so opening, closing, or switching _any_ tab unsubscribes and
re-subscribes the `fs://{worktreeId}` listener. `listen()` is an async IPC
round-trip in each direction.

**Fix:** register once per `worktreeId` and read `useTabsStore.getState().tabs`
inside the callback (the codebase already uses this pattern deliberately in
`AppShell.tsx`'s `useQuitGuard`). Change deps to
`[worktreeId, setExternalChangePending]`.

Note there are now two subscribers on this same channel (`explorerStore` and
`MonacoHost`), each deserializing the same payload. Consider funnelling both
through `explorerStore`'s single listener.

### 2.2 Every filesystem event runs a full `git status` over the worktree

`src-tauri/src/watcher.rs:130` — the debounced callback unconditionally calls
`git::working_status`, which shells out to
`git status --porcelain=v2 --branch -z --untracked-files=all`. With a 250 ms
debounce, a running build or test watcher drives a full-worktree `git status`
four times a second. On a large monorepo that is the dominant background CPU
cost of having the app open.

**Fix:**

- Raise the debounce to 400–500 ms and add a trailing coalesce so bursts
  collapse into one status pass.
- Add a minimum interval between status runs (e.g. never more than once per
  750 ms) with a trailing re-run, independent of the watcher debounce.
- Skip the status pass entirely when no watched path is inside the working tree
  the SCM view is showing.

### 2.3 SCM, history, and search results are unvirtualized

- `src/components/chrome/ExplorerSidebar.tsx:524` — working-tree changes
  `.map()`
- `src/components/chrome/ExplorerSidebar.tsx:656` — commit log `.map()`
  (paginated at 50, so bounded — lower priority)
- `src/components/search/SearchPanel.tsx:238` + `:76` — **nested** map over
  files × matches, entirely unbounded

A search hitting 5,000 matches builds 5,000+ DOM rows. `FileTree` already
demonstrates the right pattern with `useVirtualizer`.

**Fix:** flatten search results to a single `(file-header | match)` row list and
virtualize it; virtualize the SCM changes list above ~100 entries.

### 2.4 Text search is fully sequential and emits one IPC event per matching file

`src-tauri/src/search.rs:113` — `for rel_path in files { ... }` reads and scans
each file one at a time on a single task, on a machine that certainly has more
cores. Each matching file then emits its own Tauri event
(`src-tauri/src/commands/search.rs:61`), so a broad query produces thousands of
individual IPC messages the renderer must deserialize and reduce over.

**Fix:**

- Scan with bounded parallelism: `futures::stream::iter(files).for_each_concurrent(N, …)`
  with `N = num_cpus`, or hand the whole scan to `spawn_blocking` + `rayon`.
- Batch emitted matches — accumulate and flush every ~50 files or ~100 ms,
  matching the coalescing pattern `terminal.rs` already uses.
- Add a hard cap on total matches (with a "showing first N" affordance).

### 2.5 Each LSP notification is an awaited IPC round-trip

`src/lsp/transport.ts:52` — `TauriMessageWriter.write` does
`await lspApi.sendMessage(...)`, and `sendMessage` is an `invoke`. Every
keystroke in an editor sends a `textDocument/didChange` that blocks the writer
queue on a full round-trip through the IPC bridge, JSON-serialized twice
(once by `JSON.stringify(message)`, once by Tauri's own arg serialization).

**Fix:** the incremental sync itself is correct (`clientManager.ts:349` uses
`syncKind === 2` properly — good). The transport is the problem:

- Coalesce notifications in a microtask-batched queue and send an array of
  messages per `invoke` (add a `send_lsp_messages` batch command).
- Don't await notification writes; only await requests.

### 2.6 `will-change` on repeated list rows — WITHDRAWN, this finding was wrong

- `src/components/chrome/Sidebar.module.css:93` — `will-change: background-color`
- `src/components/chrome/Sidebar.module.css:161` — `will-change: opacity`
- `src/components/primitives/IconButton.module.css:18` — `will-change: background-color`

The original recommendation here was "delete all three". That was a bad call on
two counts, and the CSS has deliberately been left alone.

First, all three carry code comments documenting a **specific observed
WebKitGTK bug** — a `:hover` background left "stuck" after the pointer leaves,
because WebKit misses the repaint invalidation. These are load-bearing bug
fixes, not cargo-culted hints, and deleting them to reclaim GPU memory that was
never measured would trade a real, user-visible defect for a speculative win.

Second, the stated cost was overstated. `background-color` is not a
compositable property, so `will-change: background-color` does not promote an
element to its own compositor layer the way the finding claimed; it creates a
stacking context and little else. Only `.rowAction`'s `will-change: opacity` is
a genuine layer promoter.

And that remaining case is now bounded by §2.3's work: the SCM and search lists
are virtualized, so the number of promoted `.rowAction` layers is capped by the
size of the virtual window (~30 rows) instead of growing with the result count.
The other users — `WorkspaceSidebar` rows, icon buttons — are bounded by
project/worktree count, which is small.

**Conclusion:** no change. Revisit only with an actual GPU-memory measurement
showing these matter, and pair any removal with a check that the stuck-hover bug
hasn't returned.

Also audit `.mo-glass`'s `backdrop-filter: blur(20px) saturate(1.4)`
(`src/styles/global.css:113`) — it's used on the command palette and modals,
which is acceptable, but it is expensive in WebKitGTK and should never land on
anything that scrolls or repaints frequently.

### 2.7 Terminal resize floods the IPC bridge during sidebar drags

`src/components/terminal/TerminalTab.tsx:113` — the `ResizeObserver` callback
calls `fitAddon.fit()` (which forces reflow and re-measures glyphs) plus an
`invoke("resize_terminal")` on _every_ observation. Dragging the sidebar
resize handle fires this continuously.

**Fix:** wrap the callback in a `requestAnimationFrame` coalescer and skip the
IPC call when `rows`/`cols` are unchanged from the last sent value.

---

## Tier 3 — worth doing, lower impact

### 3.1 SQLite opens without WAL

`src-tauri/src/db.rs:7` sets only `foreign_keys`. Add:

```rust
conn.pragma_update(None, "journal_mode", "WAL")?;
conn.pragma_update(None, "synchronous", "NORMAL")?;
```

Cheap, removes fsync stalls on session/worktree writes.

### 3.2 Agent stdout emits one Tauri event per JSON line

`src-tauri/src/agents/manager.rs:145` emits per parsed line. Combined with
1.3's full-transcript re-render, a chatty CLI turn is a lot of IPC. Coalesce
text-delta events on the Rust side the way `terminal.rs` already coalesces PTY
output (~16 ms flush), keeping structural events (`toolCall`, `turnResult`)
immediate.

### 3.3 Session prefs are written on every tab mutation

`src/design/useSessionPersistence.ts:96` — `saveSessionPrefs` runs in an effect
keyed on `tabs`, so every tab open/close/switch writes to the Tauri store.
Debounce by ~500 ms and flush on `onCloseRequested`.

### 3.4 `MAX_MODELS = 10` Monaco models

`src/editor/monacoModelRegistry.ts:26`. Reasonable, but each model holds the
full file text plus tokenization state. Consider dropping to 6, or budgeting by
total bytes rather than count, so ten large files can't pin ~20 MB.

### 3.5 `buildProblemPathSummaries` recomputes on every diagnostics push

`src/components/explorer/FileTree.tsx:96` memoizes on `problemsByOwner`, which
gets a new object identity on every `replaceDocumentProblems` call. During a
typing burst with a language server attached this rebuilds the whole summary map
and re-flattens the tree per diagnostic publish. Debounce diagnostics into the
store by ~150 ms.

---

## Suggested execution order

1. **1.2** (keep tabs mounted) — biggest perceived-snappiness win, self-contained.
2. **1.3** (agent transcript memo + virtualize + kill the 1 Hz tick).
3. **1.1** (terminal buffer out of zustand, lower scrollback).
4. **1.4 + 1.5** (lazy xterm/marked, latin-only fonts) — one bundle-focused pass.
5. **2.1, 2.2, 2.6, 2.7** — small, independent, each a clear CPU/RAM reduction.
6. **2.3, 2.4, 2.5** — larger refactors, schedule separately.
7. **Tier 3** as cleanup.

## Recommended instrumentation before/after

- `pnpm build` and diff the `dist/assets` table at the top of this document.
- WebKitGTK: run with `WEBKIT_DEBUG=1` or attach the Web Inspector's Timeline to
  a streaming agent turn and a busy terminal; measure scripting time per second.
- RSS: `ps -o rss= -p $(pgrep -f maestro)` with (a) cold start, (b) three
  terminals open, (c) a 200-message agent transcript. These are the three
  scenarios the findings above target.
