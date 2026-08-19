import { CODE_FONT_DEFAULT } from "./codeFonts";

export const TERMINAL_FONT_SIZE_MIN = 9;
export const TERMINAL_FONT_SIZE_MAX = 24;
export const TERMINAL_FONT_SIZE_DEFAULT = 13;

export const TERMINAL_LINE_HEIGHT_MIN = 1;
export const TERMINAL_LINE_HEIGHT_MAX = 2;
export const TERMINAL_LINE_HEIGHT_STEP = 0.05;
export const TERMINAL_LINE_HEIGHT_DEFAULT = 1.35;

/** xterm.js's own scrollback, in lines. Each retained line costs roughly
 * `columns × 4` bytes in its cell buffer, and terminals stay mounted for as
 * long as they're open (`TabHost.tsx`), so this is resident RAM per open
 * tab, not per visible one — the 20000 ceiling below is already ~15 MB/tab
 * at a typical width; there's no reason to let it go higher. The 2000
 * default is well past what anyone scrolls back through by hand. See
 * docs/PERFORMANCE_AUDIT.md §1.1. */
export const TERMINAL_SCROLLBACK_MIN = 500;
export const TERMINAL_SCROLLBACK_MAX = 20000;
export const TERMINAL_SCROLLBACK_STEP = 500;
export const TERMINAL_SCROLLBACK_DEFAULT = 2000;

export const TERMINAL_FONT_FAMILY_DEFAULT = CODE_FONT_DEFAULT;
export type TerminalCursorStyle = "block" | "underline" | "bar";
export const TERMINAL_CURSOR_STYLE_DEFAULT: TerminalCursorStyle = "block";

export const TERMINAL_CURSOR_STYLE_OPTIONS: { value: TerminalCursorStyle; label: string }[] = [
  { value: "block", label: "Block" },
  { value: "underline", label: "Underline" },
  { value: "bar", label: "Bar" },
];

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function clampTerminalFontSize(value: number): number {
  return clamp(Math.round(value), TERMINAL_FONT_SIZE_MIN, TERMINAL_FONT_SIZE_MAX);
}

export function clampTerminalLineHeight(value: number): number {
  const stepped = Math.round(value * 100) / 100;
  return clamp(stepped, TERMINAL_LINE_HEIGHT_MIN, TERMINAL_LINE_HEIGHT_MAX);
}

export function clampTerminalScrollback(value: number): number {
  return clamp(Math.round(value), TERMINAL_SCROLLBACK_MIN, TERMINAL_SCROLLBACK_MAX);
}

export { buildCodeFontFamily as buildTerminalFontFamily, CODE_FONT_OPTIONS } from "./codeFonts";
