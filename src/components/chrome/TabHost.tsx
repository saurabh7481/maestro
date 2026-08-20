import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTabsStore, type Tab } from "../../state/tabsStore";
import { usePaneSlotStore } from "../../state/paneSlotStore";
import styles from "./TabHost.module.css";

/* Both are lazy for bundle reasons, matching `PaneView`'s treatment of
 * `MonacoHost`/`DiffView`. `TerminalTab` in particular drags in `@xterm/xterm`
 * plus `xterm.css` — roughly 250 KB of JS and the single largest block of
 * the eager stylesheet — none of which the app shell needs to reach first
 * paint (docs/PERFORMANCE_AUDIT.md §1.4). */
const AgentTab = lazy(() =>
  import("../agent/AgentTab").then((module) => ({ default: module.AgentTab })),
);
const TerminalTab = lazy(() =>
  import("../terminal/TerminalTab").then((module) => ({ default: module.TerminalTab })),
);

/** How many process-backed tabs stay mounted at once, most-recently-used
 * first. Mounted tabs cost real resident memory — an xterm.js cell buffer,
 * or an agent transcript's DOM — so this is a budget, not a promise that
 * every open tab stays live. Anything evicted past this rebuilds on its
 * next activation exactly the way every tab used to, which is the one case
 * `terminalSessionStore`'s replay buffer still exists to cover.
 *
 * Every *visible* tab is mounted regardless of the budget: with splits,
 * more than one process tab can be on screen at once, and a visible-but-
 * unmounted pane would just be blank. */
const MAX_MOUNTED = 6;

function isProcessBacked(tab: Tab): boolean {
  return tab.type === "agent" || (tab.type === "terminal" && !!tab.worktreeRoot);
}

/** Keeps agent and terminal tabs mounted while they're open, showing only
 * the ones that are active in their pane, instead of mounting solely the
 * active tab and destroying it on every switch.
 *
 * `MainContent` used to render these as `activeTab?.type === "agent" &&
 * <AgentTab …>`, so switching tabs disposed the xterm.js instance and
 * unmounted the whole agent transcript; coming back re-instantiated xterm,
 * replayed its entire buffer, and rebuilt every transcript node from
 * scratch. That was the single largest contributor to tab switching
 * feeling slow (docs/PERFORMANCE_AUDIT.md §1.2).
 *
 * Multi-pane (docs/V2_ROADMAP.md Phase 13) makes "where does this tab
 * render" a moving target, so each mounted tab owns a plain `div` that
 * this component creates once and then *moves* into whichever pane's slot
 * currently owns the tab (`state/paneSlotStore.ts`). Moving a DOM node
 * with `appendChild` doesn't disturb React at all — the portal's container
 * element is unchanged, so the tab survives being dragged to another pane,
 * or its worktree going into the background, without remounting. Passing
 * the pane's slot element straight to `createPortal` would *not*: React
 * treats a different container as a different portal and remounts its
 * whole subtree.
 *
 * The backend processes were never tied to mount state (they live in
 * `AppState.terminals`/`AppState.agent_runs` and are torn down by
 * `TabStrip`'s close handler), so nothing about process lifetime changes
 * here. */
export function TabHost() {
  const tabs = useTabsStore((s) => s.tabs);
  const panes = useTabsStore((s) => s.panes);
  const parkingRef = useRef<HTMLDivElement>(null);

  const processTabs = useMemo(() => tabs.filter(isProcessBacked), [tabs]);
  const liveIds = useMemo(() => new Set(processTabs.map((t) => t.id)), [processTabs]);

  /** Which pane holds each process tab, and whether it's the one that
   * pane is currently showing. */
  const placement = useMemo(() => {
    const map = new Map<string, { paneId: string; active: boolean }>();
    for (const pane of Object.values(panes)) {
      for (const tabId of pane.tabIds) {
        if (liveIds.has(tabId)) {
          map.set(tabId, { paneId: pane.id, active: pane.activeTabId === tabId });
        }
      }
    }
    return map;
  }, [panes, liveIds]);

  const [mountedIds, setMountedIds] = useState<string[]>([]);

  // Derived during render rather than in an effect: an effect would leave
  // a newly-activated tab unmounted for a frame, which reads as a blank
  // flash on every switch to a tab that isn't mounted yet — precisely the
  // problem this component exists to remove. React's documented
  // "adjusting state during render" pattern; `nextMounted` is what this
  // pass renders, so the first pass is already correct.
  const visibleIds = useMemo(
    () => processTabs.filter((tab) => placement.get(tab.id)?.active).map((tab) => tab.id),
    [processTabs, placement],
  );

  let nextMounted = [...visibleIds, ...mountedIds.filter((id) => liveIds.has(id))].filter(
    (id, index, all) => all.indexOf(id) === index,
  );
  const budget = Math.max(MAX_MOUNTED, visibleIds.length);
  if (nextMounted.length > budget) nextMounted = nextMounted.slice(0, budget);

  const changed =
    nextMounted.length !== mountedIds.length ||
    nextMounted.some((id, index) => id !== mountedIds[index]);
  if (changed) setMountedIds(nextMounted);

  const tabsById = useMemo(() => new Map(processTabs.map((t) => [t.id, t])), [processTabs]);

  return (
    <>
      {/* Where a mounted tab's container waits while it has no pane to
          live in — a background worktree's tabs, or the instant between a
          pane collapsing and its tabs landing somewhere else. Hidden, but
          still in the document, so the components inside stay mounted. */}
      <div ref={parkingRef} className={styles.parking} aria-hidden />
      {nextMounted.map((id) => {
        const tab = tabsById.get(id);
        const where = placement.get(id);
        if (!tab) return null;
        return (
          <MountedTab
            key={id}
            tab={tab}
            paneId={where?.paneId}
            active={where?.active ?? false}
            parkingRef={parkingRef}
          />
        );
      })}
    </>
  );
}

function MountedTab({
  tab,
  paneId,
  active,
  parkingRef,
}: {
  tab: Tab;
  paneId: string | undefined;
  active: boolean;
  parkingRef: React.RefObject<HTMLDivElement | null>;
}) {
  const slot = usePaneSlotStore((s) => (paneId ? s.slots[paneId] : undefined));

  // One container per tab, created once and reused for the tab's whole
  // life — this is the element the portal is bound to, and the reason
  // moving a tab between panes doesn't remount it.
  const container = useMemo(() => {
    const element = document.createElement("div");
    element.style.position = "absolute";
    element.style.inset = "0";
    // Transparent to the pointer; the visible slot inside re-enables it,
    // so a hidden tab's container never intercepts clicks meant for the
    // editor underneath.
    element.style.pointerEvents = "none";
    return element;
  }, []);

  useEffect(() => {
    const parent = slot ?? parkingRef.current;
    if (parent && container.parentElement !== parent) parent.appendChild(container);
  }, [slot, container, parkingRef]);

  useEffect(() => {
    return () => container.remove();
  }, [container]);

  // `active` alone is only "the active tab of its *own* pane" — a pane
  // keeps that state even while its whole worktree is in the background
  // (switching worktrees doesn't destroy the other worktrees' panes, only
  // stops rendering them), so a background worktree's active agent tab
  // still had `active=true` reach it here despite being parked in the
  // hidden container above, not shown in any on-screen slot. `AgentTab`'s
  // Esc-to-stop effect trusts this `active` prop to mean "the tab the user
  // is actually looking at" — without `slot != null`, an Esc press while
  // viewing a *different* worktree could still stop that background run.
  const visible = active && slot != null;

  return createPortal(
    <div
      className={visible ? styles.slot : `${styles.slot} ${styles.slotHidden}`}
      // Hidden slots are inert to assistive tech and to find-in-page for
      // the same reason they're `display: none` visually — they are
      // background tabs, not hidden UI on the current screen.
      aria-hidden={visible ? undefined : true}
    >
      {/* One boundary per slot, not one around the whole list — a
          suspending background tab must not blank the visible one. */}
      <Suspense fallback={null}>
        {tab.type === "agent" ? (
          <AgentTab tab={tab} active={visible} />
        ) : (
          <TerminalTab tab={tab} active={visible} />
        )}
      </Suspense>
    </div>,
    container,
  );
}
