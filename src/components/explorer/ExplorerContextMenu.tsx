import type { ReactNode } from "react";
import * as ContextMenu from "@radix-ui/react-context-menu";
import { FilePlus, FolderOpen, FolderSimplePlus, PencilSimple, Trash } from "@phosphor-icons/react";
import { revealInOsLabel } from "../../design/platform";
import styles from "./ExplorerContextMenu.module.css";

export interface ExplorerContextMenuProps {
  children: ReactNode;
  isDir: boolean;
  onNewFile: () => void;
  onNewFolder: () => void;
  onRename: () => void;
  onDelete: () => void;
  onRevealInOs: () => void;
}

export function ExplorerContextMenu({
  children,
  isDir,
  onNewFile,
  onNewFolder,
  onRename,
  onDelete,
  onRevealInOs,
}: ExplorerContextMenuProps) {
  return (
    <ContextMenu.Root>
      <ContextMenu.Trigger asChild>{children}</ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Content className={`${styles.menu} mo-glass`}>
          {isDir && (
            <>
              <ContextMenu.Item className={styles.item} onSelect={onNewFile}>
                <FilePlus size={15} />
                New File
              </ContextMenu.Item>
              <ContextMenu.Item className={styles.item} onSelect={onNewFolder}>
                <FolderSimplePlus size={15} />
                New Folder
              </ContextMenu.Item>
              <div className={styles.divider} />
            </>
          )}
          <ContextMenu.Item className={styles.item} onSelect={onRename}>
            <PencilSimple size={15} />
            Rename
          </ContextMenu.Item>
          <ContextMenu.Item className={styles.item} onSelect={onRevealInOs}>
            <FolderOpen size={15} />
            {revealInOsLabel()}
          </ContextMenu.Item>
          <ContextMenu.Item className={styles.item} data-danger onSelect={onDelete}>
            <Trash size={15} />
            Delete
          </ContextMenu.Item>
        </ContextMenu.Content>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  );
}
