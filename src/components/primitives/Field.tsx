import { forwardRef } from "react";
import type {
  InputHTMLAttributes,
  ReactNode,
  SelectHTMLAttributes,
  TextareaHTMLAttributes,
} from "react";
import clsx from "clsx";
import styles from "./Field.module.css";

interface FieldShellProps {
  label?: string;
  hint?: string;
  error?: string;
  children: ReactNode;
}

function FieldShell({ label, hint, error, children }: FieldShellProps) {
  return (
    <label className={styles.label}>
      {label}
      {children}
      {error ? (
        <span className={styles.errorText}>{error}</span>
      ) : hint ? (
        <span className={styles.hint}>{hint}</span>
      ) : null}
    </label>
  );
}

export interface TextInputProps extends InputHTMLAttributes<HTMLInputElement> {
  label?: string;
  hint?: string;
  error?: string;
}

export const TextInput = forwardRef<HTMLInputElement, TextInputProps>(
  ({ label, hint, error, className, ...rest }, ref) => (
    <FieldShell label={label} hint={hint} error={error}>
      <input ref={ref} className={clsx(styles.control, className)} {...rest} />
    </FieldShell>
  ),
);
TextInput.displayName = "TextInput";

export interface TextAreaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  label?: string;
  hint?: string;
  error?: string;
}

export const TextArea = forwardRef<HTMLTextAreaElement, TextAreaProps>(
  ({ label, hint, error, className, ...rest }, ref) => (
    <FieldShell label={label} hint={hint} error={error}>
      <textarea ref={ref} className={clsx(styles.control, className)} {...rest} />
    </FieldShell>
  ),
);
TextArea.displayName = "TextArea";

export interface SelectProps extends SelectHTMLAttributes<HTMLSelectElement> {
  label?: string;
  hint?: string;
  error?: string;
}

export const Select = forwardRef<HTMLSelectElement, SelectProps>(
  ({ label, hint, error, className, children, ...rest }, ref) => (
    <FieldShell label={label} hint={hint} error={error}>
      <select ref={ref} className={clsx(styles.control, className)} {...rest}>
        {children}
      </select>
    </FieldShell>
  ),
);
Select.displayName = "Select";
