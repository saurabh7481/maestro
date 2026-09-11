import { create } from "zustand";
import { relayClient } from "../api/client";
import type { AgentEffort, ModelOption, PermissionMode } from "../api/types";

export interface AgentConfig {
  model: string | null;
  effort: AgentEffort;
  fast: boolean;
  permissionMode: PermissionMode;
}

// `manual` — not the backend's own `PermissionMode::Auto` default — so a
// session started from mobile is gated exactly like a fresh desktop tab
// (mirrors `relay/routes.rs::create_agent_session`'s own comment). A
// shared, stable reference (not a factory) so components selecting
// `byRunId[runId] ?? DEFAULT_AGENT_CONFIG` don't get a fresh object — and
// therefore an unnecessary re-render — on every store notification.
export const DEFAULT_AGENT_CONFIG: AgentConfig = {
  model: null,
  effort: "high",
  fast: false,
  permissionMode: "manual",
};

/** A CLI whose models encode effort/fast into the model id itself (Cursor
 * — `capabilities.separateOptionFlags === false`) needs the actual variant
 * id resolved before it's sent anywhere; ported from the desktop's
 * `AgentComposer.tsx` (`resolvedModel`/`cliEffort`/`cliFast`), minus the
 * `thinking` axis mobile's picker row doesn't offer. */
export function resolveForSend(
  option: ModelOption | undefined,
  effort: AgentEffort,
  fast: boolean,
  separateOptionFlags: boolean,
): { model: string | null; effort: string | null; fast: boolean } {
  if (!option) return { model: null, effort: null, fast: false };
  if (separateOptionFlags || option.variants.length === 0) {
    return {
      model: option.id,
      effort: option.supportedEfforts.length > 0 ? effort : null,
      fast: option.supportsFast ? fast : false,
    };
  }
  const wantedEffort = option.supportedEfforts.length > 0 ? effort : null;
  const variant =
    option.variants.find((v) => v.effort === wantedEffort && v.fast === fast && !v.thinking) ??
    option.variants[0];
  return { model: variant?.id ?? option.id, effort: null, fast: false };
}

/** The reverse of `resolveForSend`: given what the relay reports a run is
 * actually configured as right now, figure out what the composer's
 * picker row should show. Needed because a Cursor-style CLI's stored
 * `model` is a specific *variant* id (e.g. `"grok-4.6-high-fast"`), not
 * one of the top-level `ModelOption` ids the picker lists — without
 * mapping it back to its family and recovering the effort/fast it
 * encodes, the picker would show "Default" even though the run genuinely
 * has a model configured (this was the mobile-vs-desktop "shows Default
 * when Grok 4.6 is actually selected" bug). */
export function deriveDisplayConfig(
  models: ModelOption[],
  remoteModel: string | null,
  remoteEffort: string | null,
  remoteFast: boolean,
): Pick<AgentConfig, "model" | "effort" | "fast"> {
  if (!remoteModel) return { model: null, effort: DEFAULT_AGENT_CONFIG.effort, fast: false };
  const direct = models.find((m) => m.id === remoteModel);
  if (direct) {
    return {
      model: direct.id,
      effort: (remoteEffort as AgentEffort | null) ?? DEFAULT_AGENT_CONFIG.effort,
      fast: remoteFast,
    };
  }
  for (const option of models) {
    const variant = option.variants.find((v) => v.id === remoteModel);
    if (variant) {
      return {
        model: option.id,
        effort: (variant.effort as AgentEffort | null) ?? DEFAULT_AGENT_CONFIG.effort,
        fast: variant.fast,
      };
    }
  }
  // The relay reports a model id no currently-known option (or variant)
  // matches — most likely `models` hasn't finished loading yet. Showing
  // nothing selected here is corrected on the next poll tick once it has.
  return { model: null, effort: DEFAULT_AGENT_CONFIG.effort, fast: false };
}

interface UpdateArgs {
  runId: string;
  options: ModelOption[];
  separateOptionFlags: boolean;
  /** Push the resolved configuration to the relay immediately — true for
   * an already-running session's composer, false while still composing a
   * brand-new session (`NewAgentSheet` sends the resolved values along
   * with session creation itself instead). */
  live: boolean;
}

interface AgentConfigState {
  byRunId: Record<string, AgentConfig>;
  get: (runId: string) => AgentConfig;
  setModel: (args: UpdateArgs, modelId: string) => void;
  setEffort: (args: UpdateArgs, effort: AgentEffort) => void;
  setFast: (args: UpdateArgs, fast: boolean) => void;
  setPermissionMode: (runId: string, mode: PermissionMode, live: boolean) => void;
  /** Pulls the run's actual current configuration from the relay and
   * reconciles the picker row to match — called on open and polled while
   * a run's screen is visible (`AgentScreen.tsx`), so a change made from
   * the desktop (or another device) shows up here too, not just changes
   * this composer instance happened to make itself. */
  hydrate: (runId: string, models: ModelOption[]) => Promise<void>;
}

export const useAgentConfigStore = create<AgentConfigState>((set, getState) => ({
  byRunId: {},

  get: (runId) => getState().byRunId[runId] ?? DEFAULT_AGENT_CONFIG,

  setModel: ({ runId, options, separateOptionFlags, live }, modelId) => {
    const current = getState().get(runId);
    const option = options.find((o) => o.id === modelId);
    const effort = option?.supportedEfforts.includes(current.effort)
      ? current.effort
      : (option?.supportedEfforts[0] ?? current.effort);
    const next: AgentConfig = { ...current, model: modelId, effort, fast: false };
    set((s) => ({ byRunId: { ...s.byRunId, [runId]: next } }));
    if (live)
      void relayClient.setAgentConfiguration(
        runId,
        resolveForSend(option, effort, false, separateOptionFlags),
      );
  },

  setEffort: ({ runId, options, separateOptionFlags, live }, effort) => {
    const current = getState().get(runId);
    set((s) => ({ byRunId: { ...s.byRunId, [runId]: { ...current, effort } } }));
    if (live) {
      const option = options.find((o) => o.id === current.model);
      void relayClient.setAgentConfiguration(
        runId,
        resolveForSend(option, effort, current.fast, separateOptionFlags),
      );
    }
  },

  setFast: ({ runId, options, separateOptionFlags, live }, fast) => {
    const current = getState().get(runId);
    set((s) => ({ byRunId: { ...s.byRunId, [runId]: { ...current, fast } } }));
    if (live) {
      const option = options.find((o) => o.id === current.model);
      void relayClient.setAgentConfiguration(
        runId,
        resolveForSend(option, current.effort, fast, separateOptionFlags),
      );
    }
  },

  setPermissionMode: (runId, mode, live) => {
    const current = getState().get(runId);
    set((s) => ({ byRunId: { ...s.byRunId, [runId]: { ...current, permissionMode: mode } } }));
    if (live) void relayClient.setPermissionMode(runId, mode);
  },

  hydrate: async (runId, models) => {
    try {
      const remote = await relayClient.getAgentConfiguration(runId);
      if (!remote) return;
      const derived = deriveDisplayConfig(models, remote.model, remote.effort, remote.fast);
      set((s) => ({
        byRunId: { ...s.byRunId, [runId]: { ...derived, permissionMode: remote.permissionMode } },
      }));
    } catch {
      // Transient network hiccup — keep whatever the picker last showed.
    }
  },
}));
