import {
  CaretDown,
  CaretRight,
  Check,
  FilePlus,
  FileText,
  FileTs,
  FolderOpen,
  FolderSimplePlus,
} from "@phosphor-icons/react";
import { useTabsStore } from "../../state/tabsStore";
import { useUiStore } from "../../state/uiStore";
import { useActiveWorktree } from "../../state/workspaceStore";
import { IconButton, Button } from "../primitives";
import sidebar from "./Sidebar.module.css";
import styles from "./ExplorerSidebar.module.css";

// The file/diff/commit lists below stay mock data (Phase 3/4 scope) — only
// the branch label reflects the real active worktree, wired in Phase 2.
function ExplorerView() {
  const ensureTab = useTabsStore((s) => s.ensureTab);
  const activeTabId = useTabsStore((s) => s.activeTabId);
  const activeWorktree = useActiveWorktree();

  return (
    <div className={sidebar.panel} data-side="right">
      <div className={sidebar.header}>
        <span className={sidebar.headerLabel}>
          Explorer · {activeWorktree?.branch ?? "no worktree selected"}
        </span>
        <div className={sidebar.headerActions}>
          <IconButton icon={FilePlus} label="New file" size="sm" iconSize={14} />
          <IconButton icon={FolderSimplePlus} label="New folder" size="sm" iconSize={14} />
        </div>
      </div>
      <div className={sidebar.body}>
        <div className={sidebar.row}>
          <CaretDown size={11} color="var(--text-mute)" />
          <FolderOpen size={15} color="var(--accent-2)" />
          <span className={sidebar.rowLabel}>src</span>
        </div>
        <div className={`${sidebar.row} ${sidebar.indent1}`}>
          <CaretDown size={11} color="var(--text-mute)" />
          <FolderOpen size={15} color="var(--accent-2)" />
          <span className={sidebar.rowLabel}>payment</span>
        </div>
        <div
          className={`${sidebar.row} ${sidebar.indent2}`}
          data-active={activeTabId === "f1"}
          onClick={() => ensureTab({ id: "f1", type: "file", title: "payment.service.ts" })}
        >
          <FileTs size={15} color="var(--blue)" />
          <span className={sidebar.rowLabel}>payment.service.ts</span>
          <span className={styles.statusGlyph} style={{ color: "var(--yellow)" }}>
            M
          </span>
        </div>
        <div className={`${sidebar.row} ${sidebar.indent2}`}>
          <FileTs size={15} color="var(--blue)" />
          <span className={sidebar.rowLabel}>payment.controller.ts</span>
        </div>
        <div className={`${sidebar.row} ${sidebar.indent2}`}>
          <FileTs size={15} color="var(--blue)" />
          <span className={sidebar.rowLabel}>idempotency.ts</span>
          <span className={styles.statusGlyph} style={{ color: "var(--green)" }}>
            U
          </span>
        </div>
        <div className={`${sidebar.row} ${sidebar.indent1}`}>
          <CaretDown size={11} color="var(--text-mute)" />
          <FolderOpen size={15} color="var(--accent-2)" />
          <span className={sidebar.rowLabel}>auth</span>
        </div>
        <div
          className={`${sidebar.row} ${sidebar.indent2}`}
          data-active={activeTabId === "d1"}
          onClick={() => ensureTab({ id: "d1", type: "diff", title: "auth.controller.ts" })}
        >
          <FileTs size={15} color="var(--blue)" />
          <span className={sidebar.rowLabel}>auth.controller.ts</span>
          <span className={styles.statusGlyph} style={{ color: "var(--yellow)" }}>
            M
          </span>
        </div>
        <div className={`${sidebar.row} ${sidebar.indent1}`}>
          <FileTs size={15} color="var(--blue)" />
          <span className={sidebar.rowLabel}>app.module.ts</span>
        </div>
        <div className={sidebar.row}>
          <CaretRight size={11} color="var(--text-mute)" />
          <FolderOpen size={15} color="var(--text-mute)" />
          <span className={sidebar.rowLabel}>test</span>
        </div>
        <div className={sidebar.row}>
          <FileText size={15} color="var(--text-mute)" />
          <span className={sidebar.rowLabel}>.env</span>
        </div>
        <div
          className={sidebar.row}
          data-active={activeTabId === "m1"}
          onClick={() => ensureTab({ id: "m1", type: "markdown", title: "README.md" })}
        >
          <FileText size={15} color="var(--accent-2)" />
          <span className={sidebar.rowLabel}>README.md</span>
        </div>
      </div>
    </div>
  );
}

function ScmView() {
  const ensureTab = useTabsStore((s) => s.ensureTab);
  const activeTabId = useTabsStore((s) => s.activeTabId);
  const activeWorktree = useActiveWorktree();

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
      <div className={styles.scmBox}>
        <div className={styles.commitMessage}>
          Message (⌘Enter to commit)
          <strong>feat(payments): add idempotency keys + retry backoff</strong>
        </div>
        <div className={styles.scmActions}>
          <Button variant="primary" style={{ flex: 1 }}>
            <Check size={15} />
            Commit
          </Button>
          <Button variant="secondary" className={styles.push}>
            Push <span>2</span>
          </Button>
        </div>
      </div>

      <div className={sidebar.body}>
        <div className={styles.sectionHeader}>
          <CaretDown size={11} />
          Staged changes
          <span className={styles.sectionCount}>1</span>
        </div>
        <div className={sidebar.row}>
          <FileTs size={15} color="var(--blue)" />
          <span className={sidebar.rowLabel}>idempotency.ts</span>
          <span className={styles.filePath}>src/payment</span>
          <span className={styles.statusGlyph} style={{ color: "var(--green)" }}>
            A
          </span>
        </div>

        <div className={styles.sectionHeader}>
          <CaretDown size={11} />
          Changes
          <span className={styles.sectionCount}>3</span>
        </div>
        <div
          className={sidebar.row}
          data-active={activeTabId === "d1"}
          onClick={() => ensureTab({ id: "d1", type: "diff", title: "payment.service.ts" })}
        >
          <FileTs size={15} color="var(--blue)" />
          <span className={sidebar.rowLabel}>payment.service.ts</span>
          <span className={styles.filePath}>src/payment</span>
          <span className={styles.statusGlyph} style={{ color: "var(--yellow)" }}>
            M
          </span>
        </div>
        <div
          className={sidebar.row}
          onClick={() => ensureTab({ id: "d1", type: "diff", title: "auth.controller.ts" })}
        >
          <FileTs size={15} color="var(--blue)" />
          <span className={sidebar.rowLabel}>auth.controller.ts</span>
          <span className={styles.filePath}>src/auth</span>
          <span className={styles.statusGlyph} style={{ color: "var(--yellow)" }}>
            M
          </span>
        </div>
        <div className={sidebar.row}>
          <FileText size={15} color="var(--red)" />
          <span className={sidebar.rowLabel}>legacy-retry.ts</span>
          <span className={styles.filePath}>src/payment</span>
          <span className={styles.statusGlyph} style={{ color: "var(--red)" }}>
            D
          </span>
        </div>
      </div>
    </div>
  );
}

interface MockCommit {
  hash: string;
  msg: string;
  author: string;
  time: string;
  dot: string;
}

const MOCK_COMMITS: MockCommit[] = [
  {
    hash: "a3f9c1",
    msg: "feat(payments): idempotency keys + retry backoff",
    author: "you",
    time: "2h ago",
    dot: "var(--accent)",
  },
  {
    hash: "e21b70",
    msg: "refactor: extract Gateway adapter interface",
    author: "you",
    time: "5h ago",
    dot: "var(--text-dim)",
  },
  {
    hash: "9c04af",
    msg: "test: cover partial-failure retry paths",
    author: "maya",
    time: "yesterday",
    dot: "var(--text-dim)",
  },
  {
    hash: "77de12",
    msg: "chore: bump nestjs to 10.3",
    author: "you",
    time: "yesterday",
    dot: "var(--text-dim)",
  },
  {
    hash: "4b8a09",
    msg: "fix: null card token on Adyen path",
    author: "liam",
    time: "2 days ago",
    dot: "var(--text-dim)",
  },
  {
    hash: "0f1e55",
    msg: "feat: Braintree gateway adapter",
    author: "you",
    time: "3 days ago",
    dot: "var(--text-dim)",
  },
];

function HistoryView() {
  const activeWorktree = useActiveWorktree();
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
        {MOCK_COMMITS.map((commit, i) => (
          <div key={commit.hash} className={styles.commitRow}>
            <div className={styles.commitGraph}>
              <span className={styles.commitDot} style={{ background: commit.dot }} />
              {i < MOCK_COMMITS.length - 1 && <span className={styles.commitLine} />}
            </div>
            <div className={styles.commitBody}>
              <div className={styles.commitMsg}>{commit.msg}</div>
              <div className={styles.commitMeta}>
                <span className={styles.commitHash}>{commit.hash}</span>
                <span>{commit.author}</span>
                <span>·</span>
                <span>{commit.time}</span>
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

export function ExplorerSidebar() {
  const rightSidebarOpen = useUiStore((s) => s.rightSidebarOpen);
  const sidebarView = useUiStore((s) => s.sidebarView);

  if (!rightSidebarOpen) return null;

  if (sidebarView === "scm") return <ScmView />;
  if (sidebarView === "history") return <HistoryView />;
  return <ExplorerView />;
}
