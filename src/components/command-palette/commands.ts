import { useUiStore } from "../../state/uiStore";
import { useTabsStore } from "../../state/tabsStore";
import { EMPTY_WORKTREES, useActiveWorktree, useWorkspaceStore } from "../../state/workspaceStore";
import { useScmStore } from "../../state/scmStore";
import { useReadyAgentKinds } from "../../state/agentAvailabilityStore";
import {
  goToNextProblem,
  goToPreviousProblem,
  useHasProblems,
} from "../../design/problemNavigation";
import { useFocusRequestStore } from "../../state/focusRequestStore";
import { AGENT_DISPLAY_NAME } from "../../types/agent";
import { clampZoom, ZOOM_DEFAULT, ZOOM_STEP } from "../../design/zoom";
import { THEME_LABELS } from "../../design/themes";
import type { ThemeId } from "../../design/themes";
import type { SplitEdge } from "../../state/paneLayout";
import { detachTabToNewWindow } from "../chrome/satelliteWindows";
import { closeTabs } from "../chrome/TabStrip";
import { openProcessesTab } from "../processes/openProcessesTab";
import { saveAllDirtyTabs } from "../../editor/saveFile";

export interface Command {
  id: string;
  label: string;
  group: string;
  run: () => void;
  /** Set only on `theme.*` commands — the palette live-previews these on
   * highlight rather than waiting for a commit (see `CommandPalette.tsx`). */
  previewTheme?: ThemeId;
}

/** Splits whichever pane currently has focus, moving its active tab into
 * the new one — the palette's equivalent of dragging that tab to the
 * pane's edge (docs/V2_ROADMAP.md Phase 13). */
function splitActivePane(edge: SplitEdge): void {
  const state = useTabsStore.getState();
  const activeTabId = state.activeTabId;
  const pane = Object.values(state.panes).find((candidate) =>
    candidate.tabIds.includes(activeTabId ?? ""),
  );
  if (pane) state.splitPane(pane.id, edge);
}

function useViewCommands(): Command[] {
  const setSidebarView = useUiStore((s) => s.setSidebarView);
  const toggleSidebarView = useUiStore((s) => s.toggleSidebarView);
  const toggleLeftSidebar = useUiStore((s) => s.toggleLeftSidebar);
  const toggleRightSidebar = useUiStore((s) => s.toggleRightSidebar);
  const openQuickOpen = useUiStore((s) => s.openQuickOpen);
  const openSettings = useUiStore((s) => s.openSettings);

  return [
    {
      id: "view.explorer",
      label: "Show Explorer",
      group: "view",
      run: () => setSidebarView("explorer"),
    },
    {
      id: "view.scm",
      label: "Show Source Control",
      group: "view",
      run: () => setSidebarView("scm"),
    },
    {
      id: "view.history",
      label: "Show History",
      group: "view",
      run: () => setSidebarView("history"),
    },
    {
      id: "view.search",
      label: "Show Search",
      group: "view",
      run: () => {
        setSidebarView("search");
        useFocusRequestStore.getState().requestFocus("search");
      },
    },
    {
      id: "view.problems",
      label: "Toggle Problems Panel",
      group: "view",
      run: () => toggleSidebarView("problems"),
    },
    { id: "view.left", label: "Toggle Workspace Sidebar", group: "view", run: toggleLeftSidebar },
    { id: "view.right", label: "Toggle Right Panel", group: "view", run: toggleRightSidebar },
    { id: "nav.quickOpen", label: "Go to File…", group: "navigate", run: openQuickOpen },
    { id: "settings.open", label: "Open Settings", group: "app", run: openSettings },
  ];
}

function useThemeCommands(): Command[] {
  const setTheme = useUiStore((s) => s.setTheme);
  return (Object.keys(THEME_LABELS) as ThemeId[]).map((id) => ({
    id: `theme.${id}`,
    label: `Theme: ${THEME_LABELS[id]}`,
    group: "theme",
    previewTheme: id,
    run: () => setTheme(id),
  }));
}

function useZoomCommands(): Command[] {
  const setZoom = useUiStore((s) => s.setZoom);
  const zoom = useUiStore((s) => s.zoom);
  return [
    {
      id: "zoom.in",
      label: "Zoom In",
      group: "zoom",
      run: () => setZoom(clampZoom(zoom + ZOOM_STEP)),
    },
    {
      id: "zoom.out",
      label: "Zoom Out",
      group: "zoom",
      run: () => setZoom(clampZoom(zoom - ZOOM_STEP)),
    },
    { id: "zoom.reset", label: "Reset Zoom", group: "zoom", run: () => setZoom(ZOOM_DEFAULT) },
  ];
}

function useLayoutCommands(): Command[] {
  return [
    {
      id: "layout.splitRight",
      label: "Split Editor Right",
      group: "layout",
      run: () => splitActivePane("right"),
    },
    {
      id: "layout.splitDown",
      label: "Split Editor Down",
      group: "layout",
      run: () => splitActivePane("bottom"),
    },
    {
      id: "layout.detach",
      label: "Move Tab to New Window",
      group: "layout",
      run: () => {
        const activeTabId = useTabsStore.getState().activeTabId;
        if (activeTabId) void detachTabToNewWindow(activeTabId);
      },
    },
  ];
}

function useTabCommands(): Command[] {
  const closedTabHistory = useTabsStore((s) => s.closedTabHistory);
  const reopenLastClosedTab = useTabsStore((s) => s.reopenLastClosedTab);
  const activeTabId = useTabsStore((s) => s.activeTabId);
  const panes = useTabsStore((s) => s.panes);

  const commands: Command[] = [
    { id: "tab.processes", label: "Open Process Manager", group: "tab", run: openProcessesTab },
    {
      id: "file.saveAll",
      label: "Save All Files",
      group: "tab",
      run: () => void saveAllDirtyTabs(),
    },
  ];
  if (closedTabHistory.length > 0) {
    commands.push({
      id: "tab.reopenClosed",
      label: "Reopen Closed Tab",
      group: "tab",
      run: reopenLastClosedTab,
    });
  }
  const pane = Object.values(panes).find((candidate) =>
    candidate.tabIds.includes(activeTabId ?? ""),
  );
  const othersInPane = pane ? pane.tabIds.filter((id) => id !== activeTabId) : [];
  if (othersInPane.length > 0) {
    commands.push({
      id: "tab.closeOthers",
      label: "Close Other Tabs",
      group: "tab",
      run: () => closeTabs(othersInPane),
    });
  }
  return commands;
}

function useGitCommands(): Command[] {
  const activeWorktree = useActiveWorktree();
  const fetchRemote = useScmStore((s) => s.fetch);
  const pull = useScmStore((s) => s.pull);
  const push = useScmStore((s) => s.push);
  if (!activeWorktree) return [];
  return [
    // Failures surface through the store (the Source Control panel's
    // error card, plus a toast when that panel isn't open), so the
    // rejection is handled there — swallowed here only to keep it from
    // becoming an unhandled promise rejection.
    {
      id: "git.fetch",
      label: "Git: Fetch",
      group: "git",
      run: () => void fetchRemote().catch(() => {}),
    },
    { id: "git.pull", label: "Git: Pull", group: "git", run: () => void pull().catch(() => {}) },
    { id: "git.push", label: "Git: Push", group: "git", run: () => void push().catch(() => {}) },
  ];
}

function useAgentCommands(): Command[] {
  const activeWorktree = useActiveWorktree();
  const openTab = useTabsStore((s) => s.openTab);
  const readyAgentKinds = useReadyAgentKinds();
  if (!activeWorktree) return [];
  const commands: Command[] = [
    {
      id: "tab.terminal",
      label: "New Terminal",
      group: "tab",
      run: () =>
        openTab({
          id: crypto.randomUUID(),
          type: "terminal",
          title: `Terminal — ${activeWorktree.branch}`,
          worktreeRoot: activeWorktree.path,
        }),
    },
  ];
  for (const kind of readyAgentKinds) {
    commands.push({
      id: `tab.agent.${kind}`,
      label: `New ${AGENT_DISPLAY_NAME[kind]} Session`,
      group: "tab",
      run: () =>
        openTab({
          id: crypto.randomUUID(),
          type: "agent",
          title: AGENT_DISPLAY_NAME[kind],
          agentKind: kind,
          worktreeId: activeWorktree.id,
          worktreeRoot: activeWorktree.path,
        }),
    });
  }
  commands.push({
    id: "composer.focus",
    label: "Focus Chat Composer",
    group: "tab",
    run: () => {
      const active = useTabsStore
        .getState()
        .tabs.find((t) => t.id === useTabsStore.getState().activeTabId);
      if (active?.type === "agent") useFocusRequestStore.getState().requestFocus(active.id);
    },
  });
  return commands;
}

/** One command per sibling worktree in the active project — the active
 * worktree itself is left out, matching how a "switch to" list never
 * offers switching to where you already are. */
function useWorktreeCommands(): Command[] {
  const activeProjectId = useWorkspaceStore((s) => s.activeProjectId);
  const activeWorktreeId = useWorkspaceStore((s) => s.activeWorktreeId);
  const worktrees = useWorkspaceStore((s) =>
    activeProjectId ? (s.worktreesByProject[activeProjectId] ?? EMPTY_WORKTREES) : EMPTY_WORKTREES,
  );
  const selectWorktree = useWorkspaceStore((s) => s.selectWorktree);
  if (!activeProjectId) return [];
  return worktrees
    .filter((w) => w.id !== activeWorktreeId)
    .map((w) => ({
      id: `worktree.switch.${w.id}`,
      label: `Switch to Worktree: ${w.branch}`,
      group: "worktree",
      run: () => selectWorktree(activeProjectId, w.id),
    }));
}

function useProblemsCommands(): Command[] {
  const activeWorktree = useActiveWorktree();
  const hasProblems = useHasProblems();
  if (!activeWorktree || !hasProblems) return [];
  return [
    {
      id: "problems.next",
      label: "Next Problem",
      group: "problems",
      run: () => goToNextProblem(activeWorktree),
    },
    {
      id: "problems.previous",
      label: "Previous Problem",
      group: "problems",
      run: () => goToPreviousProblem(activeWorktree),
    },
  ];
}

export function useCommands(): Command[] {
  return [
    ...useViewCommands(),
    ...useThemeCommands(),
    ...useZoomCommands(),
    ...useLayoutCommands(),
    ...useTabCommands(),
    ...useGitCommands(),
    ...useAgentCommands(),
    ...useWorktreeCommands(),
    ...useProblemsCommands(),
  ];
}
