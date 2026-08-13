import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import {
  ClockCounterClockwise,
  Cursor,
  Hexagon,
  Plus,
  Sparkle,
  TerminalWindow,
} from "@phosphor-icons/react";
import type { Icon } from "@phosphor-icons/react";
import { useUiStore } from "../../state/uiStore";
import { useTabsStore } from "../../state/tabsStore";
import type { Tab, TabType } from "../../state/tabsStore";
import { Kbd } from "../primitives";
import styles from "./TabStrip.module.css";

interface AgentOption {
  type: TabType;
  title: string;
  subtitle: string;
  icon: Icon;
  iconTone: "gradient" | "outline";
  color: string;
  shortcut: string;
}

const AGENT_OPTIONS: AgentOption[] = [
  {
    type: "agent",
    title: "Claude Code",
    subtitle: "anthropic · claude",
    icon: Sparkle,
    iconTone: "gradient",
    color: "#0a0c11",
    shortcut: "⌘1",
  },
  {
    type: "agent",
    title: "Codex CLI",
    subtitle: "openai · codex",
    icon: Hexagon,
    iconTone: "outline",
    color: "var(--green)",
    shortcut: "⌘2",
  },
  {
    type: "agent",
    title: "Cursor Agent",
    subtitle: "cursor · agent",
    icon: Cursor,
    iconTone: "outline",
    color: "var(--accent-2)",
    shortcut: "⌘3",
  },
];

interface ResumeOption {
  title: string;
  meta: string;
}

const RESUME_OPTIONS: ResumeOption[] = [
  { title: "Refactor payments", meta: "claude · 2h ago · 34 turns" },
  { title: "Fix login crash", meta: "codex · yesterday · 12 turns" },
];

export function NewTabMenu() {
  const open = useUiStore((s) => s.newTabMenuOpen);
  const setOpen = useUiStore((s) => s.setNewTabMenuOpen);
  const openTab = useTabsStore((s) => s.openTab);

  function openMockTab(type: TabType, title: string) {
    const tab: Tab = { id: crypto.randomUUID(), type, title };
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
            return (
              <DropdownMenu.Item
                key={agent.title}
                className={styles.agentItem}
                onSelect={() => openMockTab(agent.type, agent.title)}
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
                  <div className={styles.agentName}>{agent.title}</div>
                  <div className={styles.agentSubtitle}>{agent.subtitle}</div>
                </div>
                <Kbd>{agent.shortcut}</Kbd>
              </DropdownMenu.Item>
            );
          })}

          <div className={styles.menuDivider} />
          <div className={styles.sectionLabel}>Resume session</div>
          {RESUME_OPTIONS.map((resume) => (
            <DropdownMenu.Item
              key={resume.title}
              className={styles.resumeItem}
              onSelect={() => openMockTab("agent", resume.title)}
            >
              <ClockCounterClockwise size={16} color="var(--text-dim)" />
              <div className={styles.agentText}>
                <div className={styles.resumeTitle}>{resume.title}</div>
                <div className={styles.resumeMeta}>{resume.meta}</div>
              </div>
            </DropdownMenu.Item>
          ))}

          <div className={styles.menuDivider} />
          <DropdownMenu.Item
            className={styles.terminalItem}
            onSelect={() => openMockTab("terminal", "New Terminal")}
          >
            <TerminalWindow size={17} color="var(--green)" />
            <span style={{ fontSize: "var(--text-sm)" }}>New Terminal</span>
            <div style={{ marginLeft: "auto" }}>
              <Kbd>⌃`</Kbd>
            </div>
          </DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
