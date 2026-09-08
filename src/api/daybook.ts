import { invoke } from "@tauri-apps/api/core";
import type {
  DaybookConfig,
  DaybookOverview,
  DaybookPreview,
  DaybookRunResult,
  SlackOAuthPoll,
  SlackOAuthStart,
} from "../types/daybook";

export const daybookApi = {
  getOverview: () => invoke<DaybookOverview>("get_daybook_overview"),
  saveConfig: (config: DaybookConfig) => invoke<DaybookConfig>("save_daybook_config", { config }),
  setScheduleEnabled: (config: DaybookConfig, enabled: boolean) =>
    invoke<DaybookConfig>("set_daybook_schedule_enabled", { config, enabled }),
  previewInputs: (config: DaybookConfig, date: string | null = null) =>
    invoke<DaybookPreview>("preview_daybook_inputs", { request: { config, date } }),
  runNow: (config: DaybookConfig, date: string | null = null) =>
    invoke<DaybookRunResult>("run_daybook_now", { request: { config, date } }),
  pickDestination: () => invoke<string | null>("pick_daybook_destination"),
  beginSlackOAuth: (request: { includePrivateChannels: boolean; includeDirectMessages: boolean }) =>
    invoke<SlackOAuthStart>("begin_daybook_slack_oauth", { request }),
  pollSlackOAuth: () => invoke<SlackOAuthPoll>("poll_daybook_slack_oauth"),
  disconnectSlack: (workspaceId: string) =>
    invoke<void>("disconnect_daybook_slack", { workspaceId }),
  importJiraEnvironment: () => invoke<void>("import_daybook_jira_environment"),
  forgetJiraCredentials: () => invoke<void>("forget_daybook_jira_credentials"),
};
