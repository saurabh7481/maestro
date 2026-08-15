import type { ReactNode } from "react";
import * as ContextMenu from "@radix-ui/react-context-menu";
import { ArrowLineRight, Copy, X, XCircle, XSquare } from "@phosphor-icons/react";
import type { Icon } from "@phosphor-icons/react";
import styles from "./TabContextMenu.module.css";

/** Layout actions (split, move to another window) contributed by the tab
 * strip — kept as data passed in rather than wired directly here so this
 * component stays a menu and the pane operations stay in the pane code
 * that owns them (docs/V2_ROADMAP.md Phase 13). */
export interface TabContextMenuItem {
  label: string;
  icon: Icon;
  disabled?: boolean;
  onSelect: () => void;
}

export interface TabContextMenuProps {
  children: ReactNode;
  filePath?: string;
  extraItems?: TabContextMenuItem[];
  onClose: () => void;
  onCloseOthers: () => void;
  onCloseToRight: () => void;
  onCloseSaved: () => void;
  onCloseAll: () => void;
  hasOthers: boolean;
  hasToRight: boolean;
  hasSaved: boolean;
}

/** Right-click menu for a tab strip entry — VS Code's tab context menu is
 * the reference (`Close`, `Close Others`, `Close to the Right`, `Close
 * Saved`, `Close All`), which is also where the app-wide "close all tabs"
 * affordance lives (there's no separate toolbar button for it, matching
 * VS Code). Without this, right-clicking a tab fell through to the
 * WebView's native context menu instead of anything Maestro-specific. */
export function TabContextMenu({
  children,
  filePath,
  extraItems,
  onClose,
  onCloseOthers,
  onCloseToRight,
  onCloseSaved,
  onCloseAll,
  hasOthers,
  hasToRight,
  hasSaved,
}: TabContextMenuProps) {
  return (
    <ContextMenu.Root>
      <ContextMenu.Trigger asChild>{children}</ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Content className={`${styles.menu} mo-glass`}>
          <ContextMenu.Item className={styles.item} onSelect={onClose}>
            <X size={15} />
            Close
          </ContextMenu.Item>
          <ContextMenu.Item className={styles.item} disabled={!hasOthers} onSelect={onCloseOthers}>
            <XCircle size={15} />
            Close Others
          </ContextMenu.Item>
          <ContextMenu.Item
            className={styles.item}
            disabled={!hasToRight}
            onSelect={onCloseToRight}
          >
            <ArrowLineRight size={15} />
            Close to the Right
          </ContextMenu.Item>
          {filePath && (
            <ContextMenu.Item
              className={styles.item}
              onSelect={() => void navigator.clipboard.writeText(filePath)}
            >
              <Copy size={15} />
              Copy Path
            </ContextMenu.Item>
          )}
          {extraItems && extraItems.length > 0 && (
            <>
              <div className={styles.divider} />
              {extraItems.map((item) => (
                <ContextMenu.Item
                  key={item.label}
                  className={styles.item}
                  disabled={item.disabled}
                  onSelect={item.onSelect}
                >
                  <item.icon size={15} />
                  {item.label}
                </ContextMenu.Item>
              ))}
            </>
          )}
          <div className={styles.divider} />
          <ContextMenu.Item className={styles.item} disabled={!hasSaved} onSelect={onCloseSaved}>
            <XSquare size={15} />
            Close Saved
          </ContextMenu.Item>
          <ContextMenu.Item className={styles.item} data-danger onSelect={onCloseAll}>
            <XSquare size={15} />
            Close All
          </ContextMenu.Item>
        </ContextMenu.Content>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  );
}
