import { create } from "zustand";
import { useShallow } from "zustand/react/shallow";
import { agentsApi } from "../api/agents";
import { TAB_READY_AGENT_KINDS, CONSERVATIVE_CAPABILITIES, isReady } from "../types/agent";
import type { AgentCapabilities, AgentKind, CliStatus } from "../types/agent";

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
 * Filtered from `TAB_READY_AGENT_KINDS`, not `AGENT_KINDS`: a detected CLI
 * whose turn path isn't wired yet must not be startable or offered for
 * commit messages, even though its settings card renders. Every current
 * `AgentKind` has since caught up to `TAB_READY_AGENT_KINDS` (most
 * recently OpenCode) — this filter is what a future kind added to
 * `AGENT_KINDS` ahead of its own turn-path work would fall back on.
 *
 * `useShallow` is required here, not optional: the selector builds a new
 * array via `.filter()` on every call, and without shallow-comparing the
 * *contents* zustand/`useSyncExternalStore` sees a new reference every
 * render and re-subscribes forever — a real infinite render loop hit
 * live (`Maximum update depth exceeded`) the first time this store had
 * more than one subscriber re-rendering off of it. */
export function useReadyAgentKinds(): AgentKind[] {
  return useAgentAvailabilityStore(
    useShallow((s) => TAB_READY_AGENT_KINDS.filter((k) => isReady(s.statusByKind[k]))),
  );
}

/** What this provider supports, for gating optional chat affordances.
 *
 * This is the seam that keeps the chat UI provider-agnostic: components
 * ask what the CLI can do, never which CLI it is. Falls back to
 * `CONSERVATIVE_CAPABILITIES` until detection resolves, so an affordance
 * never appears before it's known to work.
 *
 * The returned object is a stable reference from the store (or the shared
 * fallback constant), so it's safe in dependency arrays — see this file's
 * `useReadyAgentKinds` comment for what a fresh object literal per call
 * would do to `useSyncExternalStore`. */
export function useAgentCapabilities(kind: AgentKind): AgentCapabilities {
  return useAgentAvailabilityStore(
    (s) => s.statusByKind[kind]?.capabilities ?? CONSERVATIVE_CAPABILITIES,
  );
}
