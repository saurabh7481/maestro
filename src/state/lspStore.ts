import { create } from "zustand";
import { lspApi } from "../api/lsp";
import type { GlobalLspSettings, LspServerKind, LspServerStatus } from "../types/lsp";
import { refreshLspRuntime, retryLspRuntime } from "../lsp/runtimeBridge";

interface LspState {
  globalSettings: GlobalLspSettings | null;
  statusByKind: Partial<Record<LspServerKind, LspServerStatus>>;
  loading: boolean;
  typeScriptSdkPath: string | null;
  runtimeByKey: Record<
    string,
    { status: "starting" | "ready" | "error" | "disabled"; detail?: string }
  >;
  load: (force?: boolean) => Promise<void>;
  setGlobalEnabled: (enabled: boolean) => Promise<void>;
  recheck: (kind: LspServerKind) => Promise<void>;
  setBinaryPath: (kind: LspServerKind, path: string | null) => Promise<void>;
  setTypeScriptSdkPath: (path: string | null) => Promise<void>;
  setRuntime: (
    key: string,
    runtime: { status: "starting" | "ready" | "error" | "disabled"; detail?: string },
  ) => void;
}

export const useLspStore = create<LspState>((set, get) => ({
  globalSettings: null,
  statusByKind: {},
  loading: false,
  typeScriptSdkPath: null,
  runtimeByKey: {},

  load: async (force = false) => {
    set({ loading: true });
    try {
      const [globalSettings, statuses, typeScriptSdkPath] = await Promise.all([
        lspApi.getGlobalSettings(),
        lspApi.detectAllServers(force),
        lspApi.getTypeScriptSdkPath(),
      ]);
      set({
        globalSettings,
        statusByKind: Object.fromEntries(statuses.map((status) => [status.kind, status])),
        typeScriptSdkPath,
      });
    } finally {
      set({ loading: false });
    }
  },

  setGlobalEnabled: async (enabled) => {
    await lspApi.setGlobalSettings({ enabled });
    set({ globalSettings: { enabled } });
    await refreshLspRuntime();
  },

  recheck: async (kind) => {
    const status = await lspApi.detectServer(kind, true);
    set((state) => ({ statusByKind: { ...state.statusByKind, [kind]: status } }));
    await retryLspRuntime(kind);
  },

  setBinaryPath: async (kind, path) => {
    await lspApi.setBinaryPath(kind, path);
    await get().recheck(kind);
  },

  setTypeScriptSdkPath: async (path) => {
    await lspApi.setTypeScriptSdkPath(path);
    set({ typeScriptSdkPath: path });
    await get().recheck("typeScript");
  },

  setRuntime: (key, runtime) =>
    set((state) => ({ runtimeByKey: { ...state.runtimeByKey, [key]: runtime } })),
}));
