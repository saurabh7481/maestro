import { create } from "zustand";
import { relayClient } from "../api/client";
import type { ManagedProcess } from "../api/types";

/** The tab dock's contents — every live agent/terminal session across
 * every worktree, polled globally (not just something the user explicitly
 * opened from mobile) so a session started on the desktop, or on another
 * paired device, shows up here on its own within one poll tick. This
 * replaces an earlier design where the dock only held sessions mobile
 * itself had opened — the desktop and mobile must show the same set of
 * "open" sessions to actually be in sync. */
const POLL_INTERVAL_MS = 3000;

interface TabsState {
  sessions: ManagedProcess[];
  activeTabId: string | null;
  setActive: (id: string | null) => void;
  refresh: () => Promise<void>;
}

export const useTabsStore = create<TabsState>((set) => ({
  sessions: [],
  activeTabId: null,

  setActive: (id) => set({ activeTabId: id }),

  refresh: async () => {
    try {
      const sessions = await relayClient.listAllSessions();
      set((s) => ({
        sessions,
        // A session that exited or was killed elsewhere shouldn't leave
        // the shell stuck showing a detail screen for something that no
        // longer exists.
        activeTabId:
          s.activeTabId && !sessions.some((session) => session.id === s.activeTabId)
            ? null
            : s.activeTabId,
      }));
    } catch {
      // Transient network hiccup — keep the last-known list rather than
      // blanking the dock on one failed poll.
    }
  },
}));

let pollHandle: ReturnType<typeof setInterval> | undefined;

/** Started once from `Shell.tsx` — the dock needs live data for as long
 * as the authenticated shell is mounted, not per-screen. */
export function startTabsPolling(): () => void {
  if (pollHandle !== undefined) return () => {};
  void useTabsStore.getState().refresh();
  pollHandle = setInterval(() => void useTabsStore.getState().refresh(), POLL_INTERVAL_MS);
  return () => {
    clearInterval(pollHandle);
    pollHandle = undefined;
  };
}
