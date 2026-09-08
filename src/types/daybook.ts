import type { AgentKind } from "./agent";

export type DaybookScheduleMode = "afterDayEnds" | "daySoFar";
export type DaybookDestinationKind = "folder" | "obsidian";
export type DaybookSourceStatus =
  "ready" | "disabled" | "notConfigured" | "pending" | "unavailable";

export interface DaybookSchedule {
  mode: DaybookScheduleMode;
  time: string;
  /** ISO weekday numbers: Monday=1, Sunday=7. */
  days: number[];
  catchUp: boolean;
  skipEmpty: boolean;
}

export interface DaybookAgentConfig {
  kind: AgentKind | null;
  model: string | null;
  effort: string | null;
  fast: boolean;
}

export interface DaybookSources {
  git: boolean;
  maestro: boolean;
  slack: boolean;
  slackPrivateChannels: boolean;
  slackDirectMessages: boolean;
  slackThreadContext: boolean;
  jira: boolean;
}

export interface SlackConnection {
  workspaceId: string;
  enterpriseId: string | null;
  userId: string;
  workspaceName: string;
  displayName: string;
  grantedScopes: string[];
  status: string;
  connectedAt: string;
  lastValidatedAt: string | null;
}

export interface SlackOAuthStart {
  authorizationUrl: string;
  expiresAt: string;
}

export interface SlackOAuthPoll {
  status: "waiting" | "connected" | "failed";
  connection: SlackConnection | null;
  detail: string;
}

export interface DaybookDestination {
  kind: DaybookDestinationKind;
  rootPath: string | null;
  vaultName: string | null;
  relativePattern: string;
  appendDailyNote: boolean;
  dailyNoteHeading: string;
}

export interface DaybookConfig {
  schemaVersion: number;
  enabled: boolean;
  timezone: string;
  schedule: DaybookSchedule;
  agent: DaybookAgentConfig;
  sources: DaybookSources;
  destination: DaybookDestination;
}

export interface DaybookOverview {
  config: DaybookConfig;
  configured: boolean;
  integrations: DaybookIntegrations;
}

export interface DaybookIntegrations {
  git: {
    projectCount: number;
    identityCount: number;
    ready: boolean;
  };
  maestro: {
    indexedSessionCount: number;
    ready: boolean;
  };
  slack: {
    oauthAvailable: boolean;
    connections: SlackConnection[];
    desktopFallbackDetected: boolean;
    detail: string;
  };
  jira: {
    environmentFound: boolean;
    keychainFound: boolean;
    missingVariables: string[];
    detail: string;
  };
  obsidian: {
    installed: boolean;
    vaults: Array<{
      name: string;
      path: string;
      dailyNotesEnabled: boolean;
    }>;
  };
  scheduler: {
    systemdUserAvailable: boolean;
    cronAvailable: boolean;
    installed: boolean;
    detail: string;
  };
}

export interface DaybookPreviewRequest {
  date: string | null;
  config: DaybookConfig;
}

export interface DaybookPreviewItem {
  id: string;
  source: "git" | "maestro" | "slack" | "jira";
  occurredAt: string;
  label: string;
  context: string | null;
}

export interface DaybookPreview {
  date: string;
  windowLabel: string;
  counts: {
    commits: number;
    maestroSessions: number;
    slackMessages: number;
    jiraItems: number;
  };
  sources: Array<{
    id: "git" | "maestro" | "slack" | "jira";
    label: string;
    status: DaybookSourceStatus;
    count: number;
    detail: string;
  }>;
  items: DaybookPreviewItem[];
  warnings: string[];
}

export interface DaybookRunResult {
  runId: string;
  date: string;
  /** `saved`, or `skipped` where `skipEmpty` met a day with no activity —
   * a normal outcome, which is why the two fields below are nullable. */
  status: string;
  outputPath: string | null;
  markdown: string | null;
  counts: DaybookPreview["counts"];
}
