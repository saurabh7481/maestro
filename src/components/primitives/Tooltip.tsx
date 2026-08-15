import type { ReactNode } from "react";
import * as RadixTooltip from "@radix-ui/react-tooltip";
import styles from "./Tooltip.module.css";

export interface TooltipProps {
  label: string;
  shortcut?: string;
  children: ReactNode;
  side?: "top" | "right" | "bottom" | "left";
}

export function Tooltip({ label, shortcut, children, side = "bottom" }: TooltipProps) {
  return (
    // `disableHoverableContent`: by default Radix treats the tooltip as
    // something the pointer might travel *into* (e.g. to click a link
    // inside it), so leaving the trigger doesn't close it directly —
    // it only arms a "grace area" polygon that's checked on the *next*
    // pointermove, and if the pointer comes to rest right after leaving
    // the trigger (no further movement), that next pointermove never
    // comes and the tooltip is stuck open indefinitely. None of
    // Maestro's tooltips have interactive content worth moving the
    // pointer into, so there's no reason to pay for that grace period —
    // this makes leaving the trigger close it immediately and
    // synchronously instead.
    <RadixTooltip.Root delayDuration={400} disableHoverableContent>
      <RadixTooltip.Trigger asChild>{children}</RadixTooltip.Trigger>
      <RadixTooltip.Portal>
        <RadixTooltip.Content className={styles.content} side={side} sideOffset={6}>
          {label}
          {shortcut && <span className={styles.shortcut}>{shortcut}</span>}
        </RadixTooltip.Content>
      </RadixTooltip.Portal>
    </RadixTooltip.Root>
  );
}

export function TooltipProvider({ children }: { children: ReactNode }) {
  return <RadixTooltip.Provider delayDuration={400}>{children}</RadixTooltip.Provider>;
}
