import { useEffect, useState } from "react";
import { ArrowClockwise, CheckCircle, Code, WarningCircle, XCircle } from "@phosphor-icons/react";
import { lspApi } from "../../api/lsp";
import { useLspStore } from "../../state/lspStore";
import { refreshLspRuntime } from "../../lsp/runtimeBridge";
import { LSP_SERVER_KINDS } from "../../types/lsp";
import type { LspServerKind, LspServerStatus, ProjectLspSettings } from "../../types/lsp";
import { Button, Switch, TextInput } from "../primitives";
import styles from "./SettingsModal.module.css";

export type LanguageIntelligenceScope =
  { kind: "global" } | { kind: "project"; projectId: string; projectName: string };

function serverPill(status: LspServerStatus | undefined) {
  if (!status) return { tone: "checking", icon: ArrowClockwise, label: "Checking…" };
  if (status.availability === "ready") return { tone: "ready", icon: CheckCircle, label: "Ready" };
  if (status.availability === "missing")
    return { tone: "missing", icon: XCircle, label: "Not installed" };
  return { tone: "warn", icon: WarningCircle, label: "Unavailable" };
}

function ServerCard({ kind }: { kind: LspServerKind }) {
  const status = useLspStore((state) => state.statusByKind[kind]);
  const recheck = useLspStore((state) => state.recheck);
  const setBinaryPath = useLspStore((state) => state.setBinaryPath);
  const typeScriptSdkPath = useLspStore((state) => state.typeScriptSdkPath);
  const setTypeScriptSdkPath = useLspStore((state) => state.setTypeScriptSdkPath);
  const [draft, setDraft] = useState("");
  const [sdkDraft, setSdkDraft] = useState("");
  const [checking, setChecking] = useState(false);
  const pill = serverPill(status);
  const pillLabel =
    kind === "typeScript" && status?.availability === "ready" ? "Server found" : pill.label;
  const PillIcon = pill.icon;

  async function handleRecheck() {
    setChecking(true);
    try {
      await recheck(kind);
    } finally {
      setChecking(false);
    }
  }

  return (
    <div className={styles.agentCard}>
      <div className={styles.agentCardHeader}>
        <div>
          <div className={styles.agentCardName}>{status?.displayName ?? kind}</div>
          {status?.version && <div className={styles.agentCardVersion}>{status.version}</div>}
        </div>
        <span className={styles.statusPill} data-tone={checking ? "checking" : pill.tone}>
          <PillIcon size={12} weight="fill" />
          {checking ? "Checking…" : pillLabel}
        </span>
      </div>
      {status?.detail && <div className={styles.agentDetail}>{status.detail}</div>}
      {status?.availability === "missing" && (
        <div className={styles.agentDetail}>
          Install: <code>{status.installHint}</code>
        </div>
      )}
      {kind === "typeScript" && status?.availability === "ready" && (
        <div className={styles.agentDetail}>
          The LSP wrapper is installed. A compatible TypeScript SDK is selected separately for each
          worktree when a TypeScript or JavaScript file opens.
        </div>
      )}
      <div className={styles.agentActions}>
        <TextInput
          label="Binary path"
          hint="Command name or absolute path"
          placeholder={status?.binaryPath}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          style={{ flex: 1 }}
        />
        <Button variant="secondary" onClick={() => void setBinaryPath(kind, draft.trim() || null)}>
          Save
        </Button>
        <Button variant="ghost" disabled={checking} onClick={() => void handleRecheck()}>
          <ArrowClockwise size={14} /> Recheck
        </Button>
      </div>
      {kind === "typeScript" && (
        <div className={styles.agentActions}>
          <TextInput
            label="TypeScript SDK path"
            hint="Optional package, lib directory, or tsserver.js override"
            placeholder={typeScriptSdkPath ?? "Prefer the worktree's TypeScript SDK"}
            value={sdkDraft}
            onChange={(event) => setSdkDraft(event.target.value)}
            style={{ flex: 1 }}
          />
          <Button
            variant="secondary"
            onClick={() => void setTypeScriptSdkPath(sdkDraft.trim() || null)}
          >
            Save SDK
          </Button>
        </div>
      )}
    </div>
  );
}

function GlobalPane() {
  const settings = useLspStore((state) => state.globalSettings);
  const loading = useLspStore((state) => state.loading);
  const load = useLspStore((state) => state.load);
  const setGlobalEnabled = useLspStore((state) => state.setGlobalEnabled);

  useEffect(() => {
    if (!settings) void load();
  }, [load, settings]);

  if (!settings)
    return <p className={styles.placeholder}>{loading ? "Checking servers…" : "Loading…"}</p>;

  return (
    <>
      <div className={styles.group}>
        <div className={styles.presetRow}>
          <Code size={18} color="var(--accent-2)" />
          <div className={styles.presetText}>
            <div className={styles.presetTitle}>Language intelligence</div>
            <div className={styles.presetDescription}>
              Enables language servers by default. Individual projects can override this setting.
            </div>
          </div>
          <Switch
            label="Language intelligence"
            checked={settings.enabled}
            onCheckedChange={(enabled) => void setGlobalEnabled(enabled)}
          />
        </div>
      </div>
      <div className={styles.group}>
        <span className={styles.groupLabel}>Language servers</span>
        {LSP_SERVER_KINDS.map((kind) => (
          <ServerCard key={kind} kind={kind} />
        ))}
      </div>
    </>
  );
}

function ProjectPane({ projectId, projectName }: { projectId: string; projectName: string }) {
  const [settings, setSettings] = useState<ProjectLspSettings | null>(null);
  useEffect(() => {
    void lspApi.getProjectSettings(projectId).then(setSettings);
  }, [projectId]);
  if (!settings) return <p className={styles.placeholder}>Loading…</p>;

  async function update(enabledOverride: boolean | null) {
    setSettings(await lspApi.setProjectSettings(projectId, enabledOverride));
    await refreshLspRuntime();
  }

  return (
    <div className={styles.group}>
      <span className={styles.groupLabel}>Project override</span>
      <p className={styles.placeholder}>
        {projectName} is currently{" "}
        <strong>{settings.effectiveEnabled ? "enabled" : "disabled"}</strong>. A project override
        takes precedence over the global default.
      </p>
      <div className={styles.agentActions} role="group" aria-label="Language intelligence setting">
        <Button
          variant={settings.enabledOverride === null ? "primary" : "secondary"}
          onClick={() => void update(null)}
        >
          Inherit global
        </Button>
        <Button
          variant={settings.enabledOverride === true ? "primary" : "secondary"}
          onClick={() => void update(true)}
        >
          Enabled
        </Button>
        <Button
          variant={settings.enabledOverride === false ? "primary" : "secondary"}
          onClick={() => void update(false)}
        >
          Disabled
        </Button>
      </div>
    </div>
  );
}

export function LanguageIntelligencePane({ scope }: { scope: LanguageIntelligenceScope }) {
  return scope.kind === "global" ? (
    <GlobalPane />
  ) : (
    <ProjectPane projectId={scope.projectId} projectName={scope.projectName} />
  );
}
