import { useEffect, useState, type KeyboardEvent, type ReactNode } from "react";
import {
  ArrowCounterClockwise,
  ArrowsClockwise,
  ArrowDown,
  CaretDown,
  CaretRight,
  Check,
  Minus,
  Plus,
  WarningCircle,
} from "@phosphor-icons/react";
import { useTabsStore, diffTabId } from "../../state/tabsStore";
import { useUiStore } from "../../state/uiStore";
import { useActiveWorktree } from "../../state/workspaceStore";
import { useScmStore } from "../../state/scmStore";
import { relativeTime } from "../../design/relativeTime";
import { iconForFile } from "../explorer/fileIcons";
import { AlertDialog, Button } from "../primitives";
import { FileTree } from "../explorer/FileTree";
import type { CommitFileEntry, FileStatusEntry, StatusKind } from "../../types/git";
import sidebar from "./Sidebar.module.css";
import styles from "./ExplorerSidebar.module.css";

function splitPath(path: string): { name: string; dir: string } {
  const idx = path.lastIndexOf("/");
  return idx === -1 ? { name: path, dir: "" } : { name: path.slice(idx + 1), dir: path.slice(0, idx) };
}

function glyphFor(kind: StatusKind): { glyph: string; color: string } {
  switch (kind.kind) {
    case "modified":
    case "typeChanged":
      return { glyph: "M", color: "var(--yellow)" };
    case "added":
      return { glyph: "A", color: "var(--green)" };
    case "renamed":
      return { glyph: "R", color: "var(--green)" };
    case "copied":
      return { glyph: "C", color: "var(--green)" };
    case "deleted":
      return { glyph: "D", color: "var(--red)" };
    case "untracked":
      return { glyph: "U", color: "var(--green)" };
    case "conflicted":
      return { glyph: "!", color: "var(--red)" };
  }
}

interface FileRowProps {
  entry: FileStatusEntry;
  kind: StatusKind;
  active: boolean;
  onOpen?: () => void;
  actions?: ReactNode;
}

function FileRow({ entry, kind, active, onOpen, actions }: FileRowProps) {
  const { name, dir } = splitPath(entry.path);
  const { icon: Icon, color } = iconForFile(name);
  const { glyph, color: glyphColor } = glyphFor(kind);
  const label =
    kind.kind === "renamed" || kind.kind === "copied"
      ? `${splitPath(entry.oldPath ?? entry.path).name} → ${name}`
      : name;

  return (
    <div className={sidebar.row} data-active={active} onClick={onOpen}>
      <Icon size={15} color={color} />
      <span className={sidebar.rowLabel}>{label}</span>
      {dir && <span className={styles.filePath}>{dir}</span>}
      {actions}
      <span className={styles.statusGlyph} style={{ color: glyphColor }}>
        {glyph}
      </span>
    </div>
  );
}

function CommitBox() {
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const status = useScmStore((s) => s.status);
  const error = useScmStore((s) => s.error);
  const clearError = useScmStore((s) => s.clearError);
  const commit = useScmStore((s) => s.commit);
  const push = useScmStore((s) => s.push);
  const pull = useScmStore((s) => s.pull);
  const fetch = useScmStore((s) => s.fetch);
  const activeWorktree = useActiveWorktree();

  const stagedCount =
    status?.entries.filter((e) => e.staged && e.staged.kind !== "conflicted").length ?? 0;
  const canCommit = stagedCount > 0 && message.trim().length > 0 && busy === null;

  async function run(name: string, action: () => Promise<void>) {
    setBusy(name);
    try {
      await action();
    } catch {
      // Surfaced via `error` below — nothing further to do here.
    } finally {
      setBusy(null);
    }
  }

  function handleCommit() {
    if (!canCommit) return;
    void run("commit", async () => {
      await commit(message.trim());
      setMessage("");
    });
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
      event.preventDefault();
      handleCommit();
    }
  }

  return (
    <div className={styles.scmBox}>
      <div className={styles.commitMessage}>
        <textarea
          value={message}
          onChange={(event) => setMessage(event.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Message (⌘Enter to commit)"
          rows={2}
          style={{
            width: "100%",
            resize: "vertical",
            background: "transparent",
            border: "none",
            outline: "none",
            color: "var(--text)",
            font: "inherit",
          }}
        />
      </div>
      {error && (
        <div className={styles.scmError} onClick={clearError}>
          {error}
        </div>
      )}
      <div className={styles.scmActions}>
        <Button variant="primary" style={{ flex: 1 }} disabled={!canCommit} onClick={handleCommit}>
          <Check size={15} />
          Commit
        </Button>
        <Button
          variant="secondary"
          className={styles.push}
          disabled={busy !== null}
          title="Push"
          onClick={() => void run("push", push)}
        >
          <ArrowsClockwise size={14} style={{ transform: "rotate(180deg)" }} />
          {!!activeWorktree?.ahead && <span>{activeWorktree.ahead}</span>}
        </Button>
        <Button
          variant="secondary"
          className={styles.push}
          disabled={busy !== null}
          title="Pull"
          onClick={() => void run("pull", pull)}
        >
          <ArrowDown size={14} />
          {!!activeWorktree?.behind && <span>{activeWorktree.behind}</span>}
        </Button>
        <Button
          variant="secondary"
          className={styles.push}
          disabled={busy !== null}
          title="Fetch"
          onClick={() => void run("fetch", fetch)}
        >
          <ArrowsClockwise size={14} />
        </Button>
      </div>
    </div>
  );
}

function ScmView() {
  const ensureTab = useTabsStore((s) => s.ensureTab);
  const activeTabId = useTabsStore((s) => s.activeTabId);
  const activeWorktree = useActiveWorktree();
  const status = useScmStore((s) => s.status);
  const stagePaths = useScmStore((s) => s.stagePaths);
  const stageAll = useScmStore((s) => s.stageAll);
  const unstagePaths = useScmStore((s) => s.unstagePaths);
  const unstageAll = useScmStore((s) => s.unstageAll);
  const discardChange = useScmStore((s) => s.discardChange);
  const [discardTarget, setDiscardTarget] = useState<string | null>(null);

  const entries = status?.entries ?? [];
  const conflicted = entries.filter((e) => e.staged?.kind === "conflicted");
  const staged = entries.filter((e) => e.staged && e.staged.kind !== "conflicted");
  const changes = entries.filter((e) => e.unstaged);

  function openDiff(entry: FileStatusEntry, mode: "staged" | "unstaged") {
    if (!activeWorktree) return;
    const id = diffTabId(activeWorktree.id, entry.path, mode);
    ensureTab({
      id,
      type: "diff",
      title: splitPath(entry.path).name,
      filePath: entry.path,
      worktreeRoot: activeWorktree.path,
      diffMode: mode,
    });
  }

  return (
    <div className={sidebar.panel} data-side="right">
      <div className={sidebar.header}>
        <span className={sidebar.headerLabel}>Source Control</span>
        <span
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: "var(--text-xs)",
            color: "var(--text-dim)",
          }}
        >
          {activeWorktree?.branch ?? "—"}
        </span>
      </div>

      <CommitBox />

      <div className={sidebar.body}>
        {conflicted.length > 0 && (
          <>
            <div className={styles.sectionHeader}>
              <WarningCircle size={12} color="var(--red)" />
              Conflicted
              <span className={styles.sectionCount}>{conflicted.length}</span>
            </div>
            {conflicted.map((entry) => (
              <FileRow
                key={`conflict:${entry.path}`}
                entry={entry}
                kind={entry.staged!}
                active={false}
              />
            ))}
          </>
        )}

        <div className={styles.sectionHeader}>
          <CaretDown size={11} />
          Staged changes
          <span className={styles.sectionCount}>{staged.length}</span>
          {staged.length > 0 && (
            <span
              className={sidebar.rowAction}
              style={{ marginLeft: "auto", opacity: 1, cursor: "pointer" }}
              title="Unstage all"
              onClick={() => void unstageAll()}
            >
              <Minus size={12} />
            </span>
          )}
        </div>
        {staged.map((entry) => (
          <FileRow
            key={`staged:${entry.path}`}
            entry={entry}
            kind={entry.staged!}
            active={
              !!activeWorktree && activeTabId === diffTabId(activeWorktree.id, entry.path, "staged")
            }
            onOpen={() => openDiff(entry, "staged")}
            actions={
              <span
                className={sidebar.rowAction}
                title="Unstage"
                onClick={(event) => {
                  event.stopPropagation();
                  void unstagePaths([entry.path]);
                }}
              >
                <Minus size={12} />
              </span>
            }
          />
        ))}

        <div className={styles.sectionHeader}>
          <CaretDown size={11} />
          Changes
          <span className={styles.sectionCount}>{changes.length}</span>
          {changes.length > 0 && (
            <span
              className={sidebar.rowAction}
              style={{ marginLeft: "auto", opacity: 1, cursor: "pointer" }}
              title="Stage all"
              onClick={() => void stageAll()}
            >
              <Plus size={12} />
            </span>
          )}
        </div>
        {changes.map((entry) => (
          <FileRow
            key={`changes:${entry.path}`}
            entry={entry}
            kind={entry.unstaged!}
            active={
              !!activeWorktree &&
              activeTabId === diffTabId(activeWorktree.id, entry.path, "unstaged")
            }
            onOpen={() => openDiff(entry, "unstaged")}
            actions={
              <>
                <span
                  className={sidebar.rowAction}
                  title="Stage"
                  onClick={(event) => {
                    event.stopPropagation();
                    void stagePaths([entry.path]);
                  }}
                >
                  <Plus size={12} />
                </span>
                <span
                  className={sidebar.rowAction}
                  title="Discard"
                  onClick={(event) => {
                    event.stopPropagation();
                    setDiscardTarget(entry.path);
                  }}
                >
                  <ArrowCounterClockwise size={12} />
                </span>
              </>
            }
          />
        ))}
      </div>

      <AlertDialog
        open={discardTarget !== null}
        onOpenChange={(open) => {
          if (!open) setDiscardTarget(null);
        }}
        title="Discard changes?"
        description={
          discardTarget
            ? `This permanently discards unstaged changes to "${splitPath(discardTarget).name}". This can't be undone.`
            : ""
        }
        confirmLabel="Discard"
        onConfirm={() => {
          if (discardTarget) void discardChange(discardTarget);
          setDiscardTarget(null);
        }}
      />
    </div>
  );
}

function CommitFileRow({
  worktreeId,
  worktreeRoot,
  hash,
  path,
  kind,
}: {
  worktreeId: string;
  worktreeRoot: string;
  hash: string;
  path: string;
  kind: StatusKind;
}) {
  const ensureTab = useTabsStore((s) => s.ensureTab);
  const activeTabId = useTabsStore((s) => s.activeTabId);
  const { name, dir } = splitPath(path);
  const { icon: Icon, color } = iconForFile(name);
  const { glyph, color: glyphColor } = glyphFor(kind);
  const id = diffTabId(worktreeId, path, "commit", hash);

  return (
    <div
      className={`${sidebar.row} ${sidebar.indent1}`}
      data-active={activeTabId === id}
      onClick={() =>
        ensureTab({
          id,
          type: "diff",
          title: name,
          filePath: path,
          worktreeRoot,
          diffMode: "commit",
          commitHash: hash,
        })
      }
    >
      <Icon size={14} color={color} />
      <span className={sidebar.rowLabel}>{name}</span>
      {dir && <span className={styles.filePath}>{dir}</span>}
      <span className={styles.statusGlyph} style={{ color: glyphColor }}>
        {glyph}
      </span>
    </div>
  );
}

function HistoryView() {
  const activeWorktree = useActiveWorktree();
  const commits = useScmStore((s) => s.commits);
  const commitsExhausted = useScmStore((s) => s.commitsExhausted);
  const loadCommitLog = useScmStore((s) => s.loadCommitLog);
  const getCommitFiles = useScmStore((s) => s.getCommitFiles);
  const [expandedHash, setExpandedHash] = useState<string | null>(null);
  const [filesByHash, setFilesByHash] = useState<Record<string, CommitFileEntry[]>>({});

  // `key={activeWorktree?.id}` at the call site below remounts this whole
  // component on worktree switch, which is what resets `expandedHash`/
  // `filesByHash` — this effect only needs to kick off the initial load.
  useEffect(() => {
    void loadCommitLog(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function toggleCommit(hash: string) {
    if (expandedHash === hash) {
      setExpandedHash(null);
      return;
    }
    setExpandedHash(hash);
    if (!filesByHash[hash]) {
      void getCommitFiles(hash).then((files) => {
        setFilesByHash((prev) => ({ ...prev, [hash]: files }));
      });
    }
  }

  return (
    <div className={sidebar.panel} data-side="right">
      <div className={sidebar.header}>
        <span className={sidebar.headerLabel}>Commit history</span>
        <span
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: "var(--text-xs)",
            color: "var(--text-dim)",
          }}
        >
          {activeWorktree?.branch ?? "—"}
        </span>
      </div>
      <div className={sidebar.body}>
        {commits.map((commit, i) => {
          const expanded = expandedHash === commit.hash;
          return (
            <div key={commit.hash}>
              <div className={styles.commitRow} onClick={() => toggleCommit(commit.hash)}>
                <div className={styles.commitGraph}>
                  <span
                    className={styles.commitDot}
                    style={{ background: i === 0 ? "var(--accent)" : "var(--text-dim)" }}
                  />
                  {(i < commits.length - 1 || !commitsExhausted) && (
                    <span className={styles.commitLine} />
                  )}
                </div>
                <div className={styles.commitBody}>
                  <div className={styles.commitMsg}>{commit.message}</div>
                  <div className={styles.commitMeta}>
                    <span className={styles.commitHash}>{commit.shortHash}</span>
                    <span>{commit.author}</span>
                    <span>·</span>
                    <span>{relativeTime(commit.timestamp)}</span>
                  </div>
                </div>
                {expanded ? <CaretDown size={12} /> : <CaretRight size={12} />}
              </div>
              {expanded &&
                activeWorktree &&
                (filesByHash[commit.hash] ?? []).map(([path, kind]) => (
                  <CommitFileRow
                    key={path}
                    worktreeId={activeWorktree.id}
                    worktreeRoot={activeWorktree.path}
                    hash={commit.hash}
                    path={path}
                    kind={kind}
                  />
                ))}
            </div>
          );
        })}
        {!commitsExhausted && commits.length > 0 && (
          <Button variant="ghost" style={{ margin: "var(--space-5)" }} onClick={() => void loadCommitLog()}>
            Load more
          </Button>
        )}
      </div>
    </div>
  );
}

export function ExplorerSidebar() {
  const rightSidebarOpen = useUiStore((s) => s.rightSidebarOpen);
  const sidebarView = useUiStore((s) => s.sidebarView);
  const activeWorktree = useActiveWorktree();

  if (!rightSidebarOpen) return null;

  if (sidebarView === "scm") return <ScmView />;
  // Keyed on the active worktree so switching worktrees remounts
  // HistoryView fresh — resets its local expand/files-cache state without
  // needing a setState-in-effect to do it.
  if (sidebarView === "history") return <HistoryView key={activeWorktree?.id} />;
  return <FileTree />;
}
