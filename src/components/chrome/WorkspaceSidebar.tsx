import { useState } from "react";
import {
  CaretDown,
  CaretLineLeft,
  CaretLineRight,
  CaretRight,
  Folder,
  FolderOpen,
  FolderPlus,
  GitBranch,
  MagnifyingGlass,
  Plus,
  PlusCircle,
} from "@phosphor-icons/react";
import { useUiStore } from "../../state/uiStore";
import { IconButton } from "../primitives";
import styles from "./Sidebar.module.css";

// Placeholder projects/worktrees until Phase 2 wires real git state.
const MOCK_ACTIVE_WORKTREE = "feat/payments-refactor";

export function WorkspaceSidebar() {
  const leftSidebarOpen = useUiStore((s) => s.leftSidebarOpen);
  const toggleLeftSidebar = useUiStore((s) => s.toggleLeftSidebar);
  const [selected, setSelected] = useState(MOCK_ACTIVE_WORKTREE);

  if (!leftSidebarOpen) {
    return (
      <div className={styles.collapsed} data-side="left">
        <IconButton
          icon={CaretLineRight}
          label="Expand workspace"
          size="lg"
          iconSize={19}
          onClick={toggleLeftSidebar}
        />
        <FolderOpen size={19} color="var(--yellow)" />
        <div
          style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: "0.25rem" }}
        >
          <GitBranch size={18} color="var(--accent)" />
          <span className={styles.dot} />
        </div>
      </div>
    );
  }

  return (
    <div className={styles.panel} data-side="left">
      <div className={styles.header}>
        <span className={styles.headerLabel}>Workspace</span>
        <div className={styles.headerActions}>
          <IconButton icon={MagnifyingGlass} label="Search worktrees" size="sm" iconSize={14} />
          <IconButton icon={Plus} label="Add project" size="sm" iconSize={15} />
          <IconButton
            icon={CaretLineLeft}
            label="Collapse"
            size="sm"
            iconSize={15}
            onClick={toggleLeftSidebar}
          />
        </div>
      </div>

      <div className={styles.body}>
        <div className={styles.row}>
          <CaretDown size={11} color="var(--text-mute)" />
          <FolderOpen size={15} color="var(--yellow)" />
          <span className={styles.rowLabel} style={{ fontWeight: "var(--font-weight-semibold)" }}>
            my-app
          </span>
          <span className={styles.rowMeta}>3 wt</span>
        </div>

        <div className={`${styles.row} ${styles.indent1}`}>
          <GitBranch size={14} />
          <span className={styles.rowLabel}>main</span>
        </div>

        <div
          className={`${styles.row} ${styles.indent1}`}
          data-active={selected === "feat/payments-refactor"}
          onClick={() => setSelected("feat/payments-refactor")}
        >
          <GitBranch size={14} color="var(--accent)" />
          <span className={styles.rowLabel} style={{ fontWeight: "var(--font-weight-semibold)" }}>
            feat/payments-refactor
          </span>
          <span className={styles.dot} />
        </div>

        <div
          className={`${styles.row} ${styles.indent1}`}
          data-active={selected === "fix/login-crash"}
          onClick={() => setSelected("fix/login-crash")}
        >
          <GitBranch size={14} />
          <span className={styles.rowLabel}>fix/login-crash</span>
          <span className={styles.rowMeta} style={{ color: "var(--orange)" }}>
            2↑
          </span>
        </div>

        <div className={`${styles.row} ${styles.indent1}`} data-accent="true">
          <PlusCircle size={14} />
          <span className={styles.rowLabel}>New worktree…</span>
        </div>

        <div className={styles.row}>
          <CaretRight size={11} color="var(--text-mute)" />
          <Folder size={15} color="var(--text-mute)" />
          <span className={styles.rowLabel}>design-system</span>
          <span className={styles.rowMeta}>1 wt</span>
        </div>

        <div className={styles.divider} />

        <div className={styles.row} data-accent="true">
          <FolderPlus size={15} />
          <span className={styles.rowLabel}>Add project…</span>
        </div>
      </div>
    </div>
  );
}
