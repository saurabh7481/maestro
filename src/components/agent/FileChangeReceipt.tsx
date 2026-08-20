import { memo, useEffect, useState } from "react";
import { CaretDown, Files, GitDiff } from "@phosphor-icons/react";
import { useTabsStore } from "../../state/tabsStore";
import type { TranscriptItem } from "../../state/agentSessionStore";
import { computeTurnFileChanges } from "../../state/agentFileChanges";
import type { ReviewFile } from "../../types/git";
import { iconForFile } from "../explorer/fileIcons";
import styles from "./FileChangeReceipt.module.css";

export const FileChangeReceipt = memo(function FileChangeReceipt({
  receiptId,
  items,
  worktreeId,
  worktreeRoot,
}: {
  receiptId: string;
  items: TranscriptItem[];
  worktreeId: string;
  worktreeRoot: string;
}) {
  const ensureTab = useTabsStore((state) => state.ensureTab);
  const [files, setFiles] = useState<ReviewFile[]>([]);

  useEffect(() => {
    let live = true;
    void computeTurnFileChanges(worktreeRoot, items)
      .then((result) => {
        if (live) setFiles(result);
      })
      .catch(() => {
        // The receipt is an enhancement; a transient Git read must not
        // replace the agent's answer with an error surface.
      });
    return () => {
      live = false;
    };
  }, [items, worktreeRoot]);

  if (files.length === 0) return null;
  const totals = files.reduce(
    (sum, file) => ({
      added: sum.added + (file.added ?? 0),
      removed: sum.removed + (file.removed ?? 0),
    }),
    { added: 0, removed: 0 },
  );
  function open(selectedReviewPath?: string) {
    ensureTab({
      id: `review:agent:${worktreeId}:${receiptId}${selectedReviewPath ? `:${selectedReviewPath}` : ""}`,
      type: "review",
      title: `Agent changes`,
      reviewSubtitle: `${files.length} ${files.length === 1 ? "file" : "files"} changed in this response`,
      worktreeId,
      worktreeRoot,
      reviewFiles: files,
      selectedReviewPath,
    });
  }
  return (
    <div className={styles.receipt}>
      <div className={styles.heading}>
        <span className={styles.icon}>
          <Files size={15} />
        </span>
        <strong>
          Edited {files.length} {files.length === 1 ? "file" : "files"}
        </strong>
        <button type="button" onClick={() => open()}>
          <GitDiff size={14} />
          Review
        </button>
      </div>
      <div className={styles.rows}>
        {files.slice(0, 4).map((file) => {
          const Icon = iconForFile(file.path).icon;
          return (
            <button
              type="button"
              className={styles.row}
              key={file.path}
              onClick={() => open(file.path)}
            >
              <Icon size={14} />
              <span>{file.path}</span>
              <i>+{file.added ?? 0}</i>
              <em>−{file.removed ?? 0}</em>
            </button>
          );
        })}
      </div>
      {files.length > 4 && (
        <button type="button" className={styles.more} onClick={() => open()}>
          Show {files.length - 4} more <CaretDown size={12} />
        </button>
      )}
      <div className={styles.total}>
        <span>Response changes</span>
        <i>+{totals.added}</i>
        <em>−{totals.removed}</em>
      </div>
    </div>
  );
});
