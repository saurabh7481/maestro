import {
  Code,
  FileText,
  FileTs,
  GitDiff,
  Pulse,
  Sparkle,
  TerminalWindow,
} from "@phosphor-icons/react";
import type { Icon } from "@phosphor-icons/react";
import type { TabType } from "../state/tabsStore";

export const TAB_VISUALS: Record<TabType, { icon: Icon; color: string }> = {
  agent: { icon: Sparkle, color: "var(--accent)" },
  file: { icon: FileTs, color: "var(--blue)" },
  markdown: { icon: FileText, color: "var(--accent-2)" },
  html: { icon: Code, color: "var(--yellow)" },
  diff: { icon: GitDiff, color: "var(--orange)" },
  review: { icon: GitDiff, color: "var(--orange)" },
  merge: { icon: GitDiff, color: "var(--red)" },
  terminal: { icon: TerminalWindow, color: "var(--green)" },
  processes: { icon: Pulse, color: "var(--purple)" },
};
