import { create } from "zustand";
import { relayClient } from "../api/client";
import type { Project, Worktree } from "../api/types";

/** Drives the sidebar's project/worktree tree. Replaces the old
 * push/pop screen stack (`nav.ts`, now removed) — picking a worktree here
 * is a selection, not a navigation event, so switching worktrees no longer
 * costs a round trip back through "Projects → Worktrees" each time (the
 * UX complaint this store exists to fix). */

interface WorkspaceState {
  projects: Project[];
  worktreesByProject: Record<string, Worktree[]>;
  expandedProjectIds: Set<string>;
  selectedProjectId: string | null;
  selectedWorktreeId: string | null;
  selectedWorktreeLabel: string | null;
  /** The worktree's checked-out path — what session filtering keys on
   * (`ManagedProcess.worktreeRoot`), not `selectedWorktreeId`: a terminal
   * session's `worktreeId` is always `null` (`processes.rs` never tracks
   * one for a PTY), so id-based filtering silently dropped every terminal
   * from both the dock and the sessions list. */
  selectedWorktreeRoot: string | null;
  loading: boolean;
  error: string | null;
  /** Off-canvas on narrow viewports; CSS forces it visible on wide ones
   * regardless of this flag (see `app.css`'s `.sidebar` media query). */
  sidebarOpen: boolean;

  loadProjects: () => Promise<void>;
  toggleProject: (projectId: string) => Promise<void>;
  selectWorktree: (projectId: string, worktreeId: string, label: string, root: string) => void;
  openSidebar: () => void;
  closeSidebar: () => void;
}

export const useWorkspaceStore = create<WorkspaceState>((set, get) => ({
  projects: [],
  worktreesByProject: {},
  expandedProjectIds: new Set(),
  selectedProjectId: null,
  selectedWorktreeId: null,
  selectedWorktreeLabel: null,
  selectedWorktreeRoot: null,
  loading: false,
  error: null,
  sidebarOpen: false,

  loadProjects: async () => {
    set({ loading: true, error: null });
    try {
      const projects = await relayClient.listProjects();
      set({ projects, loading: false });
    } catch (e) {
      set({ error: String(e), loading: false });
    }
  },

  toggleProject: async (projectId) => {
    const expanded = new Set(get().expandedProjectIds);
    if (expanded.has(projectId)) {
      expanded.delete(projectId);
      set({ expandedProjectIds: expanded });
      return;
    }
    expanded.add(projectId);
    set({ expandedProjectIds: expanded });
    if (get().worktreesByProject[projectId]) return;
    try {
      const worktrees = await relayClient.listWorktrees(projectId);
      set((s) => ({ worktreesByProject: { ...s.worktreesByProject, [projectId]: worktrees } }));
    } catch (e) {
      set({ error: String(e) });
    }
  },

  selectWorktree: (projectId, worktreeId, label, root) => {
    set({
      selectedProjectId: projectId,
      selectedWorktreeId: worktreeId,
      selectedWorktreeLabel: label,
      selectedWorktreeRoot: root,
      sidebarOpen: false,
    });
  },

  openSidebar: () => set({ sidebarOpen: true }),
  closeSidebar: () => set({ sidebarOpen: false }),
}));
