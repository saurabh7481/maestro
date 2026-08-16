import { Check, X } from "@phosphor-icons/react";
import { agentsApi } from "../../api/agents";
import { useAgentSessionStore } from "../../state/agentSessionStore";
import type { PermissionState } from "../../state/agentSessionStore";
import styles from "./PermissionPrompt.module.css";

/** Approve/deny card for a tool call the CLI auto-denied/blocked because
 * it wasn't pre-authorized. There's no live approve/deny wire protocol in
 * any of the three CLIs (see `agents/claude.rs`/`cursor_agent.rs`/
 * `codex.rs`'s module docs) — "Approve" restarts the session with wider
 * trust, which is why this triggers another `respondToPermission` call
 * rather than something lighter-weight. */
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
  const setRunError = useAgentSessionStore((s) => s.setRunError);
  const working = useAgentSessionStore((s) => s.byRunId[runId]?.status === "working");

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
    setStatus(runId, toolCallId, decision === "approve" ? "approved" : "denied");
    setWorking(runId);
    try {
      await agentsApi.respondToPermission(
        runId,
        decision === "approve" ? { decision: "approve", toolName } : { decision: "deny" },
      );
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
      {working && <span className={styles.waiting}>Finishing current step…</span>}
    </div>
  );
}
