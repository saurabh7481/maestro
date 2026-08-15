import { create } from "zustand";
import { listenToPtyEvents } from "../api/terminal";

/** Replay scrollback held on this side of the IPC boundary, purely so a
 * terminal that gets torn down and rebuilt can be repainted.
 *
 * Small on purpose. `MainContent` used to unmount every non-active tab, so
 * this buffer had to stand in for the *entire* visible scrollback; it was
 * 2 MB per terminal on top of xterm.js's own (much larger) cell buffer.
 * Terminals now stay mounted while they're open (see `TabHost.tsx`), so a
 * remount only happens when the MRU cap evicts one or on the StrictMode
 * double-invoke — this just needs to cover the last screenful or two, not
 * a session's history. See docs/PERFORMANCE_AUDIT.md §1.1. */
const MAX_BUFFER_BYTES = 256_000;

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

interface ReplayBuffer {
  chunks: Uint8Array[];
  bufferedBytes: number;
}

interface TerminalCallbacks {
  onData: (bytes: Uint8Array) => void;
  onExit: (code: number | null) => void;
}

/** Deliberately module-level rather than zustand state.
 *
 * Neither of these is ever read during a render — `TerminalTab` writes
 * bytes straight into its xterm.js instance and reads the buffer once, in
 * an effect, to replay it. Keeping them in the store meant every PTY batch
 * (~60/s on a busy command) rebuilt the whole `byTerminalId` record *and*
 * copied the entire chunk array (`[...tab.chunks, bytes]`), then fired a
 * store notification that no subscriber cared about — O(n²) copying and a
 * notification storm to maintain state nothing rendered from.
 * See docs/PERFORMANCE_AUDIT.md §1.1. */
const replayBuffers = new Map<string, ReplayBuffer>();
const callbacksByTerminalId = new Map<string, TerminalCallbacks>();

function appendToReplayBuffer(terminalId: string, bytes: Uint8Array): void {
  let buffer = replayBuffers.get(terminalId);
  if (!buffer) {
    buffer = { chunks: [], bufferedBytes: 0 };
    replayBuffers.set(terminalId, buffer);
  }
  // Mutated in place — a ring buffer, not a new array per chunk.
  buffer.chunks.push(bytes);
  buffer.bufferedBytes += bytes.length;
  while (buffer.bufferedBytes > MAX_BUFFER_BYTES && buffer.chunks.length > 1) {
    buffer.bufferedBytes -= buffer.chunks.shift()!.length;
  }
}

/** Repaints a freshly created xterm.js instance from the replay buffer.
 * Called from `TerminalTab`'s mount effect. */
export function replayTerminalBuffer(terminalId: string, write: (bytes: Uint8Array) => void): void {
  const buffer = replayBuffers.get(terminalId);
  if (!buffer) return;
  for (const chunk of buffer.chunks) write(chunk);
}

/** Flattens a terminal's replay buffer so it can be handed to another
 * window (`chrome/satelliteWindows.ts`). The PTY itself lives in Rust and
 * keeps streaming to every window, but this buffer is per-window — without
 * carrying it over, a terminal dragged into a new window would come up
 * blank until its next output. */
export function exportTerminalBuffer(terminalId: string): Uint8Array | null {
  const buffer = replayBuffers.get(terminalId);
  if (!buffer || buffer.chunks.length === 0) return null;
  const flat = new Uint8Array(buffer.bufferedBytes);
  let offset = 0;
  for (const chunk of buffer.chunks) {
    flat.set(chunk, offset);
    offset += chunk.length;
  }
  return flat;
}

/** The receiving half of `exportTerminalBuffer` — seeds this window's
 * buffer before the terminal's `TerminalTab` mounts and replays it. */
export function seedTerminalBuffer(terminalId: string, bytes: Uint8Array): void {
  replayBuffers.set(terminalId, { chunks: [bytes], bufferedBytes: bytes.length });
}

interface TerminalTabState {
  exitCode: number | null;
  started: boolean;
}

function emptyTabState(): TerminalTabState {
  return { exitCode: null, started: false };
}

interface TerminalSessionState {
  /** Only the two fields that actually drive UI. Both change at most twice
   * in a terminal's lifetime, so a `set()` here is genuinely rare — unlike
   * the per-frame output stream, which no longer touches the store at all. */
  byTerminalId: Record<string, TerminalTabState>;
  unlistenByTerminalId: Record<string, () => void>;

  /** Sets up the `pty://{terminalId}/data` listener once per terminal and
   * buffers output so a rebuilt `TerminalTab` (MRU eviction in `TabHost`,
   * or React StrictMode's dev-mode double-invoke of its mount effect) can
   * replay recent scrollback into a fresh xterm.js instance instead of
   * coming back blank.
   *
   * The listener itself is only created once (guarded below), but the
   * `onData`/`onExit` callbacks are updated on *every* call, and the
   * listener always reads the latest ones out of `callbacksByTerminalId`
   * rather than closing over whatever was passed the first time — a
   * remount always passes a new xterm.js instance's callbacks, and the
   * old instance from the previous mount has already been disposed. Only
   * ever gating callback updates behind the same "already listening?"
   * check as the listener setup left the very first (StrictMode-doomed)
   * instance's callbacks wired up permanently, so output from a real
   * shell went nowhere and the terminal looked dead. */
  openTerminal: (
    terminalId: string,
    onData: (bytes: Uint8Array) => void,
    onExit: (code: number | null) => void,
  ) => void;
  closeSession: (terminalId: string) => void;
  markStarted: (terminalId: string) => void;
}

export const useTerminalSessionStore = create<TerminalSessionState>((set, get) => ({
  byTerminalId: {},
  unlistenByTerminalId: {},

  openTerminal: (terminalId, onData, onExit) => {
    callbacksByTerminalId.set(terminalId, { onData, onExit });
    if (!get().byTerminalId[terminalId]) {
      set((s) => ({
        byTerminalId: { ...s.byTerminalId, [terminalId]: emptyTabState() },
      }));
    }
    if (get().unlistenByTerminalId[terminalId]) return;
    set((s) => ({ unlistenByTerminalId: { ...s.unlistenByTerminalId, [terminalId]: () => {} } }));
    void listenToPtyEvents(terminalId, (event) => {
      // Defensive: a malformed event should be skipped, not crash the
      // whole renderer (see `api/fsEvents.ts`).
      if (!event?.type) return;
      const callbacks = callbacksByTerminalId.get(terminalId);
      if (event.type === "data") {
        const bytes = base64ToBytes(event.base64);
        appendToReplayBuffer(terminalId, bytes);
        callbacks?.onData(bytes);
      } else {
        set((s) => {
          const tab = s.byTerminalId[terminalId] ?? emptyTabState();
          return {
            byTerminalId: { ...s.byTerminalId, [terminalId]: { ...tab, exitCode: event.code } },
          };
        });
        callbacks?.onExit(event.code);
      }
    }).then((unlisten) => {
      set((s) => ({ unlistenByTerminalId: { ...s.unlistenByTerminalId, [terminalId]: unlisten } }));
    });
  },

  closeSession: (terminalId) => {
    get().unlistenByTerminalId[terminalId]?.();
    replayBuffers.delete(terminalId);
    callbacksByTerminalId.delete(terminalId);
    set((s) => {
      const byTerminalId = { ...s.byTerminalId };
      const unlistenByTerminalId = { ...s.unlistenByTerminalId };
      delete byTerminalId[terminalId];
      delete unlistenByTerminalId[terminalId];
      return { byTerminalId, unlistenByTerminalId };
    });
  },

  markStarted: (terminalId) => {
    set((s) => ({
      byTerminalId: {
        ...s.byTerminalId,
        [terminalId]: { ...(s.byTerminalId[terminalId] ?? emptyTabState()), started: true },
      },
    }));
  },
}));
