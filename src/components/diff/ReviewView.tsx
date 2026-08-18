import { useEffect, useMemo, useState } from "react";
import { CaretDown, CaretRight, Files, GitCommit } from "@phosphor-icons/react";
import { gitApi } from "../../api/git";
import type { DiffContent, ReviewFile } from "../../types/git";
import type { Tab } from "../../state/tabsStore";
import { iconForFile } from "../explorer/fileIcons";
import { MonacoDiffHost } from "./MonacoDiffHost";
import styles from "./ReviewView.module.css";

function nameOf(path: string) {
  return path.split("/").pop() ?? path;
}

function statusLabel(file: ReviewFile) {
  switch (file.kind.kind) {
    case "added":
    case "untracked":
      return "Added";
    case "deleted":
      return "Deleted";
    case "renamed":
      return "Renamed";
    case "copied":
      return "Copied";
    default:
      return "Modified";
  }
}

function FileDiff({ file, root }: { file: ReviewFile; root: string }) {
  const [diff, setDiff] = useState<DiffContent | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    gitApi
      .getDiffContent(root, file.path, file.mode, file.commitHash)
      .then((value) => live && setDiff(value))
      .catch((reason) => live && setError(String(reason)));
    return () => {
      live = false;
    };
  }, [file, root]);

  if (error) return <div className={styles.message}>{error}</div>;
  if (!diff) return <div className={styles.message}>Loading diff…</div>;
  if (diff.kind !== "text") {
    return (
      <div className={styles.message}>
        {diff.kind === "binary" ? "Binary file changed" : "Directory changed"}
      </div>
    );
  }
  return (
    <div className={styles.diffHost}>
      <div className={styles.labels}>
        <span>{diff.oldLabel}</span>
        <span>{diff.newLabel}</span>
      </div>
      <MonacoDiffHost
        relPath={file.path}
        oldText={diff.oldText}
        newText={diff.newText}
        worktreeRoot={root}
        mode="commit"
      />
    </div>
  );
}

export function ReviewView({ tab }: { tab: Tab }) {
  const files = useMemo(
    () =>
      tab.selectedReviewPath
        ? (tab.reviewFiles ?? []).filter((file) => file.path === tab.selectedReviewPath)
        : (tab.reviewFiles ?? []),
    [tab.reviewFiles, tab.selectedReviewPath],
  );
  const [open, setOpen] = useState(() => new Set(files.slice(0, 1).map((file) => file.path)));
  const totals = files.reduce(
    (sum, file) => ({
      added: sum.added + (file.added ?? 0),
      removed: sum.removed + (file.removed ?? 0),
    }),
    { added: 0, removed: 0 },
  );

  function toggle(path: string) {
    setOpen((previous) => {
      const next = new Set(previous);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }

  return (
    <div className={styles.wrap}>
      <header className={styles.header}>
        <div className={styles.headerIcon}>
          <Files size={17} />
        </div>
        <div className={styles.heading}>
          <strong>{tab.title}</strong>
          <span>
            {tab.reviewSubtitle ??
              `${files.length} changed ${files.length === 1 ? "file" : "files"}`}
          </span>
        </div>
        <div className={styles.summary}>
          <span>{files.length} files</span>
          {totals.added > 0 && <span className={styles.added}>+{totals.added}</span>}
          {totals.removed > 0 && <span className={styles.removed}>−{totals.removed}</span>}
        </div>
      </header>
      <div className={styles.list}>
        {files.map((file) => {
          const expanded = open.has(file.path);
          const Icon = iconForFile(nameOf(file.path)).icon;
          return (
            <section
              className={styles.file}
              key={`${file.mode}:${file.commitHash ?? ""}:${file.path}`}
            >
              <button
                className={styles.fileHeader}
                type="button"
                onClick={() => toggle(file.path)}
                aria-expanded={expanded}
              >
                {expanded ? <CaretDown size={14} /> : <CaretRight size={14} />}
                <Icon size={15} />
                <span className={styles.path}>{file.path}</span>
                <span className={styles.kind}>{statusLabel(file)}</span>
                {file.added != null && <span className={styles.added}>+{file.added}</span>}
                {file.removed != null && <span className={styles.removed}>−{file.removed}</span>}
              </button>
              {expanded && tab.worktreeRoot && <FileDiff file={file} root={tab.worktreeRoot} />}
            </section>
          );
        })}
        {files.length === 0 && (
          <div className={styles.empty}>
            <GitCommit size={26} />
            No file changes to review.
          </div>
        )}
      </div>
    </div>
  );
}
