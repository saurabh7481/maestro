import { useEffect, useState } from "react";
import { relayClient } from "../api/client";

/** The worktree's tracked file list — same gitignore-respecting `git
 * ls-files` source the desktop's own @-mention search uses
 * (`AgentComposer.tsx::useWorktreeFileList`), fetched fresh each time the
 * "Add context" sheet opens for a given worktree. */
export function useWorktreeFiles(worktreeId: string | null): string[] {
  const [trackedWorktreeId, setTrackedWorktreeId] = useState(worktreeId);
  const [files, setFiles] = useState<string[]>([]);

  // See `agentCatalog.ts` for why this reset lives in a render-time
  // adjustment rather than a synchronous `setState` at the top of the
  // effect below.
  if (worktreeId !== trackedWorktreeId) {
    setTrackedWorktreeId(worktreeId);
    setFiles([]);
  }

  useEffect(() => {
    if (!worktreeId) return;
    let cancelled = false;
    relayClient
      .listWorktreeFiles(worktreeId)
      .then((list) => {
        if (!cancelled) setFiles(list);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [worktreeId]);

  return files;
}
