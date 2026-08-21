import { useRef, useState } from "react";
import { ArrowClockwise, CheckCircle, SignIn, WarningCircle, XCircle } from "@phosphor-icons/react";
import { useAgentAvailabilityStore } from "../../state/agentAvailabilityStore";
import { useTabsStore } from "../../state/tabsStore";
import { useActiveWorktree } from "../../state/workspaceStore";
import { useUiStore } from "../../state/uiStore";
import { AGENT_KINDS, AGENT_DISPLAY_NAME } from "../../types/agent";
import type { AgentKind, CliStatus } from "../../types/agent";
import { Button, TextInput } from "../primitives";
import { AiderProviders } from "./AiderProvidersPane";
import { OpenCodeProviders } from "./OpenCodeProviders";
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
    // The backend supplies the wording where the generic one would be
    // wrong — Aider has no login to need.
    return {
      tone: "warn" as const,
      icon: WarningCircle,
      label: status.authLabel ?? "Needs login",
    };
  }
  return { tone: "warn" as const, icon: WarningCircle, label: "Unverified" };
}

function AgentCard({ kind }: { kind: AgentKind }) {
  const status = useAgentAvailabilityStore((s) => s.statusByKind[kind]);
  const refresh = useAgentAvailabilityStore((s) => s.refresh);
  const setBinaryPath = useAgentAvailabilityStore((s) => s.setBinaryPath);
  const openTab = useTabsStore((s) => s.openTab);
  const closeSettings = useUiStore((s) => s.closeSettings);
  const activeWorktree = useActiveWorktree();
  const [pathDraft, setPathDraft] = useState(status?.binaryPath ?? "");
  const [checking, setChecking] = useState(false);
  const providersRef = useRef<HTMLDivElement | null>(null);
  const pill = statusPill(status);
  const PillIcon = pill.icon;
  const remedy = status?.authRemedy ?? null;

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

  /** Runs the CLI's own login in a terminal tab. These logins open a
   * browser themselves where their flow needs one — there is no page
   * Maestro could open that would authenticate the CLI instead. */
  function signIn(command: string) {
    if (!activeWorktree) return;
    openTab({
      id: crypto.randomUUID(),
      type: "terminal",
      title: `Sign in — ${AGENT_DISPLAY_NAME[kind]}`,
      worktreeRoot: activeWorktree.path,
      initialCommand: command,
    });
    closeSettings();
  }

  return (
    <div className={styles.agentCard}>
      <div className={styles.agentCardHeader}>
        <div>
          <div className={styles.agentCardName}>{AGENT_DISPLAY_NAME[kind]}</div>
          {status?.version && <div className={styles.agentCardVersion}>{status.version}</div>}
        </div>
        <div className={styles.providerHeaderRight}>
          {remedy?.kind === "runCommand" && (
            <Button
              variant="secondary"
              disabled={!activeWorktree}
              onClick={() => signIn(remedy.command)}
            >
              <SignIn size={14} />
              {remedy.label}
            </Button>
          )}
          {/* Only a kind with an inline provider section may offer this
              button — it scrolls to that section. Aider's is its own
              credential editor; OpenCode's manages providers through
              opencode's server (Phase O4). */}
          {remedy?.kind === "configureProvider" && (
            <Button
              variant="secondary"
              onClick={() =>
                providersRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" })
              }
            >
              {remedy.label}
            </Button>
          )}
          <span className={styles.statusPill} data-tone={checking ? "checking" : pill.tone}>
            <PillIcon size={12} weight="fill" />
            {checking ? "Checking…" : pill.label}
          </span>
        </div>
      </div>

      {status?.authDetail && <div className={styles.agentDetail}>{status.authDetail}</div>}
      {remedy?.kind === "runCommand" && (
        <div className={styles.agentDetail}>
          Opens a terminal and runs <code>{remedy.command}</code>.
        </div>
      )}

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

      {/* Aider's providers live inside Aider's own card rather than in a
          separate section: they *are* its configuration, and the CLI is
          not usable until one is set up. Split out, the card said "Needs
          provider" with the fix somewhere else on the page. OpenCode's
          section is the same idea — its providers live in opencode's own
          store, managed through its server (docs/OPENCODE_INTEGRATION.md
          §3). */}
      {kind === "aider" && status?.installed && (
        <div ref={providersRef} className={styles.providerSection}>
          <AiderProviders />
        </div>
      )}
      {kind === "openCode" && status?.installed && (
        <div ref={providersRef} className={styles.providerSection}>
          <OpenCodeProviders />
        </div>
      )}
    </div>
  );
}

export function AgentsPane() {
  return (
    <div className={styles.group}>
      <span className={styles.groupLabel}>Agent CLIs</span>
      <p className={styles.placeholder} style={{ marginBottom: "var(--space-2)" }}>
        Detected once at startup and cached — used here, in the new-tab menu, and by "Generate with
        AI" in Source Control. Claude Code, Codex and Cursor Agent each sign in through their own
        CLI. Aider has no account of its own: it talks to whichever LLM provider you configure on
        its card. OpenCode reads the providers you've connected through opencode itself.
      </p>
      {AGENT_KINDS.map((kind) => (
        <AgentCard key={kind} kind={kind} />
      ))}
    </div>
  );
}
