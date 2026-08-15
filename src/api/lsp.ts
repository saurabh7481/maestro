import { Channel, invoke } from "@tauri-apps/api/core";
import type {
  GlobalLspSettings,
  LspServerKind,
  LspServerStatus,
  ProjectLspSettings,
  LspTransportEvent,
  RunningLspServer,
} from "../types/lsp";

export const lspApi = {
  getGlobalSettings: () => invoke<GlobalLspSettings>("get_global_lsp_settings"),
  setGlobalSettings: (settings: GlobalLspSettings) =>
    invoke<void>("set_global_lsp_settings", { settings }),
  getProjectSettings: (projectId: string) =>
    invoke<ProjectLspSettings>("get_project_lsp_settings", { projectId }),
  setProjectSettings: (projectId: string, enabledOverride: boolean | null) =>
    invoke<ProjectLspSettings>("set_project_lsp_settings", { projectId, enabledOverride }),
  isEnabledForWorktree: (worktreeId: string) =>
    invoke<boolean>("is_lsp_enabled_for_worktree", { worktreeId }),
  detectServer: (kind: LspServerKind, force = false) =>
    invoke<LspServerStatus>("detect_lsp_server", { kind, force }),
  detectAllServers: (force = false) =>
    invoke<LspServerStatus[]>("detect_all_lsp_servers", { force }),
  setBinaryPath: (kind: LspServerKind, path: string | null) =>
    invoke<void>("set_lsp_binary_path", { kind, path }),
  getTypeScriptSdkPath: () => invoke<string | null>("get_typescript_sdk_path"),
  setTypeScriptSdkPath: (path: string | null) => invoke<void>("set_typescript_sdk_path", { path }),
  startServer: (
    worktreeId: string,
    worktreeRoot: string,
    kind: LspServerKind,
    onEvent: (event: LspTransportEvent) => void,
  ) => {
    const channel = new Channel<LspTransportEvent>();
    channel.onmessage = onEvent;
    return invoke<RunningLspServer>("start_lsp_server", {
      worktreeId,
      worktreeRoot,
      kind,
      onEvent: channel,
    });
  },
  sendMessage: (worktreeId: string, kind: LspServerKind, generation: string, message: string) =>
    invoke<void>("send_lsp_message", { worktreeId, kind, generation, message }),
  stopServer: (worktreeId: string, kind: LspServerKind, generation?: string) =>
    invoke<void>("stop_lsp_server", { worktreeId, kind, generation: generation ?? null }),
  listRunningServers: () => invoke<RunningLspServer[]>("list_running_lsp_servers"),
};
