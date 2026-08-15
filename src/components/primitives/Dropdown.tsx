import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { CaretDown, Check } from "@phosphor-icons/react";
import fieldStyles from "./Field.module.css";
import styles from "./Dropdown.module.css";

export interface DropdownOption {
  value: string;
  label: string;
}

export interface DropdownProps {
  label?: string;
  hint?: string;
  value: string;
  onChange: (value: string) => void;
  options: DropdownOption[];
  placeholder?: string;
  disabled?: boolean;
}

/** The design-system dropdown — Radix `DropdownMenu` styled to match every
 * other menu in the app (`mo-glass`, `--radius-lg`, the `scaleIn` entrance
 * from `motion.module.css`), for the common "pick one of a short list of
 * options" case `<select>` is usually reached for. Prefer this over a
 * native `<select>`/`Field.tsx`'s `Select` anywhere the picker should look
 * like it belongs to the app rather than the OS. */
export function Dropdown({
  label,
  hint,
  value,
  onChange,
  options,
  placeholder = "Select…",
  disabled,
}: DropdownProps) {
  const selected = options.find((o) => o.value === value);

  const trigger = (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild disabled={disabled}>
        <button type="button" className={styles.trigger} disabled={disabled}>
          <span className={styles.triggerLabel}>{selected?.label ?? placeholder}</span>
          <CaretDown size={12} color="var(--text-mute)" />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content className={`${styles.content} mo-glass`} align="start" sideOffset={4}>
          {options.map((option) => (
            <DropdownMenu.Item
              key={option.value}
              className={styles.item}
              data-active={option.value === value}
              onSelect={() => onChange(option.value)}
            >
              <span className={styles.itemLabel}>{option.label}</span>
              {option.value === value && <Check size={13} color="var(--accent)" />}
            </DropdownMenu.Item>
          ))}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );

  if (!label && !hint) return trigger;
  return (
    <div className={fieldStyles.label}>
      {label}
      {trigger}
      {hint && <span className={fieldStyles.hint}>{hint}</span>}
    </div>
  );
}
