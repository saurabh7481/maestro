import { useEffect, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { workspaceApi } from "../../api/workspace";
import { listenToCloneEvents } from "../../api/cloneEvents";
import { useWorkspaceStore } from "../../state/workspaceStore";
import type { HookOutputLine, HookRunStatus } from "./HookOutputPanel";
import { HookOutputPanel } from "./HookOutputPanel";
import { Button, TextInput } from "../primitives";
import styles from "./NewWorktreeDialog.module.css";

export interface CloneProjectDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/** Best-effort suggestion only (the field stays editable) — handles both
 * `https://github.com/owner/repo(.git)` and `git@github.com:owner/repo.git`
 * shapes without a full URL parser, since either way the last `/`- or
 * `:`-separated segment (minus a trailing `.git`) is the repo name. */
export function suggestRepoName(url: string): string {
  const trimmed = url.trim().replace(/\/+$/, "");
  if (!trimmed) return "";
  const withoutGitSuffix = trimmed.replace(/\.git$/i, "");
  const segments = withoutGitSuffix.split(/[/:]/).filter(Boolean);
  return segments[segments.length - 1] ?? "";
}

const CLONE_LABELS: Partial<Record<HookRunStatus, string>> = {
  running: "Cloning…",
  success: "Clone completed",
  failed: "Clone failed",
  cancelled: "Clone cancelled",
};

export function CloneProjectDialog({ open, onOpenChange }: CloneProjectDialogProps) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className={styles.overlay}>
          {/* Mounted only while open, so every field resets by starting
              fresh rather than by an effect reacting to `open` changing —
              same reasoning as NewWorktreeDialog. */}
          {open && <CloneProjectDialogInner onOpenChange={onOpenChange} />}
        </Dialog.Overlay>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function CloneProjectDialogInner({ onOpenChange }: { onOpenChange: (open: boolean) => void }) {
  const adoptProject = useWorkspaceStore((s) => s.adoptProject);

  const [url, setUrl] = useState("");
  const [parentDir, setParentDir] = useState<string | null>(null);
  // `null` until the user types into the field directly — until then the
  // displayed name is derived from `url` on every render rather than
  // synced via an effect (avoids the cascading-render anti-pattern for
  // what's really just computed state).
  const [folderNameOverride, setFolderNameOverride] = useState<string | null>(null);
  const folderName = folderNameOverride ?? suggestRepoName(url);
  const [error, setError] = useState<string | null>(null);

  const [cloneId, setCloneId] = useState<string | null>(null);
  const [status, setStatus] = useState<HookRunStatus>("running");
  const [lines, setLines] = useState<HookOutputLine[]>([]);
  const [succeeded, setSucceeded] = useState(false);

  async function handleChooseFolder() {
    const path = await workspaceApi.pickProjectFolder();
    if (path) setParentDir(path);
  }

  useEffect(() => {
    if (!cloneId) return;
    let unlisten: (() => void) | undefined;
    let torndown = false;

    void listenToCloneEvents(cloneId, (event) => {
      if (event.type === "line") {
        setLines((prev) => [...prev, { stream: event.stream, text: event.text }]);
        return;
      }
      setSucceeded(event.success);
      setStatus(event.cancelled ? "cancelled" : event.success ? "success" : "failed");
      if (event.project) void adoptProject(event.project);
    }).then((fn) => {
      if (torndown) fn();
      else unlisten = fn;
    });

    void workspaceApi.cloneProject(cloneId, url, `${parentDir}/${folderName.trim()}`);

    return () => {
      torndown = true;
      unlisten?.();
    };
    // Fires exactly once per clone, when `cloneId` is first minted below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cloneId]);

  function handleClone() {
    setError(null);
    setStatus("running");
    setLines([]);
    setSucceeded(false);
    setCloneId(crypto.randomUUID());
  }

  const isCloning = cloneId != null;
  const canClose = !isCloning || status !== "running";
  const destination = parentDir ? `${parentDir}/${folderName.trim() || "…"}` : null;
  const canClone = url.trim().length > 0 && parentDir != null && folderName.trim().length > 0;

  return (
    <Dialog.Content
      className={`${styles.content} mo-glass`}
      aria-describedby={undefined}
      onEscapeKeyDown={(e) => !canClose && e.preventDefault()}
      onPointerDownOutside={(e) => !canClose && e.preventDefault()}
    >
      <Dialog.Title className={styles.title}>
        {isCloning ? "Cloning repository" : "Clone from GitHub"}
      </Dialog.Title>

      {!isCloning && (
        <>
          <TextInput
            label="Repository URL"
            placeholder="https://github.com/owner/repo"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            autoFocus
          />
          <div style={{ display: "flex", gap: "var(--space-4)", alignItems: "flex-end" }}>
            <TextInput
              label="Folder name"
              placeholder="repo"
              value={folderName}
              onChange={(e) => setFolderNameOverride(e.target.value)}
              style={{ flex: 1 }}
            />
            <Button variant="secondary" onClick={() => void handleChooseFolder()}>
              {parentDir ? "Change folder…" : "Choose folder…"}
            </Button>
          </div>
          {destination && (
            <p style={{ color: "var(--text-mute)", fontSize: "var(--text-xs)" }}>
              Will clone into <code>{destination}</code>
            </p>
          )}
          {error && <div className={styles.error}>{error}</div>}
          <div className={styles.actions}>
            <Button variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button variant="primary" disabled={!canClone} onClick={handleClone}>
              Clone
            </Button>
          </div>
        </>
      )}

      {isCloning && (
        <>
          <HookOutputPanel
            status={status}
            lines={lines}
            labels={CLONE_LABELS}
            emptyText="Starting…"
          />
          <div className={styles.actions}>
            {status === "running" ? (
              <Button
                variant="ghost"
                onClick={() => cloneId && void workspaceApi.cancelProjectClone(cloneId)}
              >
                Cancel
              </Button>
            ) : (
              <Button variant="primary" onClick={() => onOpenChange(false)}>
                {succeeded ? "Done" : "Close"}
              </Button>
            )}
          </div>
        </>
      )}
    </Dialog.Content>
  );
}
