import * as Radix from "@radix-ui/react-switch";
import styles from "./Switch.module.css";

export interface SwitchProps {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  label: string;
  disabled?: boolean;
}

export function Switch({ checked, onCheckedChange, label, disabled }: SwitchProps) {
  return (
    <Radix.Root
      className={styles.root}
      checked={checked}
      onCheckedChange={onCheckedChange}
      aria-label={label}
      disabled={disabled}
    >
      <Radix.Thumb className={styles.thumb} />
    </Radix.Root>
  );
}
