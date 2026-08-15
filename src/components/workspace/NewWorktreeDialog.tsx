import { useEffect, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { workspaceApi } from "../../api/workspace";
import { listenToHookEvents } from "../../api/hookEvents";
import { useWorkspaceStore, useActiveWorktree, EMPTY_WORKTREES } from "../../state/workspaceStore";
import { useToastStore } from "../../state/toastStore";
import type { Worktree } from "../../types/workspace";
import { Button, Dropdown, TextInput } from "../primitives";
import { HookOutputPanel } from "./HookOutputPanel";
import type { HookOutputLine, HookRunStatus } from "./HookOutputPanel";
import styles from "./NewWorktreeDialog.module.css";

export interface NewWorktreeDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectId: string;
}

export function NewWorktreeDialog({ open, onOpenChange, projectId }: NewWorktreeDialogProps) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className={styles.overlay}>
          {/* Mounted only while open, so every field resets by starting
              fresh rather than by an effect reacting to `open` changing. */}
          {open && <NewWorktreeDialogInner projectId={projectId} onOpenChange={onOpenChange} />}
        </Dialog.Overlay>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function NewWorktreeDialogInner({
  projectId,
  onOpenChange,
}: {
  projectId: string;
  onOpenChange: (open: boolean) => void;
}) {
  const createWorktree = useWorkspaceStore((s) => s.createWorktree);
  const activeWorktree = useActiveWorktree();
  const projectWorktrees = useWorkspaceStore(
    (s) => s.worktreesByProject[projectId] ?? EMPTY_WORKTREES,
  );

  const [branches, setBranches] = useState<string[]>([]);
  const [branchName, setBranchName] = useState("");
  const [baseRef, setBaseRef] = useState("");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [createdWorktree, setCreatedWorktree] = useState<Worktree | null>(null);
  const [sourcePath, setSourcePath] = useState<string | null>(null);
  const [hookStatus, setHookStatus] = useState<HookRunStatus>("running");
  const [hookLines, setHookLines] = useState<HookOutputLine[]>([]);

  useEffect(() => {
    void workspaceApi.listProjectBranches(projectId).then((list) => {
      setBranches(list);
      setBaseRef(
        (activeWorktree?.projectId === projectId ? activeWorktree.branch : undefined) ??
          list[0] ??
          "main",
      );
    });
    // Fetches once for this mounted instance (dialog unmounts/remounts per
    // open, see NewWorktreeDialog above) — not a reset-on-change effect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!createdWorktree) return;
    let unlisten: (() => void) | undefined;
    let torndown = false;

    void listenToHookEvents(createdWorktree.id, (event) => {
      // Defensive: a malformed event should be skipped, not crash the
      // whole renderer (see `api/fsEvents.ts`).
      if (!event?.type) return;
      if (event.type === "line") {
        setHookLines((lines) => [...lines, { stream: event.stream, text: event.text }]);
      } else {
        const status = event.cancelled
          ? "cancelled"
          : event.timedOut
            ? "timedOut"
            : event.success
              ? "success"
              : "failed";
        setHookStatus(status);
        if (status !== "cancelled") {
          useToastStore.getState().push({
            tone: status === "success" ? "success" : "error",
            title:
              status === "success"
                ? "Worktree hook finished"
                : status === "timedOut"
                  ? "Worktree hook timed out"
                  : "Worktree hook failed",
            description: createdWorktree.branch,
          });
        }
      }
    }).then((fn) => {
      if (torndown) fn();
      else unlisten = fn;
    });

    // sourcePath was captured in handleCreate, before createWorktree()
    // flipped the store's active worktree over to the new one — reading
    // it live here would always resolve to the new (source-less) worktree.
    void workspaceApi.runWorktreeHook(
      projectId,
      createdWorktree.id,
      sourcePath ?? createdWorktree.path,
    );

    return () => {
      torndown = true;
      unlisten?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [createdWorktree]);

  async function handleCreate() {
    setCreating(true);
    setError(null);
    try {
      // Capture the source worktree *before* createWorktree() runs — it
      // flips the store's active worktree over to the newly created one as
      // part of that call, so reading "the active worktree" any later
      // would just resolve back to the (source-less) worktree we're
      // creating. Prefer the currently active worktree if it's in this
      // project (most contextually relevant "copy my local files from
      // here" source), else the project's primary worktree.
      const capturedSourcePath =
        (activeWorktree?.projectId === projectId ? activeWorktree.path : undefined) ??
        projectWorktrees.find((w) => w.isPrimary)?.path ??
        projectWorktrees[0]?.path ??
        null;

      const worktree = await createWorktree(projectId, branchName, baseRef);
      setSourcePath(capturedSourcePath ?? worktree.path);
      setCreatedWorktree(worktree);
    } catch (err) {
      setError(String(err));
    } finally {
      setCreating(false);
    }
  }

  const isRunningHooks = createdWorktree != null;
  const canClose = !isRunningHooks || hookStatus !== "running";

  return (
    <Dialog.Content
      className={`${styles.content} mo-glass`}
      aria-describedby={undefined}
      onEscapeKeyDown={(e) => !canClose && e.preventDefault()}
      onPointerDownOutside={(e) => !canClose && e.preventDefault()}
    >
      <Dialog.Title className={styles.title}>
        {isRunningHooks ? "Creating worktree" : "New worktree"}
      </Dialog.Title>

      {!isRunningHooks && (
        <>
          <TextInput
            label="Branch name"
            placeholder="feat/my-feature"
            value={branchName}
            onChange={(e) => setBranchName(e.target.value)}
            autoFocus
          />
          <Dropdown
            label="Base ref"
            value={baseRef}
            onChange={setBaseRef}
            options={branches.map((b) => ({ value: b, label: b }))}
          />
          {error && <div className={styles.error}>{error}</div>}
          <div className={styles.actions}>
            <Button variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button
              variant="primary"
              disabled={!branchName.trim() || creating}
              onClick={() => void handleCreate()}
            >
              {creating ? "Creating…" : "Create"}
            </Button>
          </div>
        </>
      )}

      {isRunningHooks && (
        <>
          <HookOutputPanel status={hookStatus} lines={hookLines} />
          <div className={styles.actions}>
            {hookStatus === "running" ? (
              <Button
                variant="ghost"
                onClick={() => void workspaceApi.cancelWorktreeHook(createdWorktree.id)}
              >
                Cancel
              </Button>
            ) : (
              <Button variant="primary" onClick={() => onOpenChange(false)}>
                Done
              </Button>
            )}
          </div>
        </>
      )}
    </Dialog.Content>
  );
}
