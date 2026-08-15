import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { Plus, Sparkle, TerminalWindow, WarningCircle } from "@phosphor-icons/react";
import { useUiStore } from "../../state/uiStore";
import { useTabsStore } from "../../state/tabsStore";
import type { Tab } from "../../state/tabsStore";
import { useActiveWorktree } from "../../state/workspaceStore";
import { useAgentAvailabilityStore } from "../../state/agentAvailabilityStore";
import { AGENT_DISPLAY_NAME, isReady } from "../../types/agent";
import type { AgentKind } from "../../types/agent";
import { AgentBrandIcon } from "../agent/AgentBrandIcon";
import { Kbd, Tooltip } from "../primitives";
import styles from "./TabStrip.module.css";

interface AgentOption {
  kind: AgentKind;
  iconTone: "gradient" | "outline";
  color: string;
  subtitle: string;
  shortcut: string;
}

const AGENT_OPTIONS: AgentOption[] = [
  {
    kind: "claudeCode",
    iconTone: "gradient",
    color: "#0a0c11",
    subtitle: "anthropic · claude",
    shortcut: "⌘1",
  },
  {
    kind: "codex",
    iconTone: "outline",
    color: "var(--green)",
    subtitle: "openai · codex",
    shortcut: "⌘2",
  },
  {
    kind: "cursorAgent",
    iconTone: "outline",
    color: "var(--accent-2)",
    subtitle: "cursor · agent",
    shortcut: "⌘3",
  },
];

export function NewTabMenu() {
  const open = useUiStore((s) => s.newTabMenuOpen);
  const setOpen = useUiStore((s) => s.setNewTabMenuOpen);
  const openTab = useTabsStore((s) => s.openTab);
  const activeWorktree = useActiveWorktree();
  const statusByKind = useAgentAvailabilityStore((s) => s.statusByKind);
  const openSettings = useUiStore((s) => s.openSettings);

  function startAgentTab(kind: AgentKind) {
    if (!activeWorktree) return;
    const tab: Tab = {
      id: crypto.randomUUID(),
      type: "agent",
      title: AGENT_DISPLAY_NAME[kind],
      agentKind: kind,
      worktreeId: activeWorktree.id,
      worktreeRoot: activeWorktree.path,
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
                  <AgentBrandIcon
                    kind={agent.kind}
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
