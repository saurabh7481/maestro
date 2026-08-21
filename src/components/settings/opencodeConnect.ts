import type { AuthMethod, AuthPrompt, ProviderSummary } from "../../types/opencode";
import { fuzzyScore } from "../../design/fuzzy";

/** Whether a declarative prompt should render given the answers so far —
 * the `when` conditions providers attach to their own forms (e.g.
 * Copilot's enterprise-URL field appears only when deploymentType is
 * "enterprise"). Unanswered dependencies hide the prompt; answering the
 * select reveals it. */
export function isPromptVisible(prompt: AuthPrompt, answers: Record<string, string>): boolean {
  const [key, value] = prompt.when ?? [];
  if (key === undefined || value === undefined) return true;
  return answers[key] === value;
}

/** The prompts currently visible, in declaration order — what the sheet
 * renders and what "Continue" requires answers for. */
export function visiblePrompts(
  prompts: AuthPrompt[],
  answers: Record<string, string>,
): AuthPrompt[] {
  return prompts.filter((prompt) => isPromptVisible(prompt, answers));
}

/** When a provider declares several auth methods (OpenAI: ChatGPT
 * subscription vs API key), the user picks first; one method connects
 * directly. */
export function needsMethodPicker(methods: AuthMethod[]): boolean {
  return methods.length > 1;
}

export type CatalogGroup = {
  /** First letter bucket label — a flat alphabetical list of 190+ rows
   * reads as a wall; letter anchors give the scroll structure. */
  letter: string;
  providers: ProviderSummary[];
};

/** Filters the catalog by a fuzzy query across name and id, then groups
 * what survives alphabetically. Empty query → everything, grouped. */
export function filterCatalog(available: ProviderSummary[], query: string): CatalogGroup[] {
  const trimmed = query.trim();
  const matched = trimmed
    ? available.filter((provider) => {
        return (
          fuzzyScore(trimmed.toLowerCase(), provider.name.toLowerCase()) !== null ||
          fuzzyScore(trimmed.toLowerCase(), provider.id.toLowerCase()) !== null
        );
      })
    : available;

  const sorted = [...matched].sort((a, b) => a.name.localeCompare(b.name));
  const groups: CatalogGroup[] = [];
  for (const provider of sorted) {
    const letter = (provider.name[0] ?? "#").toUpperCase();
    const group = groups[groups.length - 1];
    if (group && group.letter === letter) {
      group.providers.push(provider);
    } else {
      groups.push({ letter, providers: [provider] });
    }
  }
  return groups;
}
