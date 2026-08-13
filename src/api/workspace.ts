import { invoke } from "@tauri-apps/api/core";
import type { HookConfig, Project, Worktree } from "../types/workspace";

/** Thin, typed wrapper around the Tauri command surface — the single
 * place that knows the actual `invoke()` channel names and payload
 * shapes, so components never call `invoke()` directly. */
export const workspaceApi = {
  listProjects: () => invoke<Project[]>("list_projects"),
  pickProjectFolder: () => invoke<string | null>("pick_project_folder"),
  addProject: (path: string) => invoke<Project>("add_project", { path }),
  removeProject: (projectId: string) => invoke<void>("remove_project", { projectId }),

  listWorktrees: (projectId: string) => invoke<Worktree[]>("list_worktrees", { projectId }),
  listProjectBranches: (projectId: string) =>
    invoke<string[]>("list_project_branches", { projectId }),
  createWorktree: (projectId: string, branchName: string, baseRef: string) =>
    invoke<Worktree>("create_worktree", { projectId, branchName, baseRef }),
  removeWorktree: (projectId: string, worktreeId: string, force: boolean) =>
    invoke<void>("remove_worktree", { projectId, worktreeId, force }),
  touchWorktree: (worktreeId: string) => invoke<void>("touch_worktree", { worktreeId }),

  getHookConfig: (projectId: string) => invoke<HookConfig>("get_hook_config", { projectId }),
  setHookConfig: (projectId: string, config: HookConfig) =>
    invoke<void>("set_hook_config", { projectId, config }),
  runWorktreeHook: (projectId: string, worktreeId: string, sourceWorktreePath: string) =>
    invoke<void>("run_worktree_hook", { projectId, worktreeId, sourceWorktreePath }),
  cancelWorktreeHook: (worktreeId: string) => invoke<void>("cancel_worktree_hook", { worktreeId }),
};
