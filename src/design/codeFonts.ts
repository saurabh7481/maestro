/** The curated, self-hosted monospace fonts offered by both Settings →
 * Editor and Settings → Terminal (`styles/fonts.css`) — every one of these
 * is bundled with the app (not a "hope it's installed" system-font guess),
 * so picking any of them looks the same on Linux, macOS, and Windows. */
export const CODE_FONT_OPTIONS = [
  "JetBrains Mono",
  "Fira Code",
  "IBM Plex Mono",
  "Source Code Pro",
  "Space Mono",
  "Roboto Mono",
  "Inconsolata",
  "Cascadia Code",
] as const;

export type CodeFontFamily = (typeof CODE_FONT_OPTIONS)[number];

export const CODE_FONT_DEFAULT: CodeFontFamily = "JetBrains Mono";

/** Monaco and xterm.js both measure glyphs and set a canvas 2D context's
 * `font` property directly with this string, which — unlike a stylesheet —
 * never resolves CSS custom properties, so the fallback stack has to be
 * spelled out literally rather than reusing `var(--font-mono)`. The
 * fallback tail only matters if a future font is added here without also
 * being added to `styles/fonts.css`. */
export function buildCodeFontFamily(primary: string): string {
  return `'${primary}', ui-monospace, SFMono-Regular, Menlo, Consolas, monospace`;
}
