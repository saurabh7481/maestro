import { create } from "zustand";
import type { ToastTone } from "./toastStore";

export interface NotificationEntry {
  id: string;
  tone: ToastTone;
  title: string;
  description?: string;
  timestamp: number;
  /** The run this notification is about, if any — the bell popover
   * (`NotificationPopover.tsx`) uses this to jump to that tab on click. */
  runId?: string;
}

/** Well past what anyone scrolls back through by hand — same reasoning as
 * `terminalPrefs.ts`'s scrollback cap, just for a much smaller per-entry
 * cost. Not persisted across restarts, matching `toastStore.ts`'s own
 * ephemeral, session-scoped stance. */
const MAX_ENTRIES = 50;

interface NotificationHistoryState {
  entries: NotificationEntry[];
  unreadCount: number;
  push: (entry: Omit<NotificationEntry, "id" | "timestamp">) => void;
  markAllRead: () => void;
  clear: () => void;
}

/** The log a toast disappears into — `agentSessionStore.ts`'s
 * `notifyIfBackgrounded` pushes here every time it also pushes a toast, so
 * the status-bar bell (`NotificationPopover.tsx`) can show what happened
 * while the user wasn't looking, not just whatever toast was on screen
 * for its few seconds. */
export const useNotificationHistoryStore = create<NotificationHistoryState>((set) => ({
  entries: [],
  unreadCount: 0,

  push: (entry) =>
    set((s) => ({
      entries: [{ ...entry, id: crypto.randomUUID(), timestamp: Date.now() }, ...s.entries].slice(
        0,
        MAX_ENTRIES,
      ),
      unreadCount: s.unreadCount + 1,
    })),

  markAllRead: () => set({ unreadCount: 0 }),
  clear: () => set({ entries: [], unreadCount: 0 }),
}));
