import { create } from "zustand";
import { workspaceApi } from "../api/workspace";
import { agentsApi } from "../api/agents";
import { terminalApi } from "../api/terminal";
import { useTabsStore } from "./tabsStore";
import { useAgentSessionStore } from "./agentSessionStore";
import { useTerminalSessionStore } from "./terminalSessionStore";
import type { Project, Worktree } from "../types/workspace";

/** A stable, module-scoped empty array — use as `worktreesByProject[id]
 * ?? EMPTY_WORKTREES` in selectors, never `?? []`. A fresh `[]` literal
 * as a selector's fallback is a real trap: zustand compares the
 * selector's *return value* by reference, so a project with no recorded
 * worktrees yet gets a brand-new array every render, which reads as "the
 * store changed" forever — confirmed live as a `Maximum update depth
 * exceeded` infinite loop from the equivalent `.filter()` case in
 * `agentAvailabilityStore.ts`. Reusing one constant reference fixes it
 * for the empty-fallback shape without needing `useShallow`. */
export const EMPTY_WORKTREES: Worktree[] = [];

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
  renameProject: (projectId: string, name: string) => Promise<void>;
  createWorktree: (projectId: string, branchName: string, baseRef: string) => Promise<Worktree>;
  removeWorktree: (projectId: string, worktreeId: string, force: boolean) => Promise<void>;
  selectWorktree: (projectId: string, worktreeId: string) => void;
  updateWorktreeStatus: (
    worktreeId: string,
    patch: Partial<Pick<Worktree, "ahead" | "behind" | "dirty" | "changedFiles">>,
  ) => void;
  clearError: () => void;
}

function pickDefaultWorktree(worktrees: Worktree[]): Worktree | undefined {
  return worktrees.find((w) => w.isPrimary) ?? worktrees[0];
}

/** Kills every agent/terminal tab belonging to a just-removed worktree —
 * see `removeWorktree` below. Agent tabs are matched by `worktreeId`
 * (the Rust side already indexes runs that way — reused here via
 * `killAgentRunsForWorktree` rather than re-deriving the id list);
 * terminal tabs don't carry a `worktreeId`, so they're matched by the
 * worktree's absolute path instead. */
async function teardownWorktreeProcessTabs(worktreeId: string, worktreePath: string | undefined) {
  const killedAgentRunIds = await agentsApi.killAgentRunsForWorktree(worktreeId).catch(() => []);
  for (const runId of killedAgentRunIds) {
    useAgentSessionStore.getState().closeRun(runId);
  }

  const terminalTabIds = worktreePath
    ? useTabsStore
        .getState()
        .tabs.filter((t) => t.type === "terminal" && t.worktreeRoot === worktreePath)
        .map((t) => t.id)
    : [];
  for (const terminalId of terminalTabIds) {
    await terminalApi.kill(terminalId).catch(() => {});
    useTerminalSessionStore.getState().closeSession(terminalId);
  }

  const closedTabIds = new Set([...killedAgentRunIds, ...terminalTabIds]);
  if (closedTabIds.size === 0) return;
  const { closeTab } = useTabsStore.getState();
  for (const tabId of closedTabIds) closeTab(tabId);
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

  renameProject: async (projectId, name) => {
    try {
      await workspaceApi.renameProject(projectId, name);
      set((s) => ({
        projects: s.projects.map((p) => (p.id === projectId ? { ...p, name } : p)),
      }));
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
    const worktreePath = get().worktreesByProject[projectId]?.find(
      (w) => w.id === worktreeId,
    )?.path;
    await workspaceApi.removeWorktree(projectId, worktreeId, force);
    await get().reloadWorktrees(projectId);
    set((s) => {
      if (s.activeWorktreeId !== worktreeId) return s;
      const fallback = pickDefaultWorktree(s.worktreesByProject[projectId] ?? []);
      return { activeWorktreeId: fallback?.id ?? null };
    });
    // Agent runs and terminal PTYs are real OS processes scoped to this
    // worktree — a removed worktree must not leave either dangling
    // (docs/CHECKLIST.md edge cases). File/diff/markdown tabs have no
    // live-process concern, so they're left alone (also true of this
    // codebase's tabs generally: they aren't otherwise worktree-scoped —
    // see docs/ROADMAP.md's Phase 8 note on tab/window state).
    await teardownWorktreeProcessTabs(worktreeId, worktreePath);
  },

  selectWorktree: (projectId, worktreeId) => {
    set({ activeProjectId: projectId, activeWorktreeId: worktreeId });
    void workspaceApi.touchWorktree(worktreeId);
  },

  // Patches a worktree's live status fields from an `scm://` event
  // (`scmStore.applyScmEvent`) — searches every project's list rather than
  // requiring the caller to know which project the worktree belongs to,
  // since `scmStore` only carries a `worktreeId`/`worktreeRoot` pair.
  updateWorktreeStatus: (worktreeId, patch) => {
    set((s) => {
      for (const [projectId, worktrees] of Object.entries(s.worktreesByProject)) {
        const idx = worktrees.findIndex((w) => w.id === worktreeId);
        if (idx === -1) continue;
        const updated = [...worktrees];
        updated[idx] = { ...updated[idx], ...patch };
        return {
          worktreesByProject: { ...s.worktreesByProject, [projectId]: updated },
        };
      }
      return s;
    });
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
