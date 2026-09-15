import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "../primitives";

const agentsApi = {
  listAgentModels: vi.fn(),
  listSlashCommands: vi.fn(async () => []),
  getAgentConfiguration: vi.fn(),
  readAttachmentPreview: vi.fn(),
  setAgentConfiguration: vi.fn(),
  getAgentCapabilities: vi.fn(),
};
const loadAgentModelPref = vi.fn();
const saveAgentModelPref = vi.fn();

vi.mock("../../api/agents", () => ({ agentsApi }));
vi.mock("../../api/fs", () => ({ fsApi: { listFiles: vi.fn(async () => []) } }));
vi.mock("../../design/persistence", () => ({ loadAgentModelPref, saveAgentModelPref }));

const useAgentSessionStore = (await import("../../state/agentSessionStore")).useAgentSessionStore;
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
    agentsApi.readAttachmentPreview.mockResolvedValue(null);
    loadAgentModelPref.mockResolvedValue(null);
    useAgentSessionStore.setState({ draftByRunId: {}, attachmentsByRunId: {} });
  });

  /** The whole point of the preview strip: the user sees a thumbnail, but
   * the agent must still receive the path, or the attachment is decorative. */
  it("still sends staged attachments to the agent as @mentions", async () => {
    const onSend = vi.fn();
    useAgentSessionStore.setState({
      draftByRunId: { "run-1": "look at this" },
      attachmentsByRunId: {
        "run-1": [
          { relPath: ".maestro/attachments/shot.png", name: "shot.png", isImage: true },
          { relPath: ".maestro/attachments/report.pdf", name: "report.pdf", isImage: false },
        ],
      },
    });

    render(
      <TooltipProvider>
        <AgentComposer
          runId="run-1"
          kind="claudeCode"
          worktreeId="wt-a"
          worktreeRoot="/repo"
          disabled={false}
          locked={false}
          permissionMode="manual"
          onPermissionModeChange={() => {}}
          onSend={onSend}
          onReplace={() => {}}
        />
      </TooltipProvider>,
    );

    fireEvent.click(screen.getByLabelText("Send"));

    expect(onSend).toHaveBeenCalledTimes(1);
    const sent = onSend.mock.calls[0][0] as string;
    expect(sent).toContain("look at this");
    expect(sent).toContain("@.maestro/attachments/shot.png");
    expect(sent).toContain("@.maestro/attachments/report.pdf");
    // Consumed, so the next message doesn't re-send them.
    expect(useAgentSessionStore.getState().attachmentsByRunId["run-1"]).toBeUndefined();
  });

  it("sends an attachment-only message rather than refusing it", async () => {
    const onSend = vi.fn();
    useAgentSessionStore.setState({
      draftByRunId: { "run-1": "" },
      attachmentsByRunId: {
        "run-1": [{ relPath: ".maestro/attachments/shot.png", name: "shot.png", isImage: true }],
      },
    });

    render(
      <TooltipProvider>
        <AgentComposer
          runId="run-1"
          kind="claudeCode"
          worktreeId="wt-a"
          worktreeRoot="/repo"
          disabled={false}
          locked={false}
          permissionMode="manual"
          onPermissionModeChange={() => {}}
          onSend={onSend}
          onReplace={() => {}}
        />
      </TooltipProvider>,
    );

    const send = screen.getByLabelText("Send");
    expect(send.hasAttribute("disabled")).toBe(false);
    fireEvent.click(send);
    expect(onSend.mock.calls[0][0]).toBe("@.maestro/attachments/shot.png");
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

/** Cursor is the one provider whose model ids encode effort/thinking/fast
 * (`capabilities.separateOptionFlags === false`), so what gets persisted
 * for a run is a *variant* id while the picker lists families. Shaped like
 * a real `cursor-agent --list-models` slice. */
const CURSOR_MODELS = [
  {
    id: "cursor-grok-4.6",
    label: "Cursor Grok 4.6",
    supportedEfforts: ["high", "low", "medium", "xhigh"],
    supportsThinking: false,
    supportsFast: true,
    variants: [
      { id: "cursor-grok-4.6-high-fast", effort: "high", thinking: false, fast: true },
      { id: "cursor-grok-4.6-low", effort: "low", thinking: false, fast: false },
      { id: "cursor-grok-4.6-medium", effort: "medium", thinking: false, fast: false },
      { id: "cursor-grok-4.6-high", effort: "high", thinking: false, fast: false },
      { id: "cursor-grok-4.6-xhigh", effort: "xhigh", thinking: false, fast: false },
    ],
  },
  {
    id: "composer-2.5",
    label: "Composer 2.5",
    supportedEfforts: [],
    supportsThinking: false,
    supportsFast: true,
    variants: [
      { id: "composer-2.5", effort: null, thinking: false, fast: false },
      { id: "composer-2.5-fast", effort: null, thinking: false, fast: true },
    ],
  },
];

function renderCursorComposer(locked: boolean) {
  return render(
    <TooltipProvider>
      <AgentComposer
        runId="run-1"
        kind="cursorAgent"
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

/** The reported bug: pick Grok 4.6 in a Cursor tab, and as soon as the tab
 * remounts — the mount budget in `TabHost.tsx`, a restart, a resumed
 * session — the picker reads "Default", so the run claims no model while
 * genuinely still running on Grok. */
describe("AgentComposer model hydration (Cursor variant ids)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    agentsApi.listAgentModels.mockResolvedValue(CURSOR_MODELS);
    agentsApi.getAgentConfiguration.mockResolvedValue(null);
    agentsApi.readAttachmentPreview.mockResolvedValue(null);
    loadAgentModelPref.mockResolvedValue(null);
    useAgentSessionStore.setState({ draftByRunId: {}, attachmentsByRunId: {} });
  });

  it("shows the family a started run's variant id belongs to, with its dials", async () => {
    agentsApi.getAgentConfiguration.mockResolvedValue({
      model: "cursor-grok-4.6-high-fast",
      effort: null,
      fast: false,
      permissionMode: "manual",
    });

    renderCursorComposer(true);

    await waitFor(() => expect(screen.getByText("Cursor Grok 4.6")).toBeTruthy());
    expect(screen.queryByText("Default")).toBeNull();
    // Both dials recovered from the id itself, not from the (null/false)
    // separate flags a variant-encoding provider never sends.
    expect(screen.getByText("Effort: High")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Fast" }).getAttribute("aria-pressed")).toBe("true");
  });

  it("starts a new tab on the exact variant remembered for this worktree", async () => {
    loadAgentModelPref.mockResolvedValue("cursor-grok-4.6-xhigh");
    renderCursorComposer(false);

    await waitFor(() => expect(screen.getByText("Cursor Grok 4.6")).toBeTruthy());
    expect(screen.getByText("Effort: Extra high")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Fast" }).getAttribute("aria-pressed")).toBe("false");
  });

  /** A bare id that is both a family and its own no-suffix variant must
   * resolve through the variant, so its dials come out off rather than
   * inherited from whatever the composer last showed. */
  it("resolves an id that is both a family and a variant", async () => {
    loadAgentModelPref.mockResolvedValue("composer-2.5-fast");
    renderCursorComposer(false);

    await waitFor(() => expect(screen.getByText("Composer 2.5")).toBeTruthy());
    expect(screen.getByRole("button", { name: "Fast" }).getAttribute("aria-pressed")).toBe("true");
  });

  /** What makes the two halves line up: the preference is stored as the id
   * the CLI takes, which is what hydration above reads back. */
  it("remembers the resolved variant, not the family, when a model is picked", async () => {
    renderCursorComposer(false);
    await waitFor(() => expect(agentsApi.listAgentModels).toHaveBeenCalled());

    // Radix opens its menu on pointerdown, not click.
    fireEvent.pointerDown(screen.getByText("Default"), { button: 0, ctrlKey: false });
    const item = await screen.findByRole("menuitem", { name: "Cursor Grok 4.6" });
    fireEvent.click(item);

    await waitFor(() =>
      expect(saveAgentModelPref).toHaveBeenCalledWith(
        "wt-a",
        "cursorAgent",
        "cursor-grok-4.6-high",
      ),
    );
  });
});
