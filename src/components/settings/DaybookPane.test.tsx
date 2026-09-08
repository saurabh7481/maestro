import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DaybookConfig, DaybookOverview, DaybookPreview } from "../../types/daybook";
import { DaybookPane } from "./DaybookPane";

const { getOverview, listAgentModels, previewInputs, saveConfig } = vi.hoisted(() => ({
  getOverview: vi.fn(),
  listAgentModels: vi.fn(),
  previewInputs: vi.fn(),
  saveConfig: vi.fn(),
}));

vi.mock("../../api/daybook", () => ({
  daybookApi: {
    getOverview,
    listAgentModels,
    pickDestination: vi.fn(),
    previewInputs,
    saveConfig,
  },
}));

vi.mock("../../api/agents", () => ({
  agentsApi: { listAgentModels },
}));

vi.mock("../../state/agentAvailabilityStore", () => ({
  useReadyAgentKinds: () => ["codex"],
}));

const config: DaybookConfig = {
  schemaVersion: 1,
  enabled: false,
  timezone: "Asia/Kolkata",
  schedule: {
    mode: "afterDayEnds",
    time: "00:10",
    days: [1, 2, 3, 4, 5, 6, 7],
    catchUp: true,
    skipEmpty: true,
  },
  agent: { kind: null, model: null, effort: null, fast: false },
  sources: {
    git: true,
    maestro: true,
    slack: false,
    slackPrivateChannels: false,
    slackDirectMessages: false,
    slackThreadContext: true,
    jira: false,
  },
  destination: {
    kind: "obsidian",
    rootPath: "/notes/Main",
    vaultName: "Main",
    relativePattern: "Daily/YYYY/YYYY-MM-DD.md",
    appendDailyNote: true,
    dailyNoteHeading: "Work log",
  },
};

const overview: DaybookOverview = {
  config,
  configured: false,
  integrations: {
    git: { projectCount: 3, identityCount: 1, ready: true },
    maestro: { indexedSessionCount: 14, ready: true },
    slack: {
      oauthAvailable: true,
      connections: [
        {
          workspaceId: "T123",
          enterpriseId: null,
          userId: "U123",
          workspaceName: "Maestro",
          displayName: "Saurabh",
          grantedScopes: ["search:read.public"],
          status: "connected",
          connectedAt: "2026-08-31T09:00:00Z",
          lastValidatedAt: "2026-08-31T09:00:00Z",
        },
      ],
      desktopFallbackDetected: true,
      detail: "1 Slack workspace connected with read-only search access.",
    },
    jira: {
      environmentFound: true,
      keychainFound: true,
      missingVariables: [],
      detail: "Jira environment variables found.",
    },
    obsidian: {
      installed: true,
      vaults: [
        { name: "Main", path: "/notes/Main", dailyNotesEnabled: true },
        { name: "Scratch", path: "/notes/Scratch", dailyNotesEnabled: false },
      ],
    },
    scheduler: {
      systemdUserAvailable: true,
      cronAvailable: true,
      installed: false,
      detail: "systemd user timers are available.",
    },
  },
};

const preview: DaybookPreview = {
  date: "2026-08-31",
  windowLabel: "31 Aug, 00:00–23:59 · Asia/Kolkata",
  counts: { commits: 2, maestroSessions: 1, slackMessages: 0, jiraItems: 0 },
  sources: [
    { id: "git", label: "Git", status: "ready", count: 2, detail: "2 matching commits" },
    {
      id: "maestro",
      label: "Maestro activity",
      status: "ready",
      count: 1,
      detail: "1 completed session",
    },
    {
      id: "slack",
      label: "Slack Desktop",
      status: "disabled",
      count: 0,
      detail: "Excluded from this run",
    },
    {
      id: "jira",
      label: "Jira",
      status: "disabled",
      count: 0,
      detail: "Excluded from this run",
    },
  ],
  items: [
    {
      id: "commit-1",
      source: "git",
      occurredAt: "2026-08-31T10:30:00+05:30",
      label: "Add Daybook setup",
      context: "maestro",
    },
  ],
  warnings: [],
};

describe("DaybookPane", () => {
  beforeEach(() => {
    getOverview.mockReset().mockResolvedValue(overview);
    listAgentModels.mockReset().mockResolvedValue([
      {
        id: "gpt-5.6",
        label: "GPT-5.6",
        supportedEfforts: ["low", "medium", "high"],
        supportsThinking: false,
        supportsFast: false,
        variants: [],
      },
    ]);
    previewInputs.mockReset().mockResolvedValue(preview);
    saveConfig.mockReset().mockImplementation(async (value: DaybookConfig) => value);
  });

  it("walks the setup flow, previews evidence, and saves a disabled draft", async () => {
    render(<DaybookPane />);

    expect(await screen.findByText("Choose what belongs in the record")).toBeInTheDocument();
    expect(screen.getByText("3 registered projects · 1 author identity")).toBeInTheDocument();
    expect(screen.getByRole("switch", { name: "Include Slack" })).toBeEnabled();

    fireEvent.click(screen.getByRole("button", { name: /continue/i }));
    expect(await screen.findByText("Choose who writes the entry")).toBeInTheDocument();
    await waitFor(() => expect(listAgentModels).toHaveBeenCalledWith("codex"));
    expect(screen.getByLabelText("Agent")).toHaveValue("codex");

    fireEvent.click(screen.getByRole("button", { name: /schedule/i }));
    expect(screen.getByText("Choose when the day closes")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Preview today’s inputs" }));
    expect(await screen.findByLabelText("Activity timeline for 2026-08-31")).toBeInTheDocument();
    expect(screen.getByText("2 commits")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Save setup" }));
    await waitFor(() => expect(saveConfig).toHaveBeenCalledOnce());
    expect(saveConfig.mock.calls[0][0]).toMatchObject({
      enabled: false,
      agent: { kind: "codex" },
    });
    expect(await screen.findByText("Draft saved")).toBeInTheDocument();
  });
});
