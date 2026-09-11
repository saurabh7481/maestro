import { useEffect } from "react";
import { CaretRight, FolderSimple, GitBranch, Rocket, SignOut, X } from "@phosphor-icons/react";
import { useAuthStore } from "../state/authStore";
import { useWorkspaceStore } from "../state/workspaceStore";

export function Sidebar() {
  const projects = useWorkspaceStore((s) => s.projects);
  const worktreesByProject = useWorkspaceStore((s) => s.worktreesByProject);
  const expandedProjectIds = useWorkspaceStore((s) => s.expandedProjectIds);
  const selectedWorktreeId = useWorkspaceStore((s) => s.selectedWorktreeId);
  const sidebarOpen = useWorkspaceStore((s) => s.sidebarOpen);
  const loadProjects = useWorkspaceStore((s) => s.loadProjects);
  const toggleProject = useWorkspaceStore((s) => s.toggleProject);
  const selectWorktree = useWorkspaceStore((s) => s.selectWorktree);
  const closeSidebar = useWorkspaceStore((s) => s.closeSidebar);
  const logout = useAuthStore((s) => s.logout);

  useEffect(() => {
    loadProjects();
  }, [loadProjects]);

  return (
    <nav className="sidebar" data-open={sidebarOpen || undefined}>
      <div className="sidebar-header">
        <div className="sidebar-brand">
          <Rocket size={16} weight="fill" />
          Maestro
        </div>
        <button type="button" className="sidebar-close" aria-label="Close" onClick={closeSidebar}>
          <X size={16} />
        </button>
      </div>

      <div className="sidebar-tree">
        {projects.map((project) => {
          const expanded = expandedProjectIds.has(project.id);
          const worktrees = worktreesByProject[project.id];
          return (
            <div key={project.id}>
              <button
                type="button"
                className="sidebar-row"
                onClick={() => void toggleProject(project.id)}
              >
                <CaretRight
                  size={12}
                  className="sidebar-caret"
                  data-expanded={expanded || undefined}
                />
                <FolderSimple size={15} weight="fill" className="sidebar-row-icon" />
                <span className="sidebar-row-label">{project.name}</span>
              </button>
              {expanded && (
                <div className="sidebar-children">
                  {worktrees === undefined && <div className="sidebar-loading">Loading…</div>}
                  {worktrees?.map((wt) => (
                    <button
                      key={wt.id}
                      type="button"
                      className="sidebar-row sidebar-row-nested"
                      data-selected={wt.id === selectedWorktreeId || undefined}
                      onClick={() => selectWorktree(project.id, wt.id, wt.branch, wt.path)}
                    >
                      <GitBranch size={13} className="sidebar-row-icon" />
                      <span className="sidebar-row-label">{wt.branch}</span>
                      {wt.dirty && <span className="sidebar-dot" data-tone="yellow" />}
                    </button>
                  ))}
                  {worktrees?.length === 0 && <div className="sidebar-loading">No worktrees</div>}
                </div>
              )}
            </div>
          );
        })}
        {projects.length === 0 && <div className="sidebar-loading">No projects yet</div>}
      </div>

      <div className="sidebar-footer">
        <button type="button" className="sidebar-footer-row" onClick={logout}>
          <SignOut size={15} />
          Sign out
        </button>
      </div>
    </nav>
  );
}
