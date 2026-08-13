import { X } from "@phosphor-icons/react";
import { useTabsStore } from "../../state/tabsStore";
import { useOpenFilesStore } from "../../state/openFilesStore";
import { useCloseConfirmStore } from "../../state/closeConfirmStore";
import { TAB_VISUALS } from "../../design/tabVisuals";
import { NewTabMenu } from "./NewTabMenu";
import styles from "./TabStrip.module.css";

export function TabStrip() {
  const tabs = useTabsStore((s) => s.tabs);
  const activeTabId = useTabsStore((s) => s.activeTabId);
  const setActiveTab = useTabsStore((s) => s.setActiveTab);
  const closeTab = useTabsStore((s) => s.closeTab);
  const dirtyByTabId = useOpenFilesStore((s) => s.byTabId);
  const requestClose = useCloseConfirmStore((s) => s.request);

  function handleClose(tabId: string) {
    if (dirtyByTabId[tabId]?.dirty) {
      requestClose([tabId], "close-tab");
    } else {
      closeTab(tabId);
    }
  }

  return (
    <div className={styles.strip}>
      <div className={styles.scroller}>
        {tabs.map((tab) => {
          const visual = TAB_VISUALS[tab.type];
          const TabIcon = visual.icon;
          const isActive = tab.id === activeTabId;
          const isDirty = dirtyByTabId[tab.id]?.dirty ?? false;
          return (
            <div
              key={tab.id}
              className={styles.tab}
              data-active={isActive}
              onClick={() => setActiveTab(tab.id)}
              role="tab"
              aria-selected={isActive}
              tabIndex={0}
            >
              <span className={styles.tabIndicator} />
              <TabIcon size={16} color={visual.color} />
              <span className={styles.tabTitle}>{tab.title}</span>
              {isDirty && <span className={styles.dirtyDot} aria-label="Unsaved changes" />}
              <button
                type="button"
                className={styles.tabClose}
                aria-label={`Close ${tab.title}`}
                onClick={(event) => {
                  event.stopPropagation();
                  handleClose(tab.id);
                }}
              >
                <X size={12} />
              </button>
            </div>
          );
        })}
        <NewTabMenu />
      </div>
    </div>
  );
}
