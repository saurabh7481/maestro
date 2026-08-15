import { useState } from "react";
import { ArrowClockwise, CheckCircle, WarningCircle, XCircle } from "@phosphor-icons/react";
import { useAgentAvailabilityStore } from "../../state/agentAvailabilityStore";
import { AGENT_KINDS, AGENT_DISPLAY_NAME } from "../../types/agent";
import type { AgentKind, CliStatus } from "../../types/agent";
import { Button, TextInput } from "../primitives";
import styles from "./SettingsModal.module.css";

function statusPill(status: CliStatus | undefined) {
  if (!status) {
    return { tone: "checking" as const, icon: ArrowClockwise, label: "Checking…" };
  }
  if (!status.installed) {
    return { tone: "missing" as const, icon: XCircle, label: "Not installed" };
  }
  if (status.authState === "authenticated") {
    return { tone: "ready" as const, icon: CheckCircle, label: "Ready" };
  }
  if (status.authState === "notAuthenticated") {
    return { tone: "warn" as const, icon: WarningCircle, label: "Needs login" };
  }
  return { tone: "warn" as const, icon: WarningCircle, label: "Unverified" };
}

function AgentCard({ kind }: { kind: AgentKind }) {
  const status = useAgentAvailabilityStore((s) => s.statusByKind[kind]);
  const refresh = useAgentAvailabilityStore((s) => s.refresh);
  const setBinaryPath = useAgentAvailabilityStore((s) => s.setBinaryPath);
  const [pathDraft, setPathDraft] = useState(status?.binaryPath ?? "");
  const [checking, setChecking] = useState(false);
  const pill = statusPill(status);
  const PillIcon = pill.icon;

  async function handleRecheck() {
    setChecking(true);
    try {
      await refresh(kind);
    } finally {
      setChecking(false);
    }
  }

  async function handleSavePath() {
    await setBinaryPath(kind, pathDraft.trim() || null);
  }

  return (
    <div className={styles.agentCard}>
      <div className={styles.agentCardHeader}>
        <div>
          <div className={styles.agentCardName}>{AGENT_DISPLAY_NAME[kind]}</div>
          {status?.version && <div className={styles.agentCardVersion}>{status.version}</div>}
        </div>
        <span className={styles.statusPill} data-tone={checking ? "checking" : pill.tone}>
          <PillIcon size={12} weight="fill" />
          {checking ? "Checking…" : pill.label}
        </span>
      </div>

      {status?.authDetail && <div className={styles.agentDetail}>{status.authDetail}</div>}

      <div className={styles.agentActions}>
        <TextInput
          label="Binary path"
          hint="Leave blank to resolve from PATH"
          placeholder={status?.binaryPath}
          value={pathDraft}
          onChange={(e) => setPathDraft(e.target.value)}
          style={{ flex: 1 }}
        />
        <Button variant="secondary" onClick={() => void handleSavePath()}>
          Save
        </Button>
        <Button variant="ghost" onClick={() => void handleRecheck()} disabled={checking}>
          <ArrowClockwise size={14} />
          Recheck
        </Button>
      </div>
    </div>
  );
}

export function AgentsPane() {
  return (
    <div className={styles.group}>
      <span className={styles.groupLabel}>Agent CLIs</span>
      <p className={styles.placeholder} style={{ marginBottom: "var(--space-2)" }}>
        Detected once at startup and cached — used here, in the new-tab menu, and by "Generate with
        AI" in Source Control. Claude Code has a full interactive tab (Phase 5); Codex and Cursor
        Agent are detected and usable for one-shot actions like commit messages, with full
        interactive tabs landing in a later phase.
      </p>
      {AGENT_KINDS.map((kind) => (
        <AgentCard key={kind} kind={kind} />
      ))}
    </div>
  );
}
