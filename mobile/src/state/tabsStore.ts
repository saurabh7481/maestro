import { create } from "zustand";
import { relayClient } from "../api/client";
import { openStream } from "../api/stream";
import type { ManagedProcess } from "../api/types";

/** The tab dock's contents — every live agent/terminal session across
 * every worktree, polled globally (not just something the user explicitly
 * opened from mobile) so a session started on the desktop, or on another
 * paired device, shows up here on its own within one poll tick. This
 * replaces an earlier design where the dock only held sessions mobile
 * itself had opened — the desktop and mobile must show the same set of
 * "open" sessions to actually be in sync. */
/// The list is pushed on `/api/sessions/stream` the moment anything about
/// it changes, so this poll is now only a reconcile — it exists to heal a
/// client whose socket died without its `onclose` firing, not to deliver
/// updates. Hence far slower than the 3s it used to need: at that rate a
/// session that started and finished between two ticks was never seen at
/// all, and a generated title appeared a poll late.
const RECONCILE_INTERVAL_MS = 30_000;

interface TabsState {
  sessions: ManagedProcess[];
  activeTabId: string | null;
  /** Bumped on every pushed list, so a slower reconcile can tell its
   * response has been overtaken. */
  pushRevision: number;
  setActive: (id: string | null) => void;
  /** Replaces the list wholesale — the shape both the pushed frame and the
   * reconcile poll deliver. Whole-state rather than deltas on purpose: a
   * dropped or reordered delta would leave the dock subtly wrong forever,
   * which is the class of bug this stream exists to remove. */
  applySessions: (sessions: ManagedProcess[]) => void;
  refresh: () => Promise<void>;
}

export const useTabsStore = create<TabsState>((set, get) => ({
  sessions: [],
  activeTabId: null,
  pushRevision: 0,

  setActive: (id) => set({ activeTabId: id }),

  applySessions: (sessions) =>
    set((s) => ({
      sessions,
      pushRevision: s.pushRevision + 1,
      activeTabId:
        s.activeTabId && !sessions.some((session) => session.id === s.activeTabId)
          ? null
          : s.activeTabId,
    })),

  refresh: async () => {
    // A reconcile that started before a push must never land after it: the
    // response is older than what the stream already delivered, and
    // applying it would flick the dock back to a stale list. Captured
    // before the await, checked after.
    const startedAt = get().pushRevision;
    try {
      const sessions = await relayClient.listAllSessions();
      if (get().pushRevision !== startedAt) return;
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
let closeStream: (() => void) | undefined;

/** Started once from `Shell.tsx` — the dock needs live data for as long as
 * the authenticated shell is mounted, not per-screen.
 *
 * Subscribes to the pushed session list and keeps a slow reconcile poll
 * behind it. The stream is the delivery mechanism; the poll only heals a
 * client whose socket died silently. */
export function startTabsPolling(): () => void {
  if (pollHandle !== undefined) return () => {};

  closeStream = openStream("/api/sessions/stream", (raw) => {
    try {
      const frame = JSON.parse(raw) as { sessions?: ManagedProcess[] };
      if (Array.isArray(frame.sessions)) useTabsStore.getState().applySessions(frame.sessions);
    } catch {
      // A malformed frame is skipped; the reconcile poll covers it.
    }
  });

  void useTabsStore.getState().refresh();
  pollHandle = setInterval(() => void useTabsStore.getState().refresh(), RECONCILE_INTERVAL_MS);
  return () => {
    clearInterval(pollHandle);
    pollHandle = undefined;
    closeStream?.();
    closeStream = undefined;
  };
}
