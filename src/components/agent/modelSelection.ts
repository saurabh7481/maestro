import type { AgentEffort, ModelOption } from "../../types/agent";

/** What the composer's pickers should read for a given CLI model id. */
export interface ModelSelection {
  /** The family the picker shows a label for (`ModelOption.id`). */
  model: string;
  /** Only set when the id itself encodes one — see `ModelVariant`. */
  effort: AgentEffort | null;
  thinking: boolean;
  fast: boolean;
}

/** Maps a model id *as the CLI knows it* back onto the picker's family +
 * dials.
 *
 * These are not the same vocabulary. Cursor encodes effort/thinking/fast
 * into the id (`cursor-grok-4.6-xhigh-fast`), so `list_agent_models`
 * groups those into one family option (`cursor-grok-4.6`) with variants —
 * but everything that *persists* a model, the run entry and the
 * `agent_transcripts` row behind it, stores the variant id the CLI was
 * actually given. Matching a stored id against family ids alone therefore
 * never matched for Cursor, and the picker fell back to its "Default"
 * label: a run really running on Grok claimed to be on nothing in
 * particular as soon as its tab remounted (tab-mount budget, app restart,
 * resumed session).
 *
 * Variants are searched before family ids so an id that is *both* (a
 * family whose bare id is also its no-suffix variant, e.g. `gpt-5.3-codex`)
 * resolves through the variant, carrying its dials. */
export function selectionForModelId(
  options: ModelOption[],
  id: string | null | undefined,
): ModelSelection | null {
  if (!id) return null;
  for (const option of options) {
    const variant = option.variants.find((candidate) => candidate.id === id);
    if (variant) {
      return {
        model: option.id,
        effort: variant.effort,
        thinking: variant.thinking,
        fast: variant.fast,
      };
    }
  }
  const family = options.find((option) => option.id === id);
  return family ? { model: family.id, effort: null, thinking: false, fast: false } : null;
}

/** A persisted effort is only applied where the provider still offers it —
 * same "never hand the CLI something it no longer knows" stance as
 * `selectionForModelId` returning `null` for a retired model. */
export function supportedEffort(
  option: ModelOption | undefined,
  effort: string | null | undefined,
): AgentEffort | null {
  if (!option || !effort) return null;
  return option.supportedEfforts.find((candidate) => candidate === effort) ?? null;
}
