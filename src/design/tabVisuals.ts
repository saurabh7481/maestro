import { FileText, FileTs, GitDiff, Sparkle, TerminalWindow } from "@phosphor-icons/react";
import type { Icon } from "@phosphor-icons/react";
import type { TabType } from "../state/tabsStore";

export const TAB_VISUALS: Record<TabType, { icon: Icon; color: string }> = {
  agent: { icon: Sparkle, color: "var(--accent)" },
  file: { icon: FileTs, color: "var(--blue)" },
  markdown: { icon: FileText, color: "var(--accent-2)" },
  diff: { icon: GitDiff, color: "var(--orange)" },
  terminal: { icon: TerminalWindow, color: "var(--green)" },
};
