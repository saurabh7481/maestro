import { create } from "zustand";
import { useShallow } from "zustand/react/shallow";
import { agentsApi } from "../api/agents";
import { AGENT_KINDS, isReady } from "../types/agent";
import type { AgentKind, CliStatus } from "../types/agent";

interface AgentAvailabilityState {
  statusByKind: Partial<Record<AgentKind, CliStatus>>;
  loading: boolean;
  loaded: boolean;

  /** Loaded once at app startup (`AppShell.tsx`) and on manual "Recheck". */
  refreshAll: (force?: boolean) => Promise<void>;
  refresh: (kind: AgentKind) => Promise<void>;
  setBinaryPath: (kind: AgentKind, path: string | null) => Promise<void>;
}

/** Centralized CLI availability/auth — the single source every feature
 * that needs "is an agent CLI usable right now" reads from: the new-tab
 * menu, the Agents & CLI settings pane, and commit-message generation.
 * See docs/ARCHITECTURE.md's Phase 5 plan for why this exists as its own
 * store rather than living inside the agent-tab-specific session state. */
export const useAgentAvailabilityStore = create<AgentAvailabilityState>((set, get) => ({
  statusByKind: {},
  loading: false,
  loaded: false,

  refreshAll: async (force = false) => {
    set({ loading: true });
    try {
      const statuses = await agentsApi.detectAllAgentClis(force);
      set({
        statusByKind: Object.fromEntries(statuses.map((s) => [s.kind, s])) as Record<
          AgentKind,
          CliStatus
        >,
        loading: false,
        loaded: true,
      });
    } catch {
      set({ loading: false, loaded: true });
    }
  },

  refresh: async (kind) => {
    try {
      const status = await agentsApi.detectAgentCli(kind, true);
      set((s) => ({ statusByKind: { ...s.statusByKind, [kind]: status } }));
    } catch {
      // Leave the prior cached status in place rather than clearing it —
      // a transient failed recheck shouldn't make a previously-known-good
      // CLI look unavailable.
    }
  },

  setBinaryPath: async (kind, path) => {
    await agentsApi.setAgentBinaryPath(kind, path);
    await get().refresh(kind);
  },
}));

/** Ready CLIs (installed + authenticated) in a stable display order —
 * used by `CommitBox`'s "Generate with AI" picker and the new-tab menu.
 *
 * `useShallow` is required here, not optional: the selector builds a new
 * array via `.filter()` on every call, and without shallow-comparing the
 * *contents* zustand/`useSyncExternalStore` sees a new reference every
 * render and re-subscribes forever — a real infinite render loop hit
 * live (`Maximum update depth exceeded`) the first time this store had
 * more than one subscriber re-rendering off of it. */
export function useReadyAgentKinds(): AgentKind[] {
  return useAgentAvailabilityStore(
    useShallow((s) => AGENT_KINDS.filter((k) => isReady(s.statusByKind[k]))),
  );
}
