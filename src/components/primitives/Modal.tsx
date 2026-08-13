import type { CSSProperties, ReactNode } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import styles from "./Modal.module.css";

export interface ModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  width?: string;
  height?: string;
  children: ReactNode;
}

export function Modal({
  open,
  onOpenChange,
  title,
  description,
  width,
  height,
  children,
}: ModalProps) {
  const style = {
    "--modal-width": width,
    "--modal-height": height,
  } as CSSProperties;

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className={styles.overlay}>
          <Dialog.Content className={styles.content} style={style} aria-describedby={undefined}>
            <Dialog.Title className="mo-visually-hidden">{title}</Dialog.Title>
            {description && (
              <Dialog.Description className="mo-visually-hidden">{description}</Dialog.Description>
            )}
            {children}
          </Dialog.Content>
        </Dialog.Overlay>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
