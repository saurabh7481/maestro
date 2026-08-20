import { CODE_FONT_DEFAULT } from "./codeFonts";

export const EDITOR_FONT_SIZE_MIN = 9;
export const EDITOR_FONT_SIZE_MAX = 24;
export const EDITOR_FONT_SIZE_DEFAULT = 13;

export const EDITOR_FONT_FAMILY_DEFAULT = CODE_FONT_DEFAULT;

/** Monaco's built-in "vs-dark" theme's own default — used as the starting
 * value so a user who never opens Settings → Editor sees exactly what they
 * always saw. `MonacoHost.tsx` defines a custom theme inheriting from
 * "vs-dark" with only `editor.background` overridden, rather than
 * hardcoding "vs-dark" itself, so this is live-editable without needing to
 * hand-maintain a full token-color theme. */
export const EDITOR_BACKGROUND_DEFAULT = "#1e1e1e";

export { CODE_FONT_OPTIONS, buildCodeFontFamily } from "./codeFonts";

export function clampEditorFontSize(value: number): number {
  return Math.min(EDITOR_FONT_SIZE_MAX, Math.max(EDITOR_FONT_SIZE_MIN, Math.round(value)));
}
