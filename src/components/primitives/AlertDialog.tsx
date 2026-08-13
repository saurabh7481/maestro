import type { MouseEvent, ReactNode } from "react";
import { WarningCircle } from "@phosphor-icons/react";
import * as Radix from "@radix-ui/react-alert-dialog";
import { Button } from "./Button";
import styles from "./AlertDialog.module.css";

export interface AlertDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: ReactNode;
  confirmLabel: string;
  cancelLabel?: string;
  destructive?: boolean;
  /** Radix's Action button auto-dismisses on click by default. Always
   * receives the event pre-`preventDefault()`-ed here — the confirm action
   * may fail (e.g. a dirty-tree guard), and the caller decides whether to
   * close via `onOpenChange`, not Radix's implicit dismiss. */
  onConfirm: (event: MouseEvent<HTMLButtonElement>) => void;
  confirmDisabled?: boolean;
}

export function AlertDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel,
  cancelLabel = "Cancel",
  destructive = true,
  onConfirm,
  confirmDisabled = false,
}: AlertDialogProps) {
  return (
    <Radix.Root open={open} onOpenChange={onOpenChange}>
      <Radix.Portal>
        <Radix.Overlay className={styles.overlay}>
          <Radix.Content className={styles.content}>
            <Radix.Title className={styles.title}>
              {destructive && <WarningCircle size={20} color="var(--red)" />}
              {title}
            </Radix.Title>
            <Radix.Description className={styles.description}>{description}</Radix.Description>
            <div className={styles.actions}>
              <Radix.Cancel asChild>
                <Button variant="ghost">{cancelLabel}</Button>
              </Radix.Cancel>
              <Radix.Action asChild>
                <Button
                  variant={destructive ? "primary" : "secondary"}
                  style={destructive ? { background: "var(--red)", color: "#fff" } : undefined}
                  disabled={confirmDisabled}
                  onClick={(event) => {
                    event.preventDefault();
                    onConfirm(event);
                  }}
                >
                  {confirmLabel}
                </Button>
              </Radix.Action>
            </div>
          </Radix.Content>
        </Radix.Overlay>
      </Radix.Portal>
    </Radix.Root>
  );
}
