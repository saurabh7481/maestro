import { create } from "zustand";
import { workspaceApi } from "../api/workspace";
import type { Project, Worktree } from "../types/workspace";

interface WorkspaceState {
  projects: Project[];
  worktreesByProject: Record<string, Worktree[]>;
  activeProjectId: string | null;
  activeWorktreeId: string | null;
  loaded: boolean;
  error: string | null;

  loadAll: () => Promise<void>;
  reloadWorktrees: (projectId: string) => Promise<void>;
  addProject: () => Promise<void>;
  removeProject: (projectId: string) => Promise<void>;
  createWorktree: (projectId: string, branchName: string, baseRef: string) => Promise<Worktree>;
  removeWorktree: (projectId: string, worktreeId: string, force: boolean) => Promise<void>;
  selectWorktree: (projectId: string, worktreeId: string) => void;
  clearError: () => void;
}

function pickDefaultWorktree(worktrees: Worktree[]): Worktree | undefined {
  return worktrees.find((w) => w.isPrimary) ?? worktrees[0];
}

export const useWorkspaceStore = create<WorkspaceState>((set, get) => ({
  projects: [],
  worktreesByProject: {},
  activeProjectId: null,
  activeWorktreeId: null,
  loaded: false,
  error: null,

  loadAll: async () => {
    try {
      const projects = await workspaceApi.listProjects();
      const entries = await Promise.all(
        projects.map(async (p) => [p.id, await workspaceApi.listWorktrees(p.id)] as const),
      );
      const worktreesByProject = Object.fromEntries(entries);

      set((s) => {
        const stillValid =
          s.activeProjectId != null &&
          (worktreesByProject[s.activeProjectId] ?? []).some((w) => w.id === s.activeWorktreeId);
        if (stillValid) {
          return { projects, worktreesByProject, loaded: true };
        }
        const firstProject = projects[0];
        const firstWorktree = firstProject
          ? pickDefaultWorktree(worktreesByProject[firstProject.id] ?? [])
          : undefined;
        return {
          projects,
          worktreesByProject,
          loaded: true,
          activeProjectId: firstProject?.id ?? null,
          activeWorktreeId: firstWorktree?.id ?? null,
        };
      });
    } catch (error) {
      set({ error: String(error), loaded: true });
    }
  },

  reloadWorktrees: async (projectId) => {
    try {
      const worktrees = await workspaceApi.listWorktrees(projectId);
      set((s) => ({ worktreesByProject: { ...s.worktreesByProject, [projectId]: worktrees } }));
    } catch (error) {
      set({ error: String(error) });
    }
  },

  addProject: async () => {
    try {
      const path = await workspaceApi.pickProjectFolder();
      if (!path) return;
      const project = await workspaceApi.addProject(path);
      const worktrees = await workspaceApi.listWorktrees(project.id);
      set((s) => ({
        projects: [...s.projects, project],
        worktreesByProject: { ...s.worktreesByProject, [project.id]: worktrees },
        activeProjectId: project.id,
        activeWorktreeId: pickDefaultWorktree(worktrees)?.id ?? null,
      }));
    } catch (error) {
      set({ error: String(error) });
    }
  },

  removeProject: async (projectId) => {
    try {
      await workspaceApi.removeProject(projectId);
      set((s) => {
        const rest = Object.fromEntries(
          Object.entries(s.worktreesByProject).filter(([id]) => id !== projectId),
        );
        const projects = s.projects.filter((p) => p.id !== projectId);
        const wasActive = s.activeProjectId === projectId;
        const fallback = wasActive ? projects[0] : undefined;
        return {
          projects,
          worktreesByProject: rest,
          activeProjectId: wasActive ? (fallback?.id ?? null) : s.activeProjectId,
          activeWorktreeId: wasActive
            ? (pickDefaultWorktree(rest[fallback?.id ?? ""] ?? [])?.id ?? null)
            : s.activeWorktreeId,
        };
      });
    } catch (error) {
      set({ error: String(error) });
    }
  },

  createWorktree: async (projectId, branchName, baseRef) => {
    const worktree = await workspaceApi.createWorktree(projectId, branchName, baseRef);
    await get().reloadWorktrees(projectId);
    set({ activeProjectId: projectId, activeWorktreeId: worktree.id });
    return worktree;
  },

  removeWorktree: async (projectId, worktreeId, force) => {
    await workspaceApi.removeWorktree(projectId, worktreeId, force);
    await get().reloadWorktrees(projectId);
    set((s) => {
      if (s.activeWorktreeId !== worktreeId) return s;
      const fallback = pickDefaultWorktree(s.worktreesByProject[projectId] ?? []);
      return { activeWorktreeId: fallback?.id ?? null };
    });
  },

  selectWorktree: (projectId, worktreeId) => {
    set({ activeProjectId: projectId, activeWorktreeId: worktreeId });
    void workspaceApi.touchWorktree(worktreeId);
  },

  clearError: () => set({ error: null }),
}));

export function useActiveWorktree(): Worktree | undefined {
  return useWorkspaceStore((s) => {
    if (!s.activeProjectId || !s.activeWorktreeId) return undefined;
    return s.worktreesByProject[s.activeProjectId]?.find((w) => w.id === s.activeWorktreeId);
  });
}

export function useActiveProject(): Project | undefined {
  return useWorkspaceStore((s) => s.projects.find((p) => p.id === s.activeProjectId));
}
