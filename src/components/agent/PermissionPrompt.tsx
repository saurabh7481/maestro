import { Check, X } from "@phosphor-icons/react";
import { agentsApi } from "../../api/agents";
import { useAgentSessionStore } from "../../state/agentSessionStore";
import type { PermissionState } from "../../state/agentSessionStore";
import { useTabsStore } from "../../state/tabsStore";
import { useAgentCapabilities } from "../../state/agentAvailabilityStore";
import { AGENT_DISPLAY_NAME } from "../../types/agent";
import styles from "./PermissionPrompt.module.css";

/** Approve/deny card for a tool call the CLI blocked because it wasn't
 * pre-authorized. None of the three CLIs has a live approve/deny wire
 * protocol (see `agents/claude.rs`'s module doc), so the backend stops the
 * turn at the request instead and the run parks on `awaitingPermission`.
 * "Approve" resumes the same session with wider trust — a real turn, hence
 * the spinner; "Deny" runs nothing, because the turn already stopped.
 *
 * That only holds in `manual` mode. Everywhere else the CLI refuses under
 * its own rules and keeps working, and `manager.rs` marks the event
 * `gated: false` so it lands here as `blocked` — reported, not asked. */
export function PermissionPrompt({
  runId,
  toolCallId,
  toolName,
  permission,
}: {
  runId: string;
  toolCallId: string;
  toolName: string;
  permission: PermissionState;
}) {
  const setStatus = useAgentSessionStore((s) => s.setToolCallPermissionStatus);
  const setWorking = useAgentSessionStore((s) => s.setWorking);
  const setIdle = useAgentSessionStore((s) => s.setIdle);
  const setRunError = useAgentSessionStore((s) => s.setRunError);
  const setPermissionMode = useAgentSessionStore((s) => s.setPermissionMode);
  const working = useAgentSessionStore((s) => s.byRunId[runId]?.status === "working");
  // The run id *is* the tab id, so the tab carries which CLI this is.
  const kind = useTabsStore((s) => s.tabs.find((tab) => tab.id === runId)?.agentKind);
  const capabilities = useAgentCapabilities(kind ?? "claudeCode");
  // A CLI that can't prompt per call has no way to allow just this one
  // action, so the backend's only lever is to stop gating the run
  // entirely (`manager.rs::respond_to_permission`). Say that *before* the
  // click — an "Approve" that silently means "and everything after this"
  // is exactly the surprise a permission prompt exists to prevent.
  const escalates = !!kind && capabilities.manualGate !== "prompt";

  // Not a question: the CLI applied its own rules, refused the call, and
  // carried on with the turn. Say what happened and leave it at that —
  // offering Approve/Deny here asks the user to answer something that has
  // already been decided and isn't holding anything up.
  if (permission.status === "blocked") {
    return (
      <div className={styles.prompt} data-variant="blocked">
        <span className={styles.resolved}>
          Blocked by {kind ? AGENT_DISPLAY_NAME[kind] : "the CLI"}
        </span>
        <span className={styles.message}>{permission.message}</span>
      </div>
    );
  }

  if (permission.status !== "pending") {
    return (
      <div className={styles.prompt}>
        <span className={styles.resolved}>
          {permission.status === "approved" ? "Permission granted" : "Permission denied"}
        </span>
      </div>
    );
  }

  async function respond(decision: "approve" | "deny") {
    // These CLIs report a denial before their current process has emitted
    // its final result. Starting the retry during that gap creates two
    // concurrent turns for one run and races session/cancel bookkeeping.
    if (working) return;
    const approving = decision === "approve";
    setStatus(runId, toolCallId, approving ? "approved" : "denied");
    // Only an approval resumes the agent. A denial ends the turn where it
    // stopped, so showing a spinner for it would be a lie.
    if (approving) setWorking(runId);
    else setIdle(runId);
    try {
      const outcome = await agentsApi.respondToPermission(
        runId,
        approving ? { decision: "approve", toolName } : { decision: "deny" },
      );
      // Approving on a CLI with no per-invocation allow-list turns gating
      // off for the rest of the run. Reflect that in the mode picker
      // instead of leaving it claiming "Manual" while nothing is gated.
      if (outcome?.escalatedToAuto) setPermissionMode(runId, "auto");
    } catch (error) {
      setRunError(runId, `Could not continue after the permission decision: ${String(error)}`);
    }
  }

  return (
    <div className={styles.prompt}>
      <span className={styles.message}>{permission.message}</span>
      <div className={styles.actions}>
        <button
          type="button"
          className={styles.approve}
          disabled={working}
          title={working ? "Waiting for the current agent turn to finish" : undefined}
          onClick={() => void respond("approve")}
        >
          <Check size={13} />
          Approve
        </button>
        <button
          type="button"
          className={styles.deny}
          disabled={working}
          onClick={() => void respond("deny")}
        >
          <X size={13} />
          Deny
        </button>
      </div>
      {escalates && (
        <span className={styles.escalation}>
          This CLI can’t approve one action on its own — approving turns off permission prompts for
          the rest of this tab.
        </span>
      )}
      {working && <span className={styles.waiting}>Finishing current step…</span>}
    </div>
  );
}
