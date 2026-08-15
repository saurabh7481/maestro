import { create } from "zustand";
import { listenToPtyEvents } from "../api/terminal";

const MAX_BUFFER_BYTES = 2_000_000;

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

interface TerminalTabState {
  chunks: Uint8Array[];
  bufferedBytes: number;
  exitCode: number | null;
  started: boolean;
}

function emptyTabState(): TerminalTabState {
  return { chunks: [], bufferedBytes: 0, exitCode: null, started: false };
}

interface TerminalCallbacks {
  onData: (bytes: Uint8Array) => void;
  onExit: (code: number | null) => void;
}

interface TerminalSessionState {
  byTerminalId: Record<string, TerminalTabState>;
  unlistenByTerminalId: Record<string, () => void>;
  /** The live xterm.js instance's callbacks for each terminal, kept
   * separate from the idempotent listener-setup below (see `openTerminal`
   * for why). */
  callbacksByTerminalId: Record<string, TerminalCallbacks>;

  /** Sets up the `pty://{terminalId}/data` listener once per terminal and
   * buffers output so a remounted `TerminalTab` (switching tabs away and
   * back unmounts it — see `MainContent.tsx` — and so does React
   * StrictMode's dev-mode double-invoke of this effect) can replay
   * scrollback into a fresh xterm.js instance instead of coming back
   * blank.
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
  callbacksByTerminalId: {},

  openTerminal: (terminalId, onData, onExit) => {
    set((s) => ({
      byTerminalId: {
        ...s.byTerminalId,
        [terminalId]: s.byTerminalId[terminalId] ?? emptyTabState(),
      },
      callbacksByTerminalId: { ...s.callbacksByTerminalId, [terminalId]: { onData, onExit } },
    }));
    if (get().unlistenByTerminalId[terminalId]) return;
    set((s) => ({ unlistenByTerminalId: { ...s.unlistenByTerminalId, [terminalId]: () => {} } }));
    void listenToPtyEvents(terminalId, (event) => {
      // Defensive: a malformed event should be skipped, not crash the
      // whole renderer (see `api/fsEvents.ts`).
      if (!event?.type) return;
      const callbacks = get().callbacksByTerminalId[terminalId];
      if (event.type === "data") {
        const bytes = base64ToBytes(event.base64);
        set((s) => {
          const tab = s.byTerminalId[terminalId] ?? emptyTabState();
          const chunks = [...tab.chunks, bytes];
          let bufferedBytes = tab.bufferedBytes + bytes.length;
          while (bufferedBytes > MAX_BUFFER_BYTES && chunks.length > 1) {
            bufferedBytes -= chunks.shift()!.length;
          }
          return {
            byTerminalId: { ...s.byTerminalId, [terminalId]: { ...tab, chunks, bufferedBytes } },
          };
        });
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
    set((s) => {
      const byTerminalId = { ...s.byTerminalId };
      const unlistenByTerminalId = { ...s.unlistenByTerminalId };
      const callbacksByTerminalId = { ...s.callbacksByTerminalId };
      delete byTerminalId[terminalId];
      delete unlistenByTerminalId[terminalId];
      delete callbacksByTerminalId[terminalId];
      return { byTerminalId, unlistenByTerminalId, callbacksByTerminalId };
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
