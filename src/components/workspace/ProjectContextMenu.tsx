import type { ReactNode } from "react";
import * as ContextMenu from "@radix-ui/react-context-menu";
import { GearSix, PencilSimple, Trash } from "@phosphor-icons/react";
import styles from "../explorer/ExplorerContextMenu.module.css";

export interface ProjectContextMenuProps {
  children: ReactNode;
  onRename: () => void;
  onDelete: () => void;
  onSettings: () => void;
}

/** Right-click menu for a project row in the workspace sidebar. Reuses
 * `ExplorerContextMenu`'s stylesheet rather than duplicating it — same
 * menu chrome, different actions. */
export function ProjectContextMenu({
  children,
  onRename,
  onDelete,
  onSettings,
}: ProjectContextMenuProps) {
  return (
    <ContextMenu.Root>
      <ContextMenu.Trigger asChild>{children}</ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Content className={`${styles.menu} mo-glass`}>
          <ContextMenu.Item className={styles.item} onSelect={onSettings}>
            <GearSix size={15} />
            Settings…
          </ContextMenu.Item>
          <ContextMenu.Item className={styles.item} onSelect={onRename}>
            <PencilSimple size={15} />
            Rename (locally)
          </ContextMenu.Item>
          <div className={styles.divider} />
          <ContextMenu.Item className={styles.item} data-danger onSelect={onDelete}>
            <Trash size={15} />
            Delete
          </ContextMenu.Item>
        </ContextMenu.Content>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  );
}
