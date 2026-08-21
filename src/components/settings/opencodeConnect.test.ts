import { describe, expect, it } from "vitest";
import type { AuthPrompt, ProviderSummary } from "../../types/opencode";
import {
  filterCatalog,
  isPromptVisible,
  needsMethodPicker,
  visiblePrompts,
} from "./opencodeConnect";

const CATALOG: ProviderSummary[] = [
  { id: "opencode", name: "OpenCode Zen" },
  { id: "anthropic", name: "Anthropic" },
  { id: "github-copilot", name: "GitHub Copilot" },
  { id: "openai", name: "OpenAI" },
  { id: "azure", name: "Azure" },
];

describe("filterCatalog", () => {
  it("groups alphabetically with letter anchors", () => {
    const groups = filterCatalog(CATALOG, "");
    expect(groups.map((group) => group.letter)).toEqual(["A", "G", "O"]);
    expect(groups[2].providers.map((provider) => provider.name)).toEqual([
      "OpenAI",
      "OpenCode Zen",
    ]);
  });

  it("matches fuzzy across name and id", () => {
    const groups = filterCatalog(CATALOG, "copilot");
    expect(groups).toHaveLength(1);
    expect(groups[0].providers[0].id).toBe("github-copilot");

    // "zen" only appears in the id, not the display name.
    const byId = filterCatalog(CATALOG, "zen");
    expect(byId[0].providers[0].id).toBe("opencode");
  });

  it("returns nothing for a query nothing matches", () => {
    expect(filterCatalog(CATALOG, "blockchain")).toHaveLength(0);
  });
});

describe("isPromptVisible", () => {
  const enterpriseUrl: AuthPrompt = {
    kind: "text",
    key: "enterpriseUrl",
    message: "Enter your GitHub Enterprise URL",
    options: [],
    when: ["deploymentType", "enterprise"],
  };
  const unconditional: AuthPrompt = {
    kind: "select",
    key: "deploymentType",
    message: "Select deployment type",
    options: [],
  };

  it("shows unconditional prompts always", () => {
    expect(isPromptVisible(unconditional, {})).toBe(true);
  });

  it("hides conditional prompts until their dependency matches", () => {
    expect(isPromptVisible(enterpriseUrl, {})).toBe(false);
    expect(isPromptVisible(enterpriseUrl, { deploymentType: "github.com" })).toBe(false);
    expect(isPromptVisible(enterpriseUrl, { deploymentType: "enterprise" })).toBe(true);
  });

  it("visiblePrompts filters in declaration order", () => {
    const shown = visiblePrompts([unconditional, enterpriseUrl], {
      deploymentType: "enterprise",
    });
    expect(shown.map((prompt) => prompt.key)).toEqual(["deploymentType", "enterpriseUrl"]);
  });
});

describe("needsMethodPicker", () => {
  it("is true only when several methods exist", () => {
    expect(needsMethodPicker([])).toBe(false);
    expect(needsMethodPicker([{ index: 0, kind: "api", label: "Key", prompts: [] }])).toBe(false);
    expect(
      needsMethodPicker([
        { index: 0, kind: "oauth", label: "ChatGPT", prompts: [] },
        { index: 1, kind: "api", label: "API key", prompts: [] },
      ]),
    ).toBe(true);
  });
});
