import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import {
  ArrowCounterClockwise,
  ArrowsClockwise,
  ArrowDown,
  CaretDown,
  CaretRight,
  Check,
  Minus,
  Plus,
  Sparkle,
  WarningCircle,
} from "@phosphor-icons/react";
import { useTabsStore, diffTabId } from "../../state/tabsStore";
import { useUiStore } from "../../state/uiStore";
import { useActiveWorktree } from "../../state/workspaceStore";
import { useScmStore } from "../../state/scmStore";
import { useReadyAgentKinds } from "../../state/agentAvailabilityStore";
import { agentsApi } from "../../api/agents";
import { gitApi } from "../../api/git";
import { AGENT_DISPLAY_NAME } from "../../types/agent";
import type { AgentKind } from "../../types/agent";
import { relativeTime } from "../../design/relativeTime";
import { isMac } from "../../design/platform";
import { iconForFile } from "../explorer/fileIcons";
import { AlertDialog, Button, IconButton, Tooltip } from "../primitives";
import { ICON_SIZE } from "../../design/iconSize";
import { FileTree } from "../explorer/FileTree";
import { SearchPanel } from "../search/SearchPanel";
import { ProblemsPanel } from "../problems/ProblemsPanel";
import { ScmContextMenu } from "./ScmContextMenu";
import type {
  CommitFileEntry,
  FileStatusEntry,
  ReviewFile,
  StashEntry,
  StatusKind,
} from "../../types/git";
import { flattenScmRows, splitScmSections, type ScmRow } from "./scmRows";
import sidebar from "./Sidebar.module.css";
import styles from "./ExplorerSidebar.module.css";

function splitPath(path: string): { name: string; dir: string } {
  const idx = path.lastIndexOf("/");
  return idx === -1
    ? { name: path, dir: "" }
    : { name: path.slice(idx + 1), dir: path.slice(0, idx) };
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
  onStage?: () => void;
  onUnstage?: () => void;
  onDiscard?: () => void;
}

/** A single Source Control row: file-type icon, name, (optional) parent
 * directory, and a trailing group of hover-revealed action buttons plus
 * the status glyph. The trailing group carries its own `margin-left:
 * auto` (`.trailing`) rather than relying on `.filePath`'s flex-grow to
 * push it right — a file with no subdirectory (`dir` empty, common for
 * repo-root scripts) previously left nothing to push against, so the
 * glyph drifted left and column-misaligned against every row that *did*
 * have a directory shown. */
function FileRow({ entry, kind, active, onOpen, onStage, onUnstage, onDiscard }: FileRowProps) {
  const { name, dir } = splitPath(entry.path);
  const { icon: Icon, color } = iconForFile(name);
  const { glyph, color: glyphColor } = glyphFor(kind);
  const label =
    kind.kind === "renamed" || kind.kind === "copied"
      ? `${splitPath(entry.oldPath ?? entry.path).name} → ${name}`
      : name;
  // `.rowAction` buttons are hover-revealed via `opacity`, not conditional
  // rendering, so they're always in the layout — but sizing `.trailing`
  // from their own geometry means its width depends on those buttons
  // being measured correctly while invisible, which WebKitGTK doesn't
  // reliably do (same repaint-on-opacity-change class of bug `.row`'s
  // `will-change` comment documents). Pinning an explicit min-width here,
  // computed from the actual action count rather than the buttons'
  // rendered geometry, keeps every row's status glyph in the same column
  // regardless of hover state or which row is currently hovered.
  const actionCount = [onStage, onUnstage, onDiscard].filter(Boolean).length;

  return (
    <ScmContextMenu path={entry.path} onStage={onStage} onUnstage={onUnstage} onDiscard={onDiscard}>
      <Tooltip label={entry.path} side="left">
        <div className={sidebar.row} data-active={active} onClick={onOpen}>
          <span className={styles.fileIcon}>
            <Icon size={ICON_SIZE.sm} color={color} />
          </span>
          <span className={styles.fileName}>{label}</span>
          {dir && <span className={styles.filePath}>{dir}</span>}
          <span
            className={styles.trailing}
            style={{ "--trailing-actions": actionCount } as CSSProperties}
          >
            {onStage && (
              <IconButton
                icon={Plus}
                label="Stage"
                size="sm"
                iconSize={13}
                className={sidebar.rowAction}
                onClick={(e) => {
                  e.stopPropagation();
                  onStage();
                }}
              />
            )}
            {onUnstage && (
              <IconButton
                icon={Minus}
                label="Unstage"
                size="sm"
                iconSize={13}
                className={sidebar.rowAction}
                onClick={(e) => {
                  e.stopPropagation();
                  onUnstage();
                }}
              />
            )}
            {onDiscard && (
              <IconButton
                icon={ArrowCounterClockwise}
                label="Discard"
                size="sm"
                iconSize={13}
                className={sidebar.rowAction}
                onClick={(e) => {
                  e.stopPropagation();
                  onDiscard();
                }}
              />
            )}
            <span className={styles.statusGlyph} style={{ color: glyphColor }}>
              {glyph}
            </span>
          </span>
        </div>
      </Tooltip>
    </ScmContextMenu>
  );
}

/** "Generate with AI" split-button — the concrete cross-feature use case
 * that motivated centralizing agent availability
 * (`agentAvailabilityStore`): draft a commit message from the staged
 * diff using whichever CLI is ready, or a specifically picked one via
 * the caret. See `commands/agents.rs::generate_commit_message`. */
function GenerateCommitMessageButton({
  worktreeRoot,
  onGenerated,
}: {
  worktreeRoot: string;
  onGenerated: (message: string) => void;
}) {
  const readyKinds = useReadyAgentKinds();
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (readyKinds.length === 0) return null;

  async function generate(kind: AgentKind) {
    setGenerating(true);
    setError(null);
    try {
      const message = await agentsApi.generateCommitMessage(kind, worktreeRoot);
      onGenerated(message);
    } catch (err) {
      setError(String(err));
    } finally {
      setGenerating(false);
    }
  }

  return (
    <div style={{ display: "flex", alignItems: "center" }} title={error ?? undefined}>
      <div
        onClick={() => !generating && void generate(readyKinds[0])}
        style={{
          display: "flex",
          alignItems: "center",
          gap: "0.25rem",
          padding: "0.125rem 0.375rem",
          borderRadius: "var(--radius-sm)",
          cursor: generating ? "default" : "pointer",
          fontSize: "var(--text-2xs)",
          color: error ? "var(--red)" : "var(--text-mute)",
        }}
      >
        <Sparkle size={12} className={generating ? "mo-spin" : undefined} />
        {generating ? "Generating…" : "Generate with AI"}
      </div>
      {readyKinds.length > 1 && (
        <DropdownMenu.Root>
          <DropdownMenu.Trigger asChild>
            <div style={{ padding: "0.125rem", cursor: "pointer", color: "var(--text-mute)" }}>
              <CaretDown size={9} />
            </div>
          </DropdownMenu.Trigger>
          <DropdownMenu.Portal>
            <DropdownMenu.Content
              className="mo-glass"
              align="end"
              sideOffset={4}
              style={{
                padding: "0.25rem",
                borderRadius: "var(--radius-lg)",
                border: "1px solid var(--border-2)",
              }}
            >
              {readyKinds.map((kind) => (
                <DropdownMenu.Item
                  key={kind}
                  onSelect={() => void generate(kind)}
                  style={{
                    padding: "0.375rem 0.625rem",
                    borderRadius: "var(--radius-md)",
                    cursor: "pointer",
                    fontSize: "var(--text-sm)",
                  }}
                >
                  {AGENT_DISPLAY_NAME[kind]}
                </DropdownMenu.Item>
              ))}
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu.Root>
      )}
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
          placeholder={`Message (${isMac() ? "⌘Enter" : "Ctrl+Enter"} to commit)`}
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
        {activeWorktree && (
          <div style={{ display: "flex", justifyContent: "flex-end", marginTop: "0.125rem" }}>
            <GenerateCommitMessageButton
              worktreeRoot={activeWorktree.path}
              onGenerated={setMessage}
            />
          </div>
        )}
      </div>
      {error && (
        <div className={styles.scmError} onClick={clearError}>
          {error}
        </div>
      )}
      <div className={styles.scmActions}>
        <Button
          variant="primary"
          className={styles.scmAction}
          disabled={!canCommit}
          onClick={handleCommit}
        >
          {busy === "commit" ? (
            <ArrowsClockwise size={14} className="mo-spin" />
          ) : (
            <Check size={15} />
          )}
          Commit
        </Button>
        <Button
          variant="secondary"
          className={styles.scmAction}
          disabled={busy !== null}
          title="Pull from remote"
          onClick={() => void run("pull", pull)}
        >
          {busy === "pull" ? (
            <ArrowsClockwise size={14} className="mo-spin" />
          ) : (
            <ArrowDown size={14} />
          )}
          Pull
          {!!activeWorktree?.behind && (
            <span className={styles.scmActionCount}>{activeWorktree.behind}</span>
          )}
        </Button>
        <Button
          variant="secondary"
          className={styles.scmAction}
          disabled={busy !== null}
          title="Push to remote"
          onClick={() => void run("push", push)}
        >
          {busy === "push" ? (
            <ArrowsClockwise size={14} className="mo-spin" />
          ) : (
            <ArrowsClockwise size={14} style={{ transform: "rotate(180deg)" }} />
          )}
          Push
          {!!activeWorktree?.ahead && (
            <span className={styles.scmActionCount}>{activeWorktree.ahead}</span>
          )}
        </Button>
      </div>
    </div>
  );
}

/** A Source Control section header — click anywhere on it (other than the
 * bulk-action icon) to collapse/expand that section's rows. Previously
 * this was inert: a `CaretDown` that never became a `CaretRight` and
 * never actually hid anything. */
function SectionHeader({
  icon,
  label,
  count,
  collapsed,
  onToggle,
  bulkAction,
}: {
  icon?: ReactNode;
  label: string;
  count: number;
  collapsed: boolean;
  onToggle: () => void;
  bulkAction?: ReactNode;
}) {
  return (
    <div
      className={styles.sectionHeader}
      role="button"
      tabIndex={0}
      aria-expanded={!collapsed}
      onClick={onToggle}
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget || (event.key !== "Enter" && event.key !== " "))
          return;
        event.preventDefault();
        onToggle();
      }}
    >
      {collapsed ? <CaretRight size={11} /> : <CaretDown size={11} />}
      {icon}
      {label}
      <span className={styles.sectionCount}>{count}</span>
      {bulkAction}
    </div>
  );
}

/** A flattened SCM row: section headers and file rows share one list so a
 * single virtualizer spans all three sections. */

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
  const discardPaths = useScmStore((s) => s.discardPaths);
  const [discardTarget, setDiscardTarget] = useState<string | null>(null);
  const [discardAllOpen, setDiscardAllOpen] = useState(false);
  const [conflictedCollapsed, setConflictedCollapsed] = useState(false);
  const [stagedCollapsed, setStagedCollapsed] = useState(false);
  const [changesCollapsed, setChangesCollapsed] = useState(false);

  const entries = useMemo(() => status?.entries ?? [], [status]);
  const sections = useMemo(() => splitScmSections(entries), [entries]);
  const { conflicted, staged, changes } = sections;

  // A large refactor or a fresh clone puts thousands of entries here, and
  // every one of them used to become a DOM row whether or not it was
  // scrolled to (docs/PERFORMANCE_AUDIT.md §2.3).
  const rows = useMemo(
    () =>
      flattenScmRows(sections, {
        conflicted: conflictedCollapsed,
        staged: stagedCollapsed,
        changes: changesCollapsed,
      }),
    [sections, conflictedCollapsed, stagedCollapsed, changesCollapsed],
  );

  const scrollRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    // Headers and file rows differ slightly in height, and both scale with
    // the app's rem-based zoom — measured rather than assumed.
    estimateSize: () => 26,
    getItemKey: (index) => rows[index].key,
    overscan: 10,
  });
  const virtualItems = virtualizer.getVirtualItems();

  function renderRow(row: ScmRow) {
    if (row.kind === "header") {
      if (row.section === "conflicted") {
        return (
          <SectionHeader
            icon={<WarningCircle size={12} color="var(--red)" />}
            label="Conflicted"
            count={conflicted.length}
            collapsed={conflictedCollapsed}
            onToggle={() => setConflictedCollapsed((c) => !c)}
          />
        );
      }
      if (row.section === "staged") {
        return (
          <SectionHeader
            label="Staged changes"
            count={staged.length}
            collapsed={stagedCollapsed}
            onToggle={() => setStagedCollapsed((c) => !c)}
            bulkAction={
              staged.length > 0 && (
                <IconButton
                  icon={Minus}
                  label="Unstage all"
                  size="sm"
                  iconSize={13}
                  className={styles.bulkAction}
                  onClick={(e) => {
                    e.stopPropagation();
                    void unstageAll();
                  }}
                />
              )
            }
          />
        );
      }
      return (
        <SectionHeader
          label="Changes"
          count={changes.length}
          collapsed={changesCollapsed}
          onToggle={() => setChangesCollapsed((c) => !c)}
          bulkAction={
            changes.length > 0 && (
              <>
                <IconButton
                  icon={ArrowCounterClockwise}
                  label="Discard all changes"
                  size="sm"
                  iconSize={13}
                  className={styles.bulkAction}
                  onClick={(e) => {
                    e.stopPropagation();
                    setDiscardAllOpen(true);
                  }}
                />
                <IconButton
                  icon={Plus}
                  label="Stage all"
                  size="sm"
                  iconSize={13}
                  className={styles.bulkAction}
                  onClick={(e) => {
                    e.stopPropagation();
                    void stageAll();
                  }}
                />
              </>
            )
          }
        />
      );
    }

    const { entry, section } = row;
    if (section === "conflicted") {
      const mergeId = activeWorktree ? `merge:${activeWorktree.id}:${entry.path}` : "";
      return (
        <FileRow
          entry={entry}
          kind={entry.staged!}
          active={activeTabId === mergeId}
          onOpen={() => openMerge(entry)}
        />
      );
    }
    if (section === "staged") {
      return (
        <FileRow
          entry={entry}
          kind={entry.staged!}
          active={
            !!activeWorktree && activeTabId === diffTabId(activeWorktree.id, entry.path, "staged")
          }
          onOpen={() => openDiff(entry, "staged")}
          onUnstage={() => void unstagePaths([entry.path])}
        />
      );
    }
    return (
      <FileRow
        entry={entry}
        kind={entry.unstaged!}
        active={
          !!activeWorktree && activeTabId === diffTabId(activeWorktree.id, entry.path, "unstaged")
        }
        onOpen={() => openDiff(entry, "unstaged")}
        onStage={() => void stagePaths([entry.path])}
        onDiscard={() => setDiscardTarget(entry.path)}
      />
    );
  }

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

  function openMerge(entry: FileStatusEntry) {
    if (!activeWorktree) return;
    ensureTab({
      id: `merge:${activeWorktree.id}:${entry.path}`,
      type: "merge",
      title: `Resolve ${splitPath(entry.path).name}`,
      filePath: entry.path,
      worktreeId: activeWorktree.id,
      worktreeRoot: activeWorktree.path,
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
      <StashPanel />

      {/* `sidebar.body` is itself the virtualizer's scroll element: it has no
          top padding, so its scrollTop maps 1:1 onto the virtualizer's
          coordinate space with no `scrollMargin` correction needed. */}
      <div className={sidebar.body} ref={scrollRef}>
        <div className={styles.scmSizer} style={{ height: virtualizer.getTotalSize() }}>
          <div
            className={styles.scmWindow}
            style={{ transform: `translateY(${virtualItems[0]?.start ?? 0}px)` }}
          >
            {virtualItems.map((virtualItem) => (
              <div
                key={virtualItem.key}
                data-index={virtualItem.index}
                ref={virtualizer.measureElement}
              >
                {renderRow(rows[virtualItem.index])}
              </div>
            ))}
          </div>
        </div>
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

      {/* Deliberately scoped to the `Changes` section only — staged work
          is left alone (Unstage all is its own button), as are conflicted
          paths, which `git restore` refuses while they need merge. */}
      <AlertDialog
        open={discardAllOpen}
        onOpenChange={setDiscardAllOpen}
        title="Discard all changes?"
        description={`This permanently discards unstaged changes to ${changes.length} ${
          changes.length === 1 ? "file" : "files"
        }, deleting any untracked ones. This can't be undone.`}
        confirmLabel="Discard all"
        onConfirm={() => {
          void discardPaths(changes.map((entry) => entry.path));
          setDiscardAllOpen(false);
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
    <Tooltip label={path} side="left">
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
        <span className={styles.fileIcon}>
          <Icon size={ICON_SIZE.sm} color={color} />
        </span>
        <span className={styles.fileName}>{name}</span>
        {dir && <span className={styles.filePath}>{dir}</span>}
        <span className={styles.statusGlyph} style={{ color: glyphColor }}>
          {glyph}
        </span>
      </div>
    </Tooltip>
  );
}

function StashPanel() {
  const activeWorktree = useActiveWorktree();
  const ensureTab = useTabsStore((state) => state.ensureTab);
  const [open, setOpen] = useState(false);
  const [message, setMessage] = useState("");
  const [stashes, setStashes] = useState<StashEntry[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<StashEntry | null>(null);

  async function refresh() {
    if (!activeWorktree) return;
    setStashes(await gitApi.listStashes(activeWorktree.path));
  }

  useEffect(() => {
    if (!activeWorktree) return;
    let live = true;
    gitApi.listStashes(activeWorktree.path).then((entries) => {
      if (live) setStashes(entries);
    });
    return () => {
      live = false;
    };
  }, [activeWorktree]);

  async function run(key: string, action: () => Promise<void>) {
    setBusy(key);
    try {
      await action();
      await refresh();
      await useScmStore.getState().refreshStatus();
    } finally {
      setBusy(null);
    }
  }

  async function review(stash: StashEntry) {
    if (!activeWorktree) return;
    const entries = await gitApi.getStashFiles(activeWorktree.path, stash.reference);
    const reviewFiles: ReviewFile[] = entries.map(([path, kind]) => ({
      path,
      kind,
      mode: "commit",
      commitHash: stash.hash,
    }));
    ensureTab({
      id: `review:stash:${activeWorktree.id}:${stash.hash}`,
      type: "review",
      title: stash.message,
      reviewSubtitle: `${stash.reference} · ${relativeTime(stash.timestamp)}`,
      worktreeId: activeWorktree.id,
      worktreeRoot: activeWorktree.path,
      reviewFiles,
    });
  }

  return (
    <div className={styles.stashPanel}>
      <button
        type="button"
        className={styles.stashHeading}
        onClick={() => setOpen((value) => !value)}
      >
        {open ? <CaretDown size={12} /> : <CaretRight size={12} />}
        <span>Stashes</span>
        <span className={styles.sectionCount}>{stashes.length}</span>
      </button>
      {open && (
        <div className={styles.stashBody}>
          <div className={styles.stashCreate}>
            <input
              value={message}
              onChange={(event) => setMessage(event.target.value)}
              placeholder="Optional stash message"
            />
            <button
              type="button"
              disabled={!activeWorktree || busy !== null}
              onClick={() =>
                activeWorktree &&
                void run("create", async () => {
                  await gitApi.createStash(activeWorktree.id, activeWorktree.path, message, true);
                  setMessage("");
                })
              }
            >
              {busy === "create" ? "Saving…" : "Stash all"}
            </button>
          </div>
          {stashes.map((stash) => (
            <div className={styles.stashRow} key={stash.hash}>
              <button type="button" className={styles.stashName} onClick={() => void review(stash)}>
                <strong>{stash.message}</strong>
                <span>
                  {stash.reference} · {relativeTime(stash.timestamp)}
                </span>
              </button>
              <button
                type="button"
                title="Apply and keep stash"
                disabled={busy !== null}
                onClick={() =>
                  activeWorktree &&
                  void run(stash.hash, () =>
                    gitApi.applyStash(
                      activeWorktree.id,
                      activeWorktree.path,
                      stash.reference,
                      false,
                    ),
                  )
                }
              >
                Apply
              </button>
              <button
                type="button"
                title="Apply and remove stash"
                disabled={busy !== null}
                onClick={() =>
                  activeWorktree &&
                  void run(stash.hash, () =>
                    gitApi.applyStash(
                      activeWorktree.id,
                      activeWorktree.path,
                      stash.reference,
                      true,
                    ),
                  )
                }
              >
                Pop
              </button>
              <button
                type="button"
                title="Delete stash"
                disabled={busy !== null}
                onClick={() => setDropTarget(stash)}
              >
                ×
              </button>
            </div>
          ))}
          {stashes.length === 0 && <div className={styles.stashEmpty}>No saved stashes.</div>}
        </div>
      )}
      <AlertDialog
        open={dropTarget !== null}
        onOpenChange={(next) => !next && setDropTarget(null)}
        title="Delete stash?"
        description={`This permanently deletes ${dropTarget?.reference ?? "this stash"}.`}
        confirmLabel="Delete"
        onConfirm={() => {
          if (activeWorktree && dropTarget)
            void run("drop", () => gitApi.dropStash(activeWorktree.path, dropTarget.reference));
          setDropTarget(null);
        }}
      />
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

  async function toggleCommit(hash: string) {
    if (expandedHash === hash) {
      setExpandedHash(null);
      return;
    }
    setExpandedHash(hash);
    const files = filesByHash[hash] ?? (await getCommitFiles(hash));
    if (!filesByHash[hash]) setFilesByHash((prev) => ({ ...prev, [hash]: files }));
    const worktree = activeWorktree;
    const commit = commits.find((entry) => entry.hash === hash);
    if (worktree && commit) {
      useTabsStore.getState().ensureTab({
        id: `review:commit:${worktree.id}:${hash}`,
        type: "review",
        title: commit.message,
        reviewSubtitle: `${commit.shortHash} · ${commit.author} · ${relativeTime(commit.timestamp)}`,
        worktreeId: worktree.id,
        worktreeRoot: worktree.path,
        reviewFiles: files.map(([path, kind]) => ({
          path,
          kind,
          mode: "commit",
          commitHash: hash,
        })),
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
              <div className={styles.commitRow} onClick={() => void toggleCommit(commit.hash)}>
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
          <Button
            variant="ghost"
            style={{ margin: "var(--space-5)" }}
            onClick={() => void loadCommitLog()}
          >
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
  if (sidebarView === "search") return <SearchPanel key={activeWorktree?.id} />;
  if (sidebarView === "problems") return <ProblemsPanel key={activeWorktree?.id} />;
  return <FileTree />;
}
