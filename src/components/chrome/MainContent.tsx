import { Stack } from "@phosphor-icons/react";
import { useTabsStore } from "../../state/tabsStore";
import { TAB_VISUALS } from "../../design/tabVisuals";
import { TabStrip } from "./TabStrip";
import styles from "./MainContent.module.css";

const NOTE: Record<string, string> = {
  agent:
    "The live agent chat — tool cards, permission prompts, session resume — arrives with the agent CLI integration phase.",
  file: "The Monaco-powered file editor arrives with the file explorer phase.",
  markdown: "Source/Preview markdown rendering arrives with the file explorer phase.",
  diff: "The VS Code-style diff viewer arrives with the git integration phase.",
  terminal: "The real PTY-backed terminal arrives with the terminal phase.",
};

export function MainContent() {
  const tabs = useTabsStore((s) => s.tabs);
  const activeTabId = useTabsStore((s) => s.activeTabId);
  const activeTab = tabs.find((t) => t.id === activeTabId);

  return (
    <div className={styles.main}>
      <TabStrip />
      <div className={styles.content}>
        {activeTab ? (
          <div className={styles.placeholder}>
            <div className={styles.placeholderIcon}>
              {(() => {
                const Icon = TAB_VISUALS[activeTab.type].icon;
                return <Icon size={26} color={TAB_VISUALS[activeTab.type].color} />;
              })()}
            </div>
            <div className={styles.placeholderTitle}>{activeTab.title}</div>
            <div className={styles.placeholderNote}>{NOTE[activeTab.type]}</div>
          </div>
        ) : (
          <div className={styles.empty}>
            <Stack size={32} />
            <span>No tabs open — press the + button to start one.</span>
          </div>
        )}
      </div>
    </div>
  );
}
