import { useEffect, useState } from "react";
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
  Trash,
  X,
} from "@phosphor-icons/react";
import { useUiStore } from "../../state/uiStore";
import { useWorkspaceStore } from "../../state/workspaceStore";
import type { Project, Worktree } from "../../types/workspace";
import { IconButton } from "../primitives";
import { NewWorktreeDialog } from "../workspace/NewWorktreeDialog";
import { RemoveWorktreeDialog } from "../workspace/RemoveWorktreeDialog";
import styles from "./Sidebar.module.css";

function WorktreeRow({ project, worktree }: { project: Project; worktree: Worktree }) {
  const activeWorktreeId = useWorkspaceStore((s) => s.activeWorktreeId);
  const selectWorktree = useWorkspaceStore((s) => s.selectWorktree);
  const [confirmingRemove, setConfirmingRemove] = useState(false);
  const isActive = worktree.id === activeWorktreeId;

  return (
    <>
      <div
        className={`${styles.row} ${styles.indent1}`}
        data-active={isActive}
        onClick={() => selectWorktree(project.id, worktree.id)}
      >
        <GitBranch size={14} color={isActive ? "var(--accent)" : undefined} />
        <span
          className={styles.rowLabel}
          style={isActive ? { fontWeight: "var(--font-weight-semibold)" } : undefined}
        >
          {worktree.branch}
        </span>
        {(worktree.ahead > 0 || worktree.behind > 0) && (
          <span className={styles.rowMeta} style={{ color: "var(--orange)" }}>
            {worktree.ahead > 0 && `${worktree.ahead}↑`}
            {worktree.behind > 0 && `${worktree.behind}↓`}
          </span>
        )}
        {!worktree.isPrimary && (
          <IconButton
            icon={Trash}
            label="Remove worktree"
            size="sm"
            iconSize={12}
            className={styles.rowAction}
            onClick={(e) => {
              e.stopPropagation();
              setConfirmingRemove(true);
            }}
          />
        )}
        {isActive && <span className={styles.dot} />}
      </div>
      {confirmingRemove && (
        <RemoveWorktreeDialog
          worktree={worktree}
          onOpenChange={(open) => !open && setConfirmingRemove(false)}
        />
      )}
    </>
  );
}

function ProjectSection({
  project,
  collapsed,
  onToggleCollapsed,
}: {
  project: Project;
  collapsed: boolean;
  onToggleCollapsed: () => void;
}) {
  const worktrees = useWorkspaceStore((s) => s.worktreesByProject[project.id] ?? []);
  const removeProject = useWorkspaceStore((s) => s.removeProject);
  const [newWorktreeOpen, setNewWorktreeOpen] = useState(false);

  return (
    <>
      <div className={styles.row} onClick={onToggleCollapsed}>
        {collapsed ? (
          <CaretRight size={11} color="var(--text-mute)" />
        ) : (
          <CaretDown size={11} color="var(--text-mute)" />
        )}
        {collapsed ? (
          <Folder size={15} color="var(--text-mute)" />
        ) : (
          <FolderOpen size={15} color="var(--yellow)" />
        )}
        <span className={styles.rowLabel} style={{ fontWeight: "var(--font-weight-semibold)" }}>
          {project.name}
        </span>
        <IconButton
          icon={Trash}
          label="Remove project"
          size="sm"
          iconSize={12}
          className={styles.rowAction}
          onClick={(e) => {
            e.stopPropagation();
            void removeProject(project.id);
          }}
        />
        <span className={styles.rowMeta}>{worktrees.length} wt</span>
      </div>

      {!collapsed && (
        <>
          {worktrees.map((wt) => (
            <WorktreeRow key={wt.id} project={project} worktree={wt} />
          ))}
          <div
            className={`${styles.row} ${styles.indent1}`}
            data-accent="true"
            onClick={() => setNewWorktreeOpen(true)}
          >
            <PlusCircle size={14} />
            <span className={styles.rowLabel}>New worktree…</span>
          </div>
        </>
      )}

      <NewWorktreeDialog
        open={newWorktreeOpen}
        onOpenChange={setNewWorktreeOpen}
        projectId={project.id}
      />
    </>
  );
}

export function WorkspaceSidebar() {
  const leftSidebarOpen = useUiStore((s) => s.leftSidebarOpen);
  const toggleLeftSidebar = useUiStore((s) => s.toggleLeftSidebar);
  const projects = useWorkspaceStore((s) => s.projects);
  const loadAll = useWorkspaceStore((s) => s.loadAll);
  const addProject = useWorkspaceStore((s) => s.addProject);
  const error = useWorkspaceStore((s) => s.error);
  const clearError = useWorkspaceStore((s) => s.clearError);
  const activeProject = useWorkspaceStore((s) =>
    s.projects.find((p) => p.id === s.activeProjectId),
  );
  const activeWorktree = useWorkspaceStore((s) => {
    if (!s.activeProjectId || !s.activeWorktreeId) return undefined;
    return s.worktreesByProject[s.activeProjectId]?.find((w) => w.id === s.activeWorktreeId);
  });
  const [collapsedProjectIds, setCollapsedProjectIds] = useState<Set<string>>(new Set());

  useEffect(() => {
    void loadAll();
    // Reconciles against `git worktree list` on next focus — catches
    // worktrees created/removed via a plain `git` command in a terminal
    // while Maestro was in the background (docs/CHECKLIST.md Phase 2).
    function onFocus() {
      void loadAll();
    }
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function toggleProjectCollapsed(projectId: string) {
    setCollapsedProjectIds((prev) => {
      const next = new Set(prev);
      if (next.has(projectId)) next.delete(projectId);
      else next.add(projectId);
      return next;
    });
  }

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
        {activeProject && <FolderOpen size={19} color="var(--yellow)" />}
        {activeWorktree && (
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              gap: "0.25rem",
            }}
          >
            <GitBranch size={18} color="var(--accent)" />
            <span className={styles.dot} />
          </div>
        )}
      </div>
    );
  }

  return (
    <div className={styles.panel} data-side="left">
      <div className={styles.header}>
        <span className={styles.headerLabel}>Workspace</span>
        <div className={styles.headerActions}>
          <IconButton icon={MagnifyingGlass} label="Search worktrees" size="sm" iconSize={14} />
          <IconButton
            icon={Plus}
            label="Add project"
            size="sm"
            iconSize={15}
            onClick={() => void addProject()}
          />
          <IconButton
            icon={CaretLineLeft}
            label="Collapse"
            size="sm"
            iconSize={15}
            onClick={toggleLeftSidebar}
          />
        </div>
      </div>

      {error && (
        <div
          style={{
            display: "flex",
            alignItems: "flex-start",
            gap: "0.5rem",
            margin: "0 0.75rem 0.5rem",
            padding: "0.5rem 0.625rem",
            borderRadius: "var(--radius-md)",
            background: "rgba(224,108,117,.1)",
            border: "1px solid rgba(224,108,117,.3)",
            color: "var(--red)",
            fontSize: "var(--text-xs)",
          }}
        >
          <span style={{ flex: 1 }}>{error}</span>
          <X size={12} style={{ cursor: "pointer", flexShrink: 0 }} onClick={clearError} />
        </div>
      )}

      <div className={styles.body}>
        {projects.map((project) => (
          <ProjectSection
            key={project.id}
            project={project}
            collapsed={collapsedProjectIds.has(project.id)}
            onToggleCollapsed={() => toggleProjectCollapsed(project.id)}
          />
        ))}

        {projects.length === 0 && (
          <div
            style={{ padding: "0.75rem", color: "var(--text-mute)", fontSize: "var(--text-sm)" }}
          >
            No projects yet — add a local git repository to get started.
          </div>
        )}

        <div className={styles.divider} />

        <div className={styles.row} data-accent="true" onClick={() => void addProject()}>
          <FolderPlus size={15} />
          <span className={styles.rowLabel}>Add project…</span>
        </div>
      </div>
    </div>
  );
}
