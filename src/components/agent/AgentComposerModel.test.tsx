import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "../primitives";

const agentsApi = {
  listAgentModels: vi.fn(),
  listSlashCommands: vi.fn(async () => []),
  getAgentConfiguration: vi.fn(),
  setAgentConfiguration: vi.fn(),
  getAgentCapabilities: vi.fn(),
};
const loadAgentModelPref = vi.fn();
const saveAgentModelPref = vi.fn();

vi.mock("../../api/agents", () => ({ agentsApi }));
vi.mock("../../api/fs", () => ({ fsApi: { listFiles: vi.fn(async () => []) } }));
vi.mock("../../design/persistence", () => ({ loadAgentModelPref, saveAgentModelPref }));

const { AgentComposer } = await import("./AgentComposer");

const MODELS = [
  { id: "opus", label: "Opus", variants: [], supportedEfforts: [] },
  { id: "haiku", label: "Haiku", variants: [], supportedEfforts: [] },
];

function renderComposer(locked: boolean) {
  return render(
    <TooltipProvider>
      <AgentComposer
        runId="run-1"
        kind="claudeCode"
        worktreeId="wt-a"
        worktreeRoot="/repo"
        disabled={false}
        locked={locked}
        permissionMode="manual"
        onPermissionModeChange={() => {}}
        onSend={() => {}}
        onReplace={() => {}}
      />
    </TooltipProvider>,
  );
}

describe("AgentComposer model hydration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    agentsApi.listAgentModels.mockResolvedValue(MODELS);
    agentsApi.getAgentConfiguration.mockResolvedValue(null);
    loadAgentModelPref.mockResolvedValue(null);
  });

  it("starts a new tab on the model remembered for this worktree", async () => {
    loadAgentModelPref.mockResolvedValue("haiku");
    renderComposer(false);

    await waitFor(() => expect(screen.getByText("Haiku")).toBeTruthy());
    expect(loadAgentModelPref).toHaveBeenCalledWith("wt-a", "claudeCode");
  });

  /** The serious half of the bug: a run that has already started has its
   * own model, and must never adopt a preference set elsewhere — that is
   * what made a live agent change model between turns. */
  it("hydrates a started run from its own configuration, not the preference", async () => {
    loadAgentModelPref.mockResolvedValue("haiku");
    agentsApi.getAgentConfiguration.mockResolvedValue({
      model: "opus",
      effort: null,
      fast: false,
      permissionMode: "manual",
    });

    renderComposer(true);

    await waitFor(() => expect(screen.getByText("Opus")).toBeTruthy());
    expect(loadAgentModelPref).not.toHaveBeenCalled();
    expect(screen.queryByText("Haiku")).toBeNull();
  });

  it("leaves a started run alone when it has no model of its own", async () => {
    loadAgentModelPref.mockResolvedValue("haiku");
    agentsApi.getAgentConfiguration.mockResolvedValue({
      model: null,
      effort: null,
      fast: false,
      permissionMode: "manual",
    });

    renderComposer(true);

    await waitFor(() => expect(agentsApi.getAgentConfiguration).toHaveBeenCalled());
    expect(screen.getByText("Default")).toBeTruthy();
  });

  /** A model id that no longer exists must not be sent to the CLI. */
  it("ignores a remembered model the provider no longer offers", async () => {
    loadAgentModelPref.mockResolvedValue("retired-model");
    renderComposer(false);

    await waitFor(() => expect(loadAgentModelPref).toHaveBeenCalled());
    expect(screen.getByText("Default")).toBeTruthy();
  });
});
