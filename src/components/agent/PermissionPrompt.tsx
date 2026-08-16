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

  if (permission.status !== "pending") {
    return (
      <div className={styles.prompt}>
        <span className={styles.resolved}>
          {permission.status === "approved" ? "Permission granted" : "Permission denied"}
        </span>
      </div>
    );
  }

  function respond(decision: "approve" | "deny") {
    setStatus(runId, toolCallId, decision === "approve" ? "approved" : "denied");
    setWorking(runId);
    void agentsApi.respondToPermission(
      runId,
      decision === "approve" ? { decision: "approve", toolName } : { decision: "deny" },
    );
  }

  return (
    <div className={styles.prompt}>
      <span className={styles.message}>{permission.message}</span>
      <div className={styles.actions}>
        <button type="button" className={styles.approve} onClick={() => respond("approve")}>
          <Check size={13} />
          Approve
        </button>
        <button type="button" className={styles.deny} onClick={() => respond("deny")}>
          <X size={13} />
          Deny
        </button>
      </div>
    </div>
  );
}
