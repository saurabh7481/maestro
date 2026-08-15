import { useEffect, useMemo, useState } from "react";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import {
  Check,
  ClockCounterClockwise,
  Globe,
  Hexagon,
  Cursor as CursorIcon,
  Plus,
  Sparkle,
  TerminalWindow,
  WarningCircle,
} from "@phosphor-icons/react";
import type { Icon } from "@phosphor-icons/react";
import { useUiStore } from "../../state/uiStore";
import { useTabsStore } from "../../state/tabsStore";
import type { Tab } from "../../state/tabsStore";
import { useActiveWorktree, useWorkspaceStore, EMPTY_WORKTREES } from "../../state/workspaceStore";
import { useAgentAvailabilityStore } from "../../state/agentAvailabilityStore";
import { agentsApi } from "../../api/agents";
import { AGENT_DISPLAY_NAME, isReady } from "../../types/agent";
import type { AgentKind, ResumableSession } from "../../types/agent";
import { relativeTime } from "../../design/relativeTime";
import { Kbd, Tooltip } from "../primitives";
import styles from "./TabStrip.module.css";

interface AgentOption {
  kind: AgentKind;
  icon: Icon;
  iconTone: "gradient" | "outline";
  color: string;
  subtitle: string;
  shortcut: string;
}

const AGENT_OPTIONS: AgentOption[] = [
  {
    kind: "claudeCode",
    icon: Sparkle,
    iconTone: "gradient",
    color: "#0a0c11",
    subtitle: "anthropic · claude",
    shortcut: "⌘1",
  },
  {
    kind: "codex",
    icon: Hexagon,
    iconTone: "outline",
    color: "var(--green)",
    subtitle: "openai · codex",
    shortcut: "⌘2",
  },
  {
    kind: "cursorAgent",
    icon: CursorIcon,
    iconTone: "outline",
    color: "var(--accent-2)",
    subtitle: "cursor · agent",
    shortcut: "⌘3",
  },
];

// Sessions this CLI persists on disk in a format Maestro knows how to
// read non-interactively (see `agents/sessions.rs`) — Codex isn't
// covered (not installed anywhere to confirm its layout), so it's simply
// absent from the resume list rather than guessed at.
const SESSION_DISCOVERY_KINDS: AgentKind[] = ["claudeCode", "cursorAgent"];

interface TaggedSession extends ResumableSession {
  kind: AgentKind;
}

export function NewTabMenu() {
  const open = useUiStore((s) => s.newTabMenuOpen);
  const setOpen = useUiStore((s) => s.setNewTabMenuOpen);
  const openTab = useTabsStore((s) => s.openTab);
  const activeWorktree = useActiveWorktree();
  const activeProjectId = useWorkspaceStore((s) => s.activeProjectId);
  // Every worktree in the active project, not just the active one — a
  // resumable session found here can belong to any of them (see the
  // effect below), so `startAgentTab` needs the full set to resolve a
  // resumed session's tab back to the worktree it actually belongs to.
  const projectWorktrees = useWorkspaceStore((s) =>
    activeProjectId ? (s.worktreesByProject[activeProjectId] ?? EMPTY_WORKTREES) : EMPTY_WORKTREES,
  );
  // Every worktree across every project — the "search all projects"
  // toggle's superset. `worktreesByProject` itself is a stable store
  // reference (no `?? []`/derived-array selector — see
  // `agentSessionStore.ts`'s `EMPTY_ATTACHMENTS` comment for why that
  // matters), so flattening it in a `useMemo` outside the selector never
  // trips the "new array on every read" trap.
  const worktreesByProject = useWorkspaceStore((s) => s.worktreesByProject);
  const projects = useWorkspaceStore((s) => s.projects);
  const allWorktrees = useMemo(
    () => Object.values(worktreesByProject).flat(),
    [worktreesByProject],
  );
  const projectNameById = useMemo(
    () => new Map(projects.map((p) => [p.id, p.name])),
    [projects],
  );
  const statusByKind = useAgentAvailabilityStore((s) => s.statusByKind);
  const openSettings = useUiStore((s) => s.openSettings);

  const [resumeSessions, setResumeSessions] = useState<TaggedSession[]>([]);
  // Off by default — searching every project the user has ever opened
  // is a lot noisier than "the project I'm looking at right now", so
  // that stays the default; this is the explicit opt-in for "I know the
  // session I want was in a different project entirely."
  const [globalResume, setGlobalResume] = useState(false);
  const searchWorktrees = globalResume ? allWorktrees : projectWorktrees;

  // Scans every worktree in the search scope (not just the currently
  // active worktree) for resumable sessions — a session started in a
  // sibling worktree/project is exactly as resumable as one in this
  // worktree, the CLI's on-disk session store just happens to be keyed
  // per-cwd (see `agents/sessions.rs`).
  useEffect(() => {
    if (!open || searchWorktrees.length === 0) return;
    let cancelled = false;
    const roots = searchWorktrees.map((w) => w.path);
    void Promise.all(
      SESSION_DISCOVERY_KINDS.map(async (kind) => {
        const sessions = await agentsApi
          .listResumableSessionsForRoots(kind, roots)
          .catch(() => []);
        return sessions.map((s): TaggedSession => ({ ...s, kind }));
      }),
    ).then((byKind) => {
      if (cancelled) return;
      const merged = byKind.flat().sort((a, b) => b.lastActiveAt.localeCompare(a.lastActiveAt));
      setResumeSessions(merged);
    });
    return () => {
      cancelled = true;
    };
  }, [open, searchWorktrees]);

  function metaForRoot(worktreeRoot: string): { branch: string; projectName?: string } | undefined {
    const wt = allWorktrees.find((w) => w.path === worktreeRoot);
    if (!wt) return undefined;
    return { branch: wt.branch, projectName: projectNameById.get(wt.projectId) };
  }

  function startAgentTab(kind: AgentKind, resume?: ResumableSession) {
    // A resumed session's tab must be bound to the worktree it was
    // actually recorded under, not whichever worktree happens to be
    // active right now — they can differ once sessions from every
    // worktree (possibly in another project, with the toggle on) are on
    // offer. Resolved against the full `allWorktrees` set regardless of
    // the toggle's current position — a session found while the toggle
    // was on should still resolve correctly even if it's since been
    // switched off.
    const targetWorktree = resume
      ? (allWorktrees.find((w) => w.path === resume.worktreeRoot) ?? activeWorktree)
      : activeWorktree;
    if (!targetWorktree) return;
    const tab: Tab = {
      id: crypto.randomUUID(),
      type: "agent",
      title: resume?.title ?? AGENT_DISPLAY_NAME[kind],
      agentKind: kind,
      worktreeId: targetWorktree.id,
      worktreeRoot: targetWorktree.path,
      resumeSessionId: resume?.sessionId,
    };
    openTab(tab);
    setOpen(false);
  }

  function startTerminalTab() {
    if (!activeWorktree) return;
    const tab: Tab = {
      id: crypto.randomUUID(),
      type: "terminal",
      title: `Terminal — ${activeWorktree.branch}`,
      worktreeRoot: activeWorktree.path,
    };
    openTab(tab);
    setOpen(false);
  }

  return (
    <DropdownMenu.Root open={open} onOpenChange={setOpen}>
      <DropdownMenu.Trigger asChild>
        <button type="button" className={styles.newTabTrigger} aria-label="New tab">
          <Plus size={16} />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content className={`${styles.menu} mo-glass`} align="start" sideOffset={6}>
          <div className={styles.sectionLabel}>Start an agent</div>
          {AGENT_OPTIONS.map((agent) => {
            const AgentIcon = agent.icon;
            const status = statusByKind[agent.kind];
            const ready = !!activeWorktree && isReady(status);
            const reason = !activeWorktree
              ? "Open a worktree first"
              : !status?.installed
                ? `${AGENT_DISPLAY_NAME[agent.kind]} isn't installed`
                : status?.authState !== "authenticated"
                  ? (status?.authDetail ?? "Needs authentication")
                  : undefined;

            const item = (
              <DropdownMenu.Item
                key={agent.kind}
                className={styles.agentItem}
                disabled={!ready}
                onSelect={(e) => {
                  if (!ready) {
                    e.preventDefault();
                    return;
                  }
                  startAgentTab(agent.kind);
                }}
              >
                <div
                  className={styles.agentIcon}
                  style={
                    agent.iconTone === "gradient"
                      ? { background: "linear-gradient(135deg,var(--accent),var(--purple))" }
                      : { background: "#0a0c11", border: "1px solid var(--border-2)" }
                  }
                >
                  <AgentIcon
                    size={16}
                    color={agent.iconTone === "gradient" ? "#0a0c11" : agent.color}
                  />
                </div>
                <div className={styles.agentText}>
                  <div className={styles.agentName}>{AGENT_DISPLAY_NAME[agent.kind]}</div>
                  <div className={styles.agentSubtitle}>{agent.subtitle}</div>
                </div>
                {!ready && reason ? (
                  <WarningCircle size={13} color="var(--text-mute)" />
                ) : (
                  <Kbd>{agent.shortcut}</Kbd>
                )}
              </DropdownMenu.Item>
            );

            return reason ? (
              <Tooltip key={agent.kind} label={reason}>
                {item}
              </Tooltip>
            ) : (
              item
            );
          })}

          {(resumeSessions.length > 0 || projectWorktrees.length > 0) && (
            <>
              <div className={styles.menuDivider} />
              <div className={styles.sectionLabel}>Resume session</div>
              {allWorktrees.length > projectWorktrees.length && (
                <DropdownMenu.CheckboxItem
                  className={styles.resumeItem}
                  checked={globalResume}
                  onSelect={(e) => e.preventDefault()}
                  onCheckedChange={setGlobalResume}
                >
                  <Globe size={16} color="var(--text-dim)" />
                  <span style={{ fontSize: "var(--text-sm)", flex: 1 }}>
                    Search all projects
                  </span>
                  <DropdownMenu.ItemIndicator>
                    <Check size={13} color="var(--accent)" />
                  </DropdownMenu.ItemIndicator>
                </DropdownMenu.CheckboxItem>
              )}
              {resumeSessions.length === 0 && (
                <div className={styles.resumeEmpty}>
                  No resumable sessions found {globalResume ? "" : "in this project"}.
                </div>
              )}
              {resumeSessions.slice(0, 6).map((session) => {
                const meta = metaForRoot(session.worktreeRoot);
                return (
                  <DropdownMenu.Item
                    key={`${session.kind}:${session.sessionId}`}
                    className={styles.resumeItem}
                    onSelect={() => startAgentTab(session.kind, session)}
                  >
                    <ClockCounterClockwise size={16} color="var(--text-dim)" />
                    <div className={styles.agentText}>
                      <div className={styles.resumeTitle}>{session.title}</div>
                      <div className={styles.resumeMeta}>
                        {AGENT_DISPLAY_NAME[session.kind]}
                        {meta?.branch && <> · {meta.branch}</>}
                        {globalResume && meta?.projectName && <> · {meta.projectName}</>}{" "}
                        · {relativeTime(session.lastActiveAt)} · {session.turnCount} turns
                      </div>
                    </div>
                  </DropdownMenu.Item>
                );
              })}
            </>
          )}

          <div className={styles.menuDivider} />
          <DropdownMenu.Item
            className={styles.terminalItem}
            disabled={!activeWorktree}
            onSelect={() => startTerminalTab()}
          >
            <TerminalWindow size={17} color="var(--green)" />
            <span style={{ fontSize: "var(--text-sm)" }}>New Terminal</span>
            <div style={{ marginLeft: "auto" }}>
              <Kbd>⌃`</Kbd>
            </div>
          </DropdownMenu.Item>

          <div className={styles.menuDivider} />
          <DropdownMenu.Item className={styles.terminalItem} onSelect={() => openSettings()}>
            <Sparkle size={15} color="var(--text-dim)" />
            <span style={{ fontSize: "var(--text-sm)" }}>Agents &amp; CLI settings…</span>
          </DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
