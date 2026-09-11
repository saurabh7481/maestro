import { Check, X } from "@phosphor-icons/react";
import { useAgentStore } from "../state/agentStore";
import type { PermissionState } from "../state/transcript";
import { useAuthStore } from "../state/authStore";

/** Approve/deny card for a tool call the CLI stopped on — mirrors the
 * desktop's `PermissionPrompt.tsx`. "Approve" resumes the same session with
 * wider trust; "Deny" runs nothing, since the turn already stopped. */
export function PermissionCard({
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
  const respond = useAgentStore((s) => s.respondPermission);
  const canWrite = useAuthStore((s) => s.accessLevel === "write");
  const working = useAgentStore((s) => {
    const status = s.byRunId[runId]?.status;
    return status === "working" || status === "settling";
  });

  if (permission.status === "blocked") {
    return (
      <div className="permission-card">
        <div className="permission-resolved">Blocked by the CLI</div>
        <div className="permission-message">{permission.message}</div>
      </div>
    );
  }

  if (permission.status !== "pending") {
    return (
      <div className="permission-card">
        <div className="permission-resolved">
          {permission.status === "approved" ? "Permission granted" : "Permission denied"}
        </div>
      </div>
    );
  }

  const disabled = working || !canWrite;

  return (
    <div className="permission-card">
      <div className="permission-message">{permission.message}</div>
      <div className="permission-actions">
        <button
          type="button"
          className="btn btn-primary"
          disabled={disabled}
          onClick={() => void respond(runId, toolCallId, { decision: "approve", toolName })}
        >
          <Check size={14} />
          Approve
        </button>
        <button
          type="button"
          className="btn btn-danger"
          disabled={disabled}
          onClick={() => void respond(runId, toolCallId, { decision: "deny" })}
        >
          <X size={14} />
          Deny
        </button>
      </div>
    </div>
  );
}
