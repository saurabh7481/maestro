import type { ReactNode } from "react";
import * as ContextMenu from "@radix-ui/react-context-menu";
import { ArrowCounterClockwise, Copy, Minus, Plus } from "@phosphor-icons/react";
import styles from "./ScmContextMenu.module.css";

export interface ScmContextMenuProps {
  children: ReactNode;
  path: string;
  onStage?: () => void;
  onUnstage?: () => void;
  onDiscard?: () => void;
}

/** Right-click menu for a row in the Source Control panel (Changes/Staged
 * lists) — VS Code's SCM context menu is the reference. Without this,
 * right-clicking a change fell through to the WebView's native context
 * menu instead of Stage/Unstage/Discard. */
export function ScmContextMenu({
  children,
  path,
  onStage,
  onUnstage,
  onDiscard,
}: ScmContextMenuProps) {
  return (
    <ContextMenu.Root>
      <ContextMenu.Trigger asChild>{children}</ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Content className={`${styles.menu} mo-glass`}>
          {onStage && (
            <ContextMenu.Item className={styles.item} onSelect={onStage}>
              <Plus size={15} />
              Stage Changes
            </ContextMenu.Item>
          )}
          {onUnstage && (
            <ContextMenu.Item className={styles.item} onSelect={onUnstage}>
              <Minus size={15} />
              Unstage Changes
            </ContextMenu.Item>
          )}
          <ContextMenu.Item
            className={styles.item}
            onSelect={() => void navigator.clipboard.writeText(path)}
          >
            <Copy size={15} />
            Copy Path
          </ContextMenu.Item>
          {onDiscard && (
            <>
              <div className={styles.divider} />
              <ContextMenu.Item className={styles.item} data-danger onSelect={onDiscard}>
                <ArrowCounterClockwise size={15} />
                Discard Changes
              </ContextMenu.Item>
            </>
          )}
        </ContextMenu.Content>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  );
}
