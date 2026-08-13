import { useState } from "react";
import { AlertDialog } from "../primitives";
import { useWorkspaceStore } from "../../state/workspaceStore";
import type { Worktree } from "../../types/workspace";

export interface RemoveWorktreeDialogProps {
  worktree: Worktree | null;
  onOpenChange: (open: boolean) => void;
}

export function RemoveWorktreeDialog({ worktree, onOpenChange }: RemoveWorktreeDialogProps) {
  const removeWorktree = useWorkspaceStore((s) => s.removeWorktree);
  const [force, setForce] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [removing, setRemoving] = useState(false);

  if (!worktree) return null;

  async function handleConfirm() {
    if (!worktree) return;
    setRemoving(true);
    setError(null);
    try {
      await removeWorktree(worktree.projectId, worktree.id, force);
      onOpenChange(false);
    } catch (err) {
      const message = String(err);
      // The backend's dirty-tree guard throws a plain "has uncommitted
      // changes" string — offer force-remove instead of a dead end.
      if (!force && message.toLowerCase().includes("uncommitted")) {
        setForce(true);
        setError(`${message} — removing again will discard them.`);
      } else {
        setError(message);
      }
    } finally {
      setRemoving(false);
    }
  }

  return (
    <AlertDialog
      open={worktree != null}
      onOpenChange={onOpenChange}
      title={`Remove worktree "${worktree.branch}"?`}
      description={
        <>
          <div>{worktree.path}</div>
          {force && (
            <div style={{ color: "var(--red)", marginTop: "0.5rem" }}>
              {error ?? "This will discard uncommitted changes."}
            </div>
          )}
          {!force && error && (
            <div style={{ color: "var(--red)", marginTop: "0.5rem" }}>{error}</div>
          )}
        </>
      }
      confirmLabel={removing ? "Removing…" : force ? "Discard & remove" : "Remove"}
      confirmDisabled={removing}
      onConfirm={() => void handleConfirm()}
    />
  );
}
