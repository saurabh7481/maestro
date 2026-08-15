import { memo, useEffect, useMemo, useState } from "react";
import { CaretDown, Files, GitDiff } from "@phosphor-icons/react";
import { gitApi } from "../../api/git";
import { useTabsStore } from "../../state/tabsStore";
import type { TranscriptItem } from "../../state/agentSessionStore";
import type { ReviewFile, StatusKind } from "../../types/git";
import { iconForFile } from "../explorer/fileIcons";
import styles from "./FileChangeReceipt.module.css";

type ToolItem = Extract<TranscriptItem, { kind: "toolCall" }>;
type Candidate = { item?: ToolItem; added: number; removed: number; kind?: StatusKind };
const EDIT_TOOL = /(edit|write|create|delete|remove|patch|move|rename)/i;

function candidatePaths(item: ToolItem, root: string): string[] {
  if (!EDIT_TOOL.test(item.name) || item.result?.isError) return [];
  const paths = new Set<string>();
  function add(value: string) {
    for (const match of value.matchAll(/^\*\*\* (?:Update|Add|Delete) File: (.+)$/gm))
      paths.add(match[1].trim());
    if (!value.includes("\n") && !value.includes("\0") && value.length < 500) paths.add(value);
  }
  function walk(value: unknown, key = "") {
    if (typeof value === "string") {
      if (/(?:^|_)(?:file_?)?path$/i.test(key) || /patch|diff/i.test(key)) add(value);
      return;
    }
    if (Array.isArray(value)) return value.forEach((entry) => walk(entry, key));
    if (value && typeof value === "object") {
      Object.entries(value as Record<string, unknown>).forEach(([childKey, child]) =>
        walk(child, childKey),
      );
    }
  }
  walk(item.input);
  return [...paths]
    .map((path) => {
      const normalized = path.replace(/\\/g, "/");
      const rootNormalized = root.replace(/\\/g, "/").replace(/\/$/, "");
      return normalized.startsWith(`${rootNormalized}/`)
        ? normalized.slice(rootNormalized.length + 1)
        : normalized.replace(/^\.\//, "");
    })
    .filter((path) => path && !path.startsWith("/") && !path.startsWith("../"));
}

function inferredKind(item?: ToolItem): StatusKind {
  if (!item) return { kind: "modified" };
  if (/delete|remove/i.test(item.name)) return { kind: "deleted" };
  if (/create|write/i.test(item.name)) return { kind: "added" };
  return { kind: "modified" };
}

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
  const candidates = useMemo(() => {
    const map = new Map<string, Candidate>();
    for (const raw of items) {
      if (raw.kind !== "toolCall" || !raw.result || raw.result.isError) continue;
      for (const path of candidatePaths(raw, worktreeRoot)) {
        const previous = map.get(path);
        map.set(path, {
          item: raw,
          added: (previous?.added ?? 0) + (raw.result.diffAdded ?? 0),
          removed: (previous?.removed ?? 0) + (raw.result.diffRemoved ?? 0),
        });
      }
    }
    return map;
  }, [items, worktreeRoot]);
  const [files, setFiles] = useState<ReviewFile[]>([]);
  const completion = useMemo(() => {
    for (let index = items.length - 1; index >= 0; index -= 1) {
      const item = items[index];
      if (item.kind === "turnComplete") return item;
    }
    return undefined;
  }, [items]);

  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const [status, commits] = await Promise.all([
          gitApi.getWorkingStatus(worktreeRoot),
          gitApi.getCommitLog(worktreeRoot, 1, 0),
        ]);
        if (!live) return;
        const head = commits[0]?.hash;
        const combined = new Map(candidates);
        const baselinePaths = new Set(completion?.baselinePaths ?? []);
        for (const entry of status.entries) {
          if (!baselinePaths.has(entry.path) && !combined.has(entry.path)) {
            combined.set(entry.path, {
              added: 0,
              removed: 0,
              kind: entry.unstaged ?? entry.staged ?? { kind: "modified" },
            });
          }
        }
        if (completion?.baselineHead && head && completion.baselineHead !== head) {
          const committed = await gitApi.getCommitFiles(worktreeRoot, head);
          for (const [path, kind] of committed) {
            if (!combined.has(path)) combined.set(path, { added: 0, removed: 0, kind });
          }
        }
        if (!live) return;
        setFiles(
          [...combined]
            .map(([path, value]) => {
              const current = status.entries.find((entry) => entry.path === path);
              const mode = current?.unstaged ? "unstaged" : current?.staged ? "staged" : "commit";
              const kind =
                current?.unstaged ?? current?.staged ?? value.kind ?? inferredKind(value.item);
              return {
                path,
                kind,
                mode,
                commitHash: mode === "commit" ? head : undefined,
                added: value.added,
                removed: value.removed,
              } as ReviewFile;
            })
            .filter((file) => file.mode !== "commit" || !!file.commitHash),
        );
      } catch {
        // The receipt is an enhancement; a transient Git read must not
        // replace the agent's answer with an error surface.
      }
    })();
    return () => {
      live = false;
    };
  }, [candidates, completion, worktreeRoot]);

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
