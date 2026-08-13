import { forwardRef } from "react";
import type { ButtonHTMLAttributes } from "react";
import type { Icon } from "@phosphor-icons/react";
import clsx from "clsx";
import styles from "./IconButton.module.css";
import { Tooltip } from "./Tooltip";

export interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  icon: Icon;
  label: string;
  size?: "sm" | "md" | "lg";
  iconSize?: number;
  active?: boolean;
  tone?: "default" | "danger";
  badge?: number | string;
  showLabel?: boolean;
}

const DEFAULT_ICON_SIZE: Record<NonNullable<IconButtonProps["size"]>, number> = {
  sm: 14,
  md: 16,
  lg: 20,
};

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(
  (
    {
      icon: IconComponent,
      label,
      size = "md",
      iconSize,
      active = false,
      tone = "default",
      badge,
      showLabel = false,
      className,
      ...rest
    },
    ref,
  ) => {
    const button = (
      <button
        ref={ref}
        type="button"
        aria-label={label}
        data-active={active || undefined}
        data-tone={tone}
        className={clsx(styles.button, styles[size], className)}
        {...rest}
      >
        <IconComponent
          size={iconSize ?? DEFAULT_ICON_SIZE[size]}
          weight={active ? "fill" : "regular"}
        />
        {badge != null && <span className={styles.badge}>{badge}</span>}
      </button>
    );

    if (showLabel) return button;
    return <Tooltip label={label}>{button}</Tooltip>;
  },
);
IconButton.displayName = "IconButton";
