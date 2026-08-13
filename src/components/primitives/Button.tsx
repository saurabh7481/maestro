import { forwardRef } from "react";
import type { ButtonHTMLAttributes } from "react";
import clsx from "clsx";
import styles from "./Button.module.css";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: "primary" | "secondary" | "ghost";
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ variant = "secondary", className, ...rest }, ref) => (
    <button
      ref={ref}
      type="button"
      className={clsx(styles.button, styles[variant], className)}
      {...rest}
    />
  ),
);
Button.displayName = "Button";
