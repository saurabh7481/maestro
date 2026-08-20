import {
  ClockCounterClockwise,
  Files,
  GearSix,
  GitBranch,
  MagnifyingGlass,
  SidebarSimple,
  Sparkle,
  WarningCircle,
} from "@phosphor-icons/react";
import type { Icon } from "@phosphor-icons/react";
import { useUiStore, type SidebarView } from "../../state/uiStore";
import { useScmStore } from "../../state/scmStore";
import { useActiveWorktree } from "../../state/workspaceStore";
import {
  problemsForWorktree,
  summarizeProblems,
  useProblemsStore,
} from "../../state/problemsStore";
import { IconButton } from "../primitives";
import styles from "./ActivityRail.module.css";

interface RailItem {
  id: SidebarView;
  icon: Icon;
  label: string;
  badge?: number;
}

export function ActivityRail() {
  const sidebarView = useUiStore((s) => s.sidebarView);
  const toggleSidebarView = useUiStore((s) => s.toggleSidebarView);
  const rightSidebarOpen = useUiStore((s) => s.rightSidebarOpen);
  const toggleRightSidebar = useUiStore((s) => s.toggleRightSidebar);
  const openSettings = useUiStore((s) => s.openSettings);
  const changedFileCount = useScmStore((s) => s.status?.entries.length ?? 0);
  const activeWorktree = useActiveWorktree();
  const problemsByOwner = useProblemsStore((state) => state.byOwner);
  const problemCount = summarizeProblems(
    problemsForWorktree(problemsByOwner, activeWorktree?.id),
  ).total;

  const RAIL_ITEMS: RailItem[] = [
    { id: "explorer", icon: Files, label: "Explorer" },
    {
      id: "scm",
      icon: GitBranch,
      label: "Source Control",
      badge: changedFileCount > 0 ? changedFileCount : undefined,
    },
    { id: "agentChanges", icon: Sparkle, label: "Agent Changes" },
    { id: "history", icon: ClockCounterClockwise, label: "History" },
    { id: "search", icon: MagnifyingGlass, label: "Search" },
    {
      id: "problems",
      icon: WarningCircle,
      label: "Problems",
      badge: problemCount > 0 ? problemCount : undefined,
    },
  ];

  return (
    <div className={styles.rail}>
      <IconButton
        icon={SidebarSimple}
        label="Toggle panel"
        size="lg"
        iconSize={19}
        active={rightSidebarOpen}
        style={{ transform: "scaleX(-1)" }}
        onClick={toggleRightSidebar}
      />

      <div className={styles.divider} />

      {/* The active marker tracks what's *showing*, not what's merely
          selected — a lit icon next to a collapsed panel read as a
          broken toggle. */}
      {RAIL_ITEMS.map((item) => {
        const showing = rightSidebarOpen && sidebarView === item.id;
        return (
          <div key={item.id} className={styles.item}>
            <span className={styles.indicator} data-active={showing} />
            <IconButton
              icon={item.icon}
              label={showing ? `Hide ${item.label}` : item.label}
              size="lg"
              iconSize={20}
              active={showing}
              badge={item.badge}
              onClick={() => toggleSidebarView(item.id)}
            />
          </div>
        );
      })}

      <div className={styles.spacer} />

      <IconButton icon={GearSix} label="Settings" size="lg" iconSize={22} onClick={openSettings} />
    </div>
  );
}
