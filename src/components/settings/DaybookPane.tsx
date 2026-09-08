import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  ArrowLeft,
  ArrowRight,
  BookOpenText,
  Check,
  Clock,
  FileText,
  FolderOpen,
  GitBranch,
  Hash,
  Robot,
  ShieldCheck,
  Ticket,
  WarningCircle,
} from "@phosphor-icons/react";
import type { Icon } from "@phosphor-icons/react";
import { daybookApi } from "../../api/daybook";
import { agentsApi } from "../../api/agents";
import { useReadyAgentKinds } from "../../state/agentAvailabilityStore";
import { useToastStore } from "../../state/toastStore";
import { AGENT_DISPLAY_NAME } from "../../types/agent";
import type { AgentKind, ModelOption } from "../../types/agent";
import type {
  DaybookConfig,
  DaybookOverview,
  DaybookPreview,
  DaybookSourceStatus,
  SlackConnection,
} from "../../types/daybook";
import { AlertDialog, Button, Select, Switch, TextInput } from "../primitives";
import {
  DAYBOOK_STEPS,
  DAYBOOK_STEP_LABEL,
  nextDaybookStep,
  sourceStatusLabel,
  sourceTone,
  visibleTimelineItems,
} from "./daybookView";
import type { DaybookStep } from "./daybookView";
import styles from "./DaybookPane.module.css";

const SOURCE_COLOR: Record<string, string> = {
  git: "var(--purple)",
  maestro: "var(--green)",
  slack: "var(--yellow)",
  jira: "var(--blue)",
};

const WEEKDAYS = [
  [1, "Mon"],
  [2, "Tue"],
  [3, "Wed"],
  [4, "Thu"],
  [5, "Fri"],
  [6, "Sat"],
  [7, "Sun"],
] as const;

function sourceConfigStatus(
  enabled: boolean,
  available: boolean,
  implemented: boolean,
): DaybookSourceStatus {
  if (!enabled) return "disabled";
  if (!available) return "notConfigured";
  return implemented ? "ready" : "pending";
}

function StatusPill({ status }: { status: DaybookSourceStatus }) {
  const tone = sourceTone(status);
  const Icon = status === "ready" ? Check : status === "pending" ? Clock : WarningCircle;
  return (
    <span className={styles.statusPill} data-tone={tone}>
      <Icon size={12} weight="bold" />
      {sourceStatusLabel(status)}
    </span>
  );
}

function SourceRow({
  icon: SourceIcon,
  title,
  detail,
  status,
  checked,
  onCheckedChange,
  disabled,
  badge,
  children,
}: {
  icon: Icon;
  title: string;
  detail: string;
  status: DaybookSourceStatus;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  disabled?: boolean;
  badge?: string;
  children?: React.ReactNode;
}) {
  return (
    <div className={styles.sourceCard} data-enabled={checked}>
      <div className={styles.sourceIcon}>
        <SourceIcon size={17} />
      </div>
      <div className={styles.sourceBody}>
        <div className={styles.sourceTitleRow}>
          <span className={styles.sourceTitle}>{title}</span>
          {badge && <span className={styles.experimentalBadge}>{badge}</span>}
        </div>
        <div className={styles.sourceDetail}>{detail}</div>
        {children}
      </div>
      <StatusPill status={status} />
      <Switch
        checked={checked}
        onCheckedChange={onCheckedChange}
        label={`${checked ? "Exclude" : "Include"} ${title}`}
        disabled={disabled}
      />
    </div>
  );
}

function SourcesStep({
  overview,
  config,
  onChange,
  onRefreshIntegrations,
}: {
  overview: DaybookOverview;
  config: DaybookConfig;
  onChange: (config: DaybookConfig) => void;
  onRefreshIntegrations: () => Promise<void>;
}) {
  const { integrations } = overview;
  const [slackWaiting, setSlackWaiting] = useState(false);
  const [slackBusy, setSlackBusy] = useState(false);
  const [slackError, setSlackError] = useState<string | null>(null);
  const [authorizationUrl, setAuthorizationUrl] = useState<string | null>(null);
  const [disconnecting, setDisconnecting] = useState<SlackConnection | null>(null);
  const [jiraBusy, setJiraBusy] = useState(false);
  const [jiraError, setJiraError] = useState<string | null>(null);
  const update = (patch: Partial<DaybookConfig["sources"]>) =>
    onChange({ ...config, sources: { ...config.sources, ...patch } });
  const slackAvailable = integrations.slack.connections.length > 0;

  async function connectSlack() {
    setSlackBusy(true);
    setSlackError(null);
    try {
      const result = await daybookApi.beginSlackOAuth({
        includePrivateChannels: config.sources.slackPrivateChannels,
        includeDirectMessages: config.sources.slackDirectMessages,
      });
      setAuthorizationUrl(result.authorizationUrl);
      setSlackWaiting(true);
      await openUrl(result.authorizationUrl);
    } catch (reason) {
      setSlackError(String(reason));
    } finally {
      setSlackBusy(false);
    }
  }

  useEffect(() => {
    if (!slackWaiting) return;
    let cancelled = false;
    let timer: number | undefined;
    async function poll() {
      try {
        const result = await daybookApi.pollSlackOAuth();
        if (cancelled) return;
        if (result.status === "connected") {
          setSlackWaiting(false);
          setAuthorizationUrl(null);
          update({ slack: true });
          await onRefreshIntegrations();
          return;
        }
        if (result.status === "failed") {
          setSlackWaiting(false);
          setSlackError(result.detail);
          return;
        }
      } catch (reason) {
        if (!cancelled) setSlackError(String(reason));
      }
      if (!cancelled) timer = window.setTimeout(() => void poll(), 1200);
    }
    void poll();
    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
    // `update` intentionally uses the latest render only after a terminal
    // OAuth result; changing setup toggles must not restart the poll loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slackWaiting, onRefreshIntegrations]);

  async function disconnectSlack(connection: SlackConnection) {
    setSlackBusy(true);
    setSlackError(null);
    try {
      await daybookApi.disconnectSlack(connection.workspaceId);
      await onRefreshIntegrations();
      if (integrations.slack.connections.length === 1) update({ slack: false });
    } catch (reason) {
      setSlackError(String(reason));
    } finally {
      setSlackBusy(false);
      setDisconnecting(null);
    }
  }

  async function importJira() {
    setJiraBusy(true);
    setJiraError(null);
    try {
      await daybookApi.importJiraEnvironment();
      await onRefreshIntegrations();
    } catch (reason) {
      setJiraError(String(reason));
    } finally {
      setJiraBusy(false);
    }
  }

  async function forgetJira() {
    setJiraBusy(true);
    setJiraError(null);
    try {
      await daybookApi.forgetJiraCredentials();
      await onRefreshIntegrations();
      if (!integrations.jira.environmentFound) update({ jira: false });
    } catch (reason) {
      setJiraError(String(reason));
    } finally {
      setJiraBusy(false);
    }
  }

  return (
    <div className={styles.stepBody}>
      <div>
        <div className={styles.stepTitle}>Choose what belongs in the record</div>
        <p className={styles.stepCopy}>
          Daybook reads personal activity only. Preview shows the exact evidence before an agent
          receives it.
        </p>
      </div>

      <div className={styles.sourceList}>
        <SourceRow
          icon={GitBranch}
          title="Git"
          detail={`${integrations.git.projectCount} registered project${integrations.git.projectCount === 1 ? "" : "s"} · ${integrations.git.identityCount} author ${integrations.git.identityCount === 1 ? "identity" : "identities"}`}
          status={sourceConfigStatus(config.sources.git, integrations.git.ready, true)}
          checked={config.sources.git}
          onCheckedChange={(git) => update({ git })}
        />
        <SourceRow
          icon={Robot}
          title="Maestro activity"
          detail={`${integrations.maestro.indexedSessionCount} indexed agent session${integrations.maestro.indexedSessionCount === 1 ? "" : "s"} · prompts and tool payloads stay out of this preview`}
          status={sourceConfigStatus(config.sources.maestro, integrations.maestro.ready, true)}
          checked={config.sources.maestro}
          onCheckedChange={(maestro) => update({ maestro })}
        />
        <SourceRow
          icon={Hash}
          title="Slack"
          detail={integrations.slack.detail}
          status={sourceConfigStatus(config.sources.slack, slackAvailable, true)}
          checked={config.sources.slack}
          disabled={!slackAvailable}
          onCheckedChange={(slack) =>
            update({
              slack,
              slackDirectMessages: slack ? config.sources.slackDirectMessages : false,
            })
          }
        >
          <div className={styles.slackPermissions}>
            <label className={styles.inlineChoice}>
              <input type="checkbox" checked disabled />
              Public channels
              <span>Required</span>
            </label>
            <label className={styles.inlineChoice}>
              <input
                type="checkbox"
                checked={config.sources.slackPrivateChannels}
                disabled={slackWaiting}
                onChange={(event) => update({ slackPrivateChannels: event.target.checked })}
              />
              Private channels you can access
              <span>Optional</span>
            </label>
            <label className={styles.inlineChoice}>
              <input
                type="checkbox"
                checked={config.sources.slackDirectMessages}
                disabled={slackWaiting}
                onChange={(event) => update({ slackDirectMessages: event.target.checked })}
              />
              Direct messages
              <span>Off by default</span>
            </label>
            <label className={styles.inlineChoice}>
              <input
                type="checkbox"
                checked={config.sources.slackThreadContext}
                onChange={(event) => update({ slackThreadContext: event.target.checked })}
              />
              Include thread context around your messages
            </label>
          </div>

          {integrations.slack.connections.length > 0 && (
            <div className={styles.slackConnections}>
              {integrations.slack.connections.map((connection) => (
                <div key={connection.workspaceId} className={styles.slackConnectionRow}>
                  <span className={styles.workspaceMark}>{connection.workspaceName.charAt(0)}</span>
                  <span>
                    <strong>{connection.workspaceName}</strong>
                    <small>
                      {connection.displayName} · {connection.grantedScopes.length} granted scope
                      {connection.grantedScopes.length === 1 ? "" : "s"}
                    </small>
                  </span>
                  <Button
                    variant="ghost"
                    disabled={slackBusy}
                    onClick={() => setDisconnecting(connection)}
                  >
                    Disconnect
                  </Button>
                </div>
              ))}
            </div>
          )}

          <div className={styles.slackActions}>
            <Button
              variant="secondary"
              disabled={!integrations.slack.oauthAvailable || slackBusy || slackWaiting}
              onClick={() => void connectSlack()}
            >
              {slackBusy ? "Starting…" : "Connect workspace"}
            </Button>
            {slackWaiting && <span>Waiting for Slack approval…</span>}
            {slackWaiting && authorizationUrl && (
              <Button variant="ghost" onClick={() => void openUrl(authorizationUrl)}>
                Open browser again
              </Button>
            )}
          </div>
          {slackError && <div className={styles.integrationError}>{slackError}</div>}
          {!integrations.slack.oauthAvailable && integrations.slack.desktopFallbackDetected && (
            <div className={styles.fallbackNote}>
              Slack Desktop is installed, but its session is not used automatically. OAuth keeps
              access revocable and workspace-scoped.
            </div>
          )}
        </SourceRow>
        <SourceRow
          icon={Ticket}
          title="Jira"
          detail={integrations.jira.detail}
          status={sourceConfigStatus(
            config.sources.jira,
            integrations.jira.environmentFound || integrations.jira.keychainFound,
            true,
          )}
          checked={config.sources.jira}
          disabled={!integrations.jira.environmentFound && !integrations.jira.keychainFound}
          onCheckedChange={(jira) => update({ jira })}
        >
          <div className={styles.slackActions}>
            {integrations.jira.environmentFound && !integrations.jira.keychainFound && (
              <Button variant="secondary" disabled={jiraBusy} onClick={() => void importJira()}>
                {jiraBusy ? "Importing…" : "Import for scheduled runs"}
              </Button>
            )}
            {integrations.jira.keychainFound && (
              <Button variant="ghost" disabled={jiraBusy} onClick={() => void forgetJira()}>
                Forget credentials
              </Button>
            )}
          </div>
          {jiraError && <div className={styles.integrationError}>{jiraError}</div>}
        </SourceRow>
      </div>

      <div className={styles.privacyNote}>
        <ShieldCheck size={16} color="var(--green)" />
        <span>
          Slack tokens stay in the OS keychain. Jira tokens never enter React, the preview, or
          Daybook’s SQLite configuration.
        </span>
      </div>

      <AlertDialog
        open={disconnecting !== null}
        onOpenChange={(open) => !open && setDisconnecting(null)}
        title={`Disconnect ${disconnecting?.workspaceName ?? "Slack"}?`}
        description="Maestro will revoke this workspace token when possible and remove its local keychain entry. You can reconnect later."
        confirmLabel="Disconnect"
        confirmDisabled={slackBusy}
        onConfirm={() => void disconnectSlack(disconnecting!)}
      />
    </div>
  );
}

function WriterStep({
  config,
  onChange,
  readyKinds,
}: {
  config: DaybookConfig;
  onChange: (config: DaybookConfig) => void;
  readyKinds: AgentKind[];
}) {
  const [models, setModels] = useState<ModelOption[]>([]);
  const [loadingModels, setLoadingModels] = useState(false);
  const kind = config.agent.kind;

  useEffect(() => {
    if (!kind) {
      return;
    }
    let cancelled = false;
    void agentsApi
      .listAgentModels(kind)
      .then((options) => {
        if (!cancelled) setModels(options);
      })
      .catch(() => {
        if (!cancelled) setModels([]);
      })
      .finally(() => {
        if (!cancelled) setLoadingModels(false);
      });
    return () => {
      cancelled = true;
    };
  }, [kind]);

  function updateAgent(patch: Partial<DaybookConfig["agent"]>) {
    onChange({ ...config, agent: { ...config.agent, ...patch } });
  }

  const selectedModel = models.find(
    (model) =>
      model.id === config.agent.model ||
      model.variants.some((variant) => variant.id === config.agent.model),
  );
  const selectedVariant = selectedModel?.variants.find(
    (variant) => variant.id === config.agent.model,
  );
  const efforts = selectedModel?.supportedEfforts ?? [];
  const selectedEffort = selectedVariant?.effort ?? config.agent.effort ?? "";

  function selectModel(modelId: string) {
    const option = models.find((candidate) => candidate.id === modelId);
    if (!option) {
      updateAgent({ model: modelId || null, effort: null });
      return;
    }
    const defaultEffort = option.supportedEfforts[0] ?? null;
    const variant = option.variants.find(
      (candidate) => candidate.effort === defaultEffort && !candidate.thinking && !candidate.fast,
    );
    updateAgent({
      model: variant?.id ?? option.variants[0]?.id ?? option.id,
      effort: option.variants.length > 0 ? null : defaultEffort,
    });
  }

  function selectEffort(effort: string) {
    if (!selectedModel?.variants.length) {
      updateAgent({ effort: effort || null });
      return;
    }
    const variant = selectedModel.variants.find(
      (candidate) => candidate.effort === effort && !candidate.thinking && !candidate.fast,
    );
    updateAgent({ model: variant?.id ?? config.agent.model, effort: null });
  }

  return (
    <div className={styles.stepBody}>
      <div>
        <div className={styles.stepTitle}>Choose who writes the entry</div>
        <p className={styles.stepCopy}>
          Daybook uses Maestro’s existing authenticated CLI. The writing turn receives bounded
          evidence and runs with every tool disabled.
        </p>
      </div>

      {readyKinds.length === 0 ? (
        <div className={styles.emptyState}>
          <WarningCircle size={18} color="var(--yellow)" />
          <div>
            <strong>No writer is ready</strong>
            <span>Sign in to an agent under Agents &amp; CLI, then return here.</span>
          </div>
        </div>
      ) : (
        <div className={styles.fieldGrid}>
          <Select
            label="Agent"
            value={kind ?? ""}
            onChange={(event) =>
              updateAgent({ kind: event.target.value as AgentKind, model: null, effort: null })
            }
          >
            <option value="" disabled>
              Choose an agent
            </option>
            {readyKinds.map((option) => (
              <option key={option} value={option}>
                {AGENT_DISPLAY_NAME[option]}
              </option>
            ))}
          </Select>
          <Select
            label="Model"
            hint={loadingModels ? "Reading models from the selected CLI…" : undefined}
            value={selectedModel?.id ?? config.agent.model ?? ""}
            disabled={!kind || loadingModels || models.length === 0}
            onChange={(event) => selectModel(event.target.value)}
          >
            <option value="">CLI default</option>
            {models.map((model) => (
              <option key={model.id} value={model.id}>
                {model.label}
              </option>
            ))}
          </Select>
          <Select
            label="Effort"
            value={selectedEffort}
            disabled={efforts.length === 0}
            onChange={(event) => selectEffort(event.target.value)}
          >
            <option value="">Model default</option>
            {efforts.map((effort) => (
              <option key={effort} value={effort}>
                {effort}
              </option>
            ))}
          </Select>
        </div>
      )}

      <div className={styles.dataContract}>
        <div className={styles.dataContractTitle}>Data sent to this agent</div>
        <ul>
          {config.sources.git && <li>Commit metadata, messages, and file statistics</li>}
          {config.sources.maestro && <li>Session titles and completion metadata</li>}
          {config.sources.slack && <li>Your included Slack message text</li>}
          {config.sources.jira && <li>Your Jira worklogs, comments, and transitions</li>}
        </ul>
      </div>
    </div>
  );
}

function DestinationStep({
  overview,
  config,
  onChange,
}: {
  overview: DaybookOverview;
  config: DaybookConfig;
  onChange: (config: DaybookConfig) => void;
}) {
  const [picking, setPicking] = useState(false);

  function selectDestination(
    kind: DaybookConfig["destination"]["kind"],
    rootPath: string,
    vaultName: string | null,
  ) {
    onChange({
      ...config,
      destination: { ...config.destination, kind, rootPath, vaultName },
    });
  }

  async function chooseFolder() {
    setPicking(true);
    try {
      const path = await daybookApi.pickDestination();
      if (path) selectDestination("folder", path, null);
    } finally {
      setPicking(false);
    }
  }

  return (
    <div className={styles.stepBody}>
      <div>
        <div className={styles.stepTitle}>Choose where the record lives</div>
        <p className={styles.stepCopy}>
          Daybook writes plain Markdown. Re-running a date updates one managed section and preserves
          anything you add around it.
        </p>
      </div>

      <div className={styles.destinationList}>
        {overview.integrations.obsidian.vaults.map((vault) => {
          const active =
            config.destination.kind === "obsidian" && config.destination.rootPath === vault.path;
          return (
            <button
              key={vault.path}
              type="button"
              className={styles.destinationCard}
              data-active={active}
              onClick={() => selectDestination("obsidian", vault.path, vault.name)}
            >
              <BookOpenText size={20} color={active ? "var(--accent)" : "var(--text-dim)"} />
              <span className={styles.destinationText}>
                <strong>{vault.name}</strong>
                <span>{vault.path}</span>
              </span>
              {vault.dailyNotesEnabled && <span className={styles.smallBadge}>Daily Notes</span>}
              {active && <Check size={16} color="var(--accent)" weight="bold" />}
            </button>
          );
        })}
        <button
          type="button"
          className={styles.destinationCard}
          data-active={config.destination.kind === "folder" && !!config.destination.rootPath}
          onClick={() => void chooseFolder()}
        >
          <FolderOpen size={20} color="var(--text-dim)" />
          <span className={styles.destinationText}>
            <strong>Markdown folder</strong>
            <span>
              {config.destination.kind === "folder" && config.destination.rootPath
                ? config.destination.rootPath
                : "Choose any local folder"}
            </span>
          </span>
          <span className={styles.smallBadge}>{picking ? "Choosing…" : "Choose"}</span>
        </button>
      </div>

      <TextInput
        label="File pattern"
        hint="YYYY and YYYY-MM-DD are replaced for each entry. The path must stay inside the destination."
        value={config.destination.relativePattern}
        onChange={(event) =>
          onChange({
            ...config,
            destination: { ...config.destination, relativePattern: event.target.value },
          })
        }
      />
      <div className={styles.pathPreview}>
        <FileText size={14} />
        {config.destination.rootPath ? (
          <span>
            {config.destination.rootPath}/{config.destination.relativePattern}
          </span>
        ) : (
          <span>Choose a destination to complete setup.</span>
        )}
      </div>
    </div>
  );
}

function DayStrip({ preview }: { preview: DaybookPreview }) {
  const items = useMemo(() => visibleTimelineItems(preview.items), [preview.items]);
  return (
    <div className={styles.previewCard}>
      <div className={styles.previewHeader}>
        <div>
          <div className={styles.previewTitle}>Input preview</div>
          <div className={styles.previewWindow}>{preview.windowLabel}</div>
        </div>
        <div className={styles.previewCounts}>
          <span>{preview.counts.commits} commits</span>
          <span>{preview.counts.maestroSessions} sessions</span>
        </div>
      </div>
      <div className={styles.dayStrip} aria-label={`Activity timeline for ${preview.date}`}>
        <div className={styles.stripTrack} />
        {[0, 6, 12, 18, 24].map((hour) => (
          <span key={hour} className={styles.stripHour} style={{ left: `${(hour / 24) * 100}%` }}>
            {String(hour).padStart(2, "0")}
          </span>
        ))}
        {items.map((item) => (
          <span
            key={item.id}
            className={styles.stripMark}
            style={{ left: `${item.position}%`, background: SOURCE_COLOR[item.source] }}
            title={`${new Date(item.occurredAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })} · ${item.label}`}
          />
        ))}
      </div>
      <div className={styles.sourceSummary}>
        {preview.sources.map((source) => (
          <div key={source.id} className={styles.sourceSummaryRow}>
            <span className={styles.sourceDot} style={{ background: SOURCE_COLOR[source.id] }} />
            <span>{source.label}</span>
            <span className={styles.sourceSummaryDetail}>{source.detail}</span>
            <span className={styles.sourceSummaryCount}>{source.count}</span>
            <StatusPill status={source.status} />
          </div>
        ))}
      </div>
      {preview.warnings.length > 0 && (
        <div className={styles.previewWarnings}>
          {preview.warnings.map((warning) => (
            <div key={warning}>
              <WarningCircle size={14} /> {warning}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function ScheduleStep({
  overview,
  config,
  onChange,
  preview,
  previewing,
  onPreview,
  writing,
  onWrite,
  scheduleBusy,
  onScheduleEnabledChange,
}: {
  overview: DaybookOverview;
  config: DaybookConfig;
  onChange: (config: DaybookConfig) => void;
  preview: DaybookPreview | null;
  previewing: boolean;
  onPreview: () => void;
  writing: boolean;
  onWrite: () => void;
  scheduleBusy: boolean;
  onScheduleEnabledChange: (enabled: boolean) => void;
}) {
  function updateSchedule(patch: Partial<DaybookConfig["schedule"]>) {
    onChange({ ...config, schedule: { ...config.schedule, ...patch } });
  }

  return (
    <div className={styles.stepBody}>
      <div>
        <div className={styles.stepTitle}>Choose when the day closes</div>
        <p className={styles.stepCopy}>
          This slice saves the schedule draft. Maestro will enable it only after the headless runner
          verifies the OS timer and selected agent.
        </p>
      </div>

      <div className={styles.scheduleModes}>
        <button
          type="button"
          className={styles.scheduleMode}
          data-active={config.schedule.mode === "afterDayEnds"}
          onClick={() => updateSchedule({ mode: "afterDayEnds", time: "00:10" })}
        >
          <span className={styles.radioMark} />
          <span>
            <strong>After the day ends</strong>
            <small>Write the complete previous calendar day.</small>
          </span>
          <span className={styles.recommended}>Recommended</span>
        </button>
        <button
          type="button"
          className={styles.scheduleMode}
          data-active={config.schedule.mode === "daySoFar"}
          onClick={() => updateSchedule({ mode: "daySoFar", time: "20:00" })}
        >
          <span className={styles.radioMark} />
          <span>
            <strong>At a chosen time</strong>
            <small>Write the current calendar day up to this time.</small>
          </span>
        </button>
      </div>

      <div className={styles.fieldGrid}>
        <TextInput
          type="time"
          label="Run time"
          value={config.schedule.time}
          onChange={(event) => updateSchedule({ time: event.target.value })}
        />
        <TextInput
          label="Time zone"
          value={config.timezone}
          onChange={(event) => onChange({ ...config, timezone: event.target.value })}
        />
      </div>

      <div className={styles.dayField}>
        <span>Days to include</span>
        <div className={styles.dayPicker}>
          {WEEKDAYS.map(([value, label]) => {
            const selected = config.schedule.days.includes(value);
            return (
              <button
                key={value}
                type="button"
                data-selected={selected}
                aria-pressed={selected}
                onClick={() => {
                  const days = selected
                    ? config.schedule.days.filter((day) => day !== value)
                    : [...config.schedule.days, value].sort((left, right) => left - right);
                  if (days.length > 0) updateSchedule({ days });
                }}
              >
                {label}
              </button>
            );
          })}
        </div>
        <small>
          {config.schedule.mode === "afterDayEnds"
            ? "Each selected day is written just after it ends."
            : "Daybook runs on each selected day."}
        </small>
      </div>

      <div className={styles.toggleRows}>
        <label className={styles.toggleRow}>
          <span>
            <strong>Catch up after wake or login</strong>
            <small>Only for a missed entry no more than 36 hours old.</small>
          </span>
          <Switch
            checked={config.schedule.catchUp}
            onCheckedChange={(catchUp) => updateSchedule({ catchUp })}
            label="Catch up after wake or login"
          />
        </label>
        <label className={styles.toggleRow}>
          <span>
            <strong>Skip empty days</strong>
            <small>Do not create a note when every included source is empty.</small>
          </span>
          <Switch
            checked={config.schedule.skipEmpty}
            onCheckedChange={(skipEmpty) => updateSchedule({ skipEmpty })}
            label="Skip empty days"
          />
        </label>
      </div>

      <div className={styles.schedulerNote}>
        <Clock size={15} />
        <span>
          <strong>{config.enabled ? "Schedule active" : "Schedule off"}</strong>
          <br />
          {overview.integrations.scheduler.detail}
        </span>
        <Switch
          checked={config.enabled}
          disabled={scheduleBusy || !overview.integrations.scheduler.systemdUserAvailable}
          onCheckedChange={onScheduleEnabledChange}
          label="Enable Daybook schedule"
        />
      </div>

      <div className={styles.previewAction}>
        <Button variant="secondary" onClick={onPreview} disabled={previewing}>
          {previewing ? "Collecting inputs…" : "Preview today’s inputs"}
        </Button>
        <Button
          variant="primary"
          onClick={onWrite}
          disabled={writing || !config.agent.kind || !config.destination.rootPath}
        >
          {writing ? "Writing entry…" : "Write today’s entry"}
        </Button>
        <span>Preview is read-only; Write uses the selected agent and destination.</span>
      </div>
      {preview && <DayStrip preview={preview} />}
    </div>
  );
}

export function DaybookPane() {
  const readyKinds = useReadyAgentKinds();
  const initialReadyKind = useRef(readyKinds[0] ?? null);
  const pushToast = useToastStore((state) => state.push);
  const [overview, setOverview] = useState<DaybookOverview | null>(null);
  const [config, setConfig] = useState<DaybookConfig | null>(null);
  const [step, setStep] = useState<DaybookStep>("sources");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  const [writing, setWriting] = useState(false);
  const [scheduleBusy, setScheduleBusy] = useState(false);
  const [preview, setPreview] = useState<DaybookPreview | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refreshIntegrations = useCallback(async () => {
    const result = await daybookApi.getOverview();
    setOverview((current) =>
      current
        ? { ...current, integrations: result.integrations, configured: result.configured }
        : result,
    );
  }, []);

  useEffect(() => {
    let cancelled = false;
    void daybookApi
      .getOverview()
      .then((result) => {
        if (cancelled) return;
        setOverview(result);
        setConfig(
          result.config.agent.kind || !initialReadyKind.current
            ? result.config
            : {
                ...result.config,
                agent: { ...result.config.agent, kind: initialReadyKind.current },
              },
        );
      })
      .catch((reason) => {
        if (!cancelled) setError(String(reason));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function saveDraft() {
    if (!config) return;
    setSaving(true);
    setError(null);
    try {
      const saved = await daybookApi.saveConfig(config);
      setConfig(saved);
      setOverview((current) =>
        current ? { ...current, config: saved, configured: true } : current,
      );
      pushToast({
        tone: "success",
        title: "Daybook setup saved",
        description: saved.enabled
          ? "The active systemd timer was updated with this setup."
          : "The schedule remains off until you enable it on the Schedule step.",
      });
    } catch (reason) {
      setError(String(reason));
    } finally {
      setSaving(false);
    }
  }

  async function previewInputs() {
    if (!config) return;
    setPreviewing(true);
    setError(null);
    try {
      setPreview(await daybookApi.previewInputs(config));
    } catch (reason) {
      setError(String(reason));
    } finally {
      setPreviewing(false);
    }
  }

  async function writeEntry() {
    if (!config) return;
    setWriting(true);
    setError(null);
    try {
      const result = await daybookApi.runNow(config);
      pushToast({
        tone: "success",
        // A skipped day is a success with nothing to open — saying
        // "entry written" and pointing at no file would be a lie.
        title: result.outputPath ? "Daybook entry written" : "Daybook skipped this day",
        description:
          result.outputPath ?? "Every included source was empty, so no entry was written.",
      });
      setPreview(await daybookApi.previewInputs(config));
    } catch (reason) {
      setError(String(reason));
    } finally {
      setWriting(false);
    }
  }

  async function setScheduleEnabled(enabled: boolean) {
    if (!config) return;
    setScheduleBusy(true);
    setError(null);
    try {
      const saved = await daybookApi.setScheduleEnabled(config, enabled);
      setConfig(saved);
      await refreshIntegrations();
      pushToast({
        tone: "success",
        title: enabled ? "Daybook schedule enabled" : "Daybook schedule disabled",
        description: enabled
          ? "A verified systemd user timer will run even when Maestro is closed."
          : "The systemd user timer was removed.",
      });
    } catch (reason) {
      setError(String(reason));
    } finally {
      setScheduleBusy(false);
    }
  }

  if (loading) {
    return <div className={styles.loading}>Reading Daybook setup…</div>;
  }
  if (!overview || !config) {
    return (
      <div className={styles.emptyState}>
        <WarningCircle size={18} color="var(--red)" />
        <div>
          <strong>Daybook setup could not be read</strong>
          <span>{error ?? "No configuration was returned."}</span>
        </div>
      </div>
    );
  }

  const stepIndex = DAYBOOK_STEPS.indexOf(step);
  const canContinue = step !== "writer" || readyKinds.length === 0 || config.agent.kind !== null;

  return (
    <div className={styles.root}>
      <div className={styles.intro}>
        <div>
          <div className={styles.eyebrow}>Private work ledger</div>
          <p>A source-linked record of what moved, written where your notes live.</p>
        </div>
        <span className={styles.draftPill} data-saved={overview.configured}>
          {overview.configured ? "Draft saved" : "Not configured"}
        </span>
      </div>

      <div className={styles.steps} aria-label="Daybook setup progress">
        {DAYBOOK_STEPS.map((item, index) => (
          <button
            key={item}
            type="button"
            className={styles.stepButton}
            data-active={item === step}
            data-complete={index < stepIndex}
            onClick={() => setStep(item)}
          >
            <span>{index < stepIndex ? <Check size={12} weight="bold" /> : index + 1}</span>
            {DAYBOOK_STEP_LABEL[item]}
          </button>
        ))}
      </div>

      {step === "sources" && (
        <SourcesStep
          overview={overview}
          config={config}
          onChange={setConfig}
          onRefreshIntegrations={refreshIntegrations}
        />
      )}
      {step === "writer" && (
        <WriterStep config={config} onChange={setConfig} readyKinds={readyKinds} />
      )}
      {step === "destination" && (
        <DestinationStep overview={overview} config={config} onChange={setConfig} />
      )}
      {step === "schedule" && (
        <ScheduleStep
          overview={overview}
          config={config}
          onChange={setConfig}
          preview={preview}
          previewing={previewing}
          onPreview={() => void previewInputs()}
          writing={writing}
          onWrite={() => void writeEntry()}
          scheduleBusy={scheduleBusy}
          onScheduleEnabledChange={(enabled) => void setScheduleEnabled(enabled)}
        />
      )}

      {error && (
        <div className={styles.errorBanner}>
          <WarningCircle size={15} />
          {error}
        </div>
      )}

      <div className={styles.footer}>
        <Button
          variant="ghost"
          disabled={stepIndex === 0}
          onClick={() => setStep(nextDaybookStep(step, -1))}
        >
          <ArrowLeft size={14} /> Back
        </Button>
        <span className={styles.footerNote}>
          {stepIndex + 1} of {DAYBOOK_STEPS.length}
        </span>
        {stepIndex < DAYBOOK_STEPS.length - 1 ? (
          <Button
            variant="primary"
            disabled={!canContinue}
            onClick={() => setStep(nextDaybookStep(step, 1))}
          >
            Continue <ArrowRight size={14} />
          </Button>
        ) : (
          <Button variant="primary" onClick={() => void saveDraft()} disabled={saving}>
            {saving ? "Saving…" : "Save setup"}
          </Button>
        )}
      </div>
    </div>
  );
}
