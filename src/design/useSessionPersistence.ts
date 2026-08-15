import { useEffect, useRef, useState } from "react";
import { useWorkspaceStore } from "../state/workspaceStore";
import { useTabsStore } from "../state/tabsStore";
import { loadSessionPrefs, saveSessionPrefs } from "./persistence";
import type { SessionPrefs } from "./persistence";

/** Restores open tabs and the active project/worktree from the previous
 * session, then keeps persisting both on every change so the *next*
 * launch has something to restore from (docs/CHECKLIST.md Phase 8: "Full
 * tab/window state persisted and restored across restart"). Window
 * geometry itself is already handled separately by
 * `tauri-plugin-window-state`; this covers what that plugin doesn't know
 * about — which worktree was active, which tabs were open, and which tab
 * was active *within* each worktree (`tabsStore.ts`'s
 * `activeTabIdByWorktree` — tabs are per-worktree, see
 * `chrome/AppShell.tsx`'s `useWorktreeTabSync` for why that's not
 * optional).
 *
 * Restoring needs the *real* worktree list (to check a persisted
 * selection/tab still points at something that exists — the "deleted
 * worktree that was open" edge case), so it waits for
 * `workspaceStore`'s `loadAll()` to finish at least once. The disk read
 * itself is kicked off immediately on mount rather than only once
 * `loaded` flips, so it overlaps with `loadAll()`'s IPC round-trips
 * instead of adding to them serially. */
export function useSessionPersistence(): void {
  const loaded = useWorkspaceStore((s) => s.loaded);
  const [restoreDone, setRestoreDone] = useState(false);
  const prefsPromise = useRef<Promise<SessionPrefs | null>>(loadSessionPrefs());
  const started = useRef(false);

  useEffect(() => {
    if (!loaded || started.current) return;
    started.current = true;

    void prefsPromise.current.then((prefs) => {
      if (prefs) {
        const { worktreesByProject, selectWorktree } = useWorkspaceStore.getState();
        const allWorktrees = Object.values(worktreesByProject).flat();
        const validWorktreeIds = new Set(allWorktrees.map((w) => w.id));
        const validWorktreeRoots = new Set(allWorktrees.map((w) => w.path));

        if (
          prefs.activeProjectId &&
          prefs.activeWorktreeId &&
          (worktreesByProject[prefs.activeProjectId] ?? []).some(
            (w) => w.id === prefs.activeWorktreeId,
          )
        ) {
          selectWorktree(prefs.activeProjectId, prefs.activeWorktreeId);
        }

        // A tab whose worktree no longer exists points at nothing —
        // dropped rather than left to error out when opened.
        const restorableTabs = prefs.tabs.filter((tab) => {
          if (tab.worktreeId && !validWorktreeIds.has(tab.worktreeId)) return false;
          if (tab.worktreeRoot && !validWorktreeRoots.has(tab.worktreeRoot)) return false;
          return true;
        });
        if (restorableTabs.length > 0) {
          const restoredIds = new Set(restorableTabs.map((t) => t.id));
          const activeTabIdByWorktree = Object.fromEntries(
            Object.entries(prefs.activeTabIdByWorktree ?? {}).filter(
              ([root, id]) => validWorktreeRoots.has(root) && !!id && restoredIds.has(id),
            ),
          );
          useTabsStore.setState({ tabs: restorableTabs, activeTabIdByWorktree });
        }

        // Sync the tab strip to whichever worktree actually ended up
        // active (the persisted selection above, or `loadAll()`'s own
        // default if that one no longer exists) *directly*, rather than
        // relying on `useWorktreeTabSync`'s effect to notice — if the
        // persisted worktree happens to be the same one `loadAll()`
        // already defaulted to, `activeWorktree` never changes, so that
        // effect wouldn't re-fire now that tabs actually exist to show.
        const current = useWorkspaceStore.getState();
        const activeRoot = current.activeProjectId
          ? (worktreesByProject[current.activeProjectId]?.find(
              (w) => w.id === current.activeWorktreeId,
            )?.path ?? null)
          : null;
        useTabsStore.getState().switchToWorktree(activeRoot);
      }
      setRestoreDone(true);
    });
  }, [loaded]);

  const tabs = useTabsStore((s) => s.tabs);
  const activeTabIdByWorktree = useTabsStore((s) => s.activeTabIdByWorktree);
  const activeProjectId = useWorkspaceStore((s) => s.activeProjectId);
  const activeWorktreeId = useWorkspaceStore((s) => s.activeWorktreeId);

  useEffect(() => {
    // Gated on the restore having actually run first — otherwise the
    // still-empty startup state would race the restore and overwrite the
    // very session this hook is meant to bring back.
    if (!restoreDone) return;
    void saveSessionPrefs({ activeProjectId, activeWorktreeId, tabs, activeTabIdByWorktree });
  }, [restoreDone, tabs, activeTabIdByWorktree, activeProjectId, activeWorktreeId]);
}
