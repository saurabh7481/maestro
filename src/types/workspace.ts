export interface Project {
  id: string;
  name: string;
  rootPath: string;
  addedAt: string;
}

export interface Worktree {
  id: string;
  projectId: string;
  path: string;
  branch: string;
  isPrimary: boolean;
  isDetached: boolean;
  isLocked: boolean;
  ahead: number;
  behind: number;
  dirty: boolean;
  changedFiles: number;
}

export interface HookConfig {
  copyEnvFiles: boolean;
  runInstallCommand: boolean;
  installCommand: string | null;
  symlinkNodeModules: boolean;
  customScriptEnabled: boolean;
  customScript: string;
  /** Project-scoped configs only — when true, this project's own field
   * values are used instead of the global config's. Meaningless on the
   * global config itself, which has nothing to override. */
  overrideEnabled: boolean;
}

export type HookEvent =
  | { type: "line"; stream: "stdout" | "stderr"; text: string }
  | {
      type: "done";
      exitCode: number | null;
      success: boolean;
      cancelled: boolean;
      timedOut: boolean;
    };
