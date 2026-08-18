import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { Plus, Pulse, Sparkle, TerminalWindow, WarningCircle } from "@phosphor-icons/react";
import { useUiStore } from "../../state/uiStore";
import { useTabsStore } from "../../state/tabsStore";
import type { Tab } from "../../state/tabsStore";
import { useActiveWorktree } from "../../state/workspaceStore";
import { useKeybindingsStore } from "../../state/keybindingsStore";
import { formatCombo } from "../../design/keymap";
import { useAgentAvailabilityStore } from "../../state/agentAvailabilityStore";
import { AGENT_DISPLAY_NAME, isReady } from "../../types/agent";
import type { AgentKind } from "../../types/agent";
import { AgentBrandIcon } from "../agent/AgentBrandIcon";
import { openProcessesTab } from "../processes/openProcessesTab";
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
  {
    kind: "aider",
    iconTone: "outline",
    color: "var(--yellow, var(--accent-2))",
    // Aider is the only wrapped CLI with no model of its own — which
    // provider it talks to is the user's choice, so the subtitle names the
    // arrangement rather than a vendor.
    subtitle: "bring your own model",
    shortcut: "⌘4",
  },
];

/** The `+` at the end of a pane's tab strip. Takes the pane it belongs to
 * so a new tab opens *there* rather than in whichever pane happened to
 * have focus, and so two panes' menus can't be open at once. */
export function NewTabMenu({ paneId }: { paneId: string }) {
  const openPaneId = useUiStore((s) => s.newTabMenuPaneId);
  const setOpenPaneId = useUiStore((s) => s.setNewTabMenuOpen);
  const open = openPaneId === paneId;
  const setOpen = (next: boolean) => setOpenPaneId(next ? paneId : null);
  const openTabInPane = useTabsStore((s) => s.openTabInPane);
  const activeWorktree = useActiveWorktree();
  const statusByKind = useAgentAvailabilityStore((s) => s.statusByKind);
  const openSettings = useUiStore((s) => s.openSettings);
  const terminalCombo = useKeybindingsStore((s) => s.comboFor("terminal.new"));

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
    openTabInPane(tab, paneId);
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
    openTabInPane(tab, paneId);
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
              <Kbd>{formatCombo(terminalCombo)}</Kbd>
            </div>
          </DropdownMenu.Item>

          <DropdownMenu.Item
            className={styles.terminalItem}
            onSelect={() => {
              openProcessesTab();
              setOpen(false);
            }}
          >
            <Pulse size={17} color="var(--purple)" />
            <span style={{ fontSize: "var(--text-sm)" }}>Process Manager</span>
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
