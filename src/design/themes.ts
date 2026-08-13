export type ThemeId = "maestro" | "darkplus" | "onedark";

export interface ThemeTokens {
  "--bg": string;
  "--bg-2": string;
  "--bg-3": string;
  "--titlebar": string;
  "--border": string;
  "--border-2": string;
  "--text": string;
  "--text-dim": string;
  "--text-mute": string;
  "--accent": string;
  "--accent-2": string;
  "--accent-soft": string;
  "--hover": string;
  "--active": string;
  "--green": string;
  "--red": string;
  "--yellow": string;
  "--purple": string;
  "--orange": string;
  "--blue": string;
  "--cyan": string;
  "--sel": string;
}

export const THEME_LABELS: Record<ThemeId, string> = {
  maestro: "Maestro Dark",
  darkplus: "VS Code Dark+",
  onedark: "One Dark Pro",
};

// Ported verbatim from docs/design/Maestro IDE.dc.html's `themes` object —
// this file is the color-token source of truth, not a redesign.
export const themes: Record<ThemeId, ThemeTokens> = {
  maestro: {
    "--bg": "#0d1016",
    "--bg-2": "#12151c",
    "--bg-3": "#1a1f28",
    "--titlebar": "#0a0c11",
    "--border": "rgba(255,255,255,.07)",
    "--border-2": "rgba(255,255,255,.12)",
    "--text": "#d5dae2",
    "--text-dim": "#8a94a6",
    "--text-mute": "#59616f",
    "--accent": "#7c8cff",
    "--accent-2": "#61afef",
    "--accent-soft": "rgba(124,140,255,.14)",
    "--hover": "rgba(255,255,255,.045)",
    "--active": "rgba(124,140,255,.16)",
    "--green": "#98c379",
    "--red": "#e06c75",
    "--yellow": "#e5c07b",
    "--purple": "#c678dd",
    "--orange": "#d19a66",
    "--blue": "#61afef",
    "--cyan": "#56b6c2",
    "--sel": "rgba(124,140,255,.25)",
  },
  darkplus: {
    "--bg": "#1e1e1e",
    "--bg-2": "#252526",
    "--bg-3": "#2d2d30",
    "--titlebar": "#323233",
    "--border": "rgba(255,255,255,.06)",
    "--border-2": "rgba(255,255,255,.1)",
    "--text": "#d4d4d4",
    "--text-dim": "#9d9d9d",
    "--text-mute": "#6b6b6b",
    "--accent": "#1a7fd4",
    "--accent-2": "#4daafc",
    "--accent-soft": "rgba(26,127,212,.22)",
    "--hover": "rgba(255,255,255,.05)",
    "--active": "rgba(26,127,212,.28)",
    "--green": "#6a9955",
    "--red": "#f14c4c",
    "--yellow": "#dcdcaa",
    "--purple": "#c586c0",
    "--orange": "#ce9178",
    "--blue": "#569cd6",
    "--cyan": "#4ec9b0",
    "--sel": "rgba(38,79,120,.7)",
  },
  onedark: {
    "--bg": "#282c34",
    "--bg-2": "#21252b",
    "--bg-3": "#2c313a",
    "--titlebar": "#21252b",
    "--border": "rgba(255,255,255,.06)",
    "--border-2": "rgba(255,255,255,.1)",
    "--text": "#abb2bf",
    "--text-dim": "#828997",
    "--text-mute": "#5c6370",
    "--accent": "#61afef",
    "--accent-2": "#56b6c2",
    "--accent-soft": "rgba(97,175,239,.16)",
    "--hover": "rgba(255,255,255,.045)",
    "--active": "rgba(97,175,239,.18)",
    "--green": "#98c379",
    "--red": "#e06c75",
    "--yellow": "#e5c07b",
    "--purple": "#c678dd",
    "--orange": "#d19a66",
    "--blue": "#61afef",
    "--cyan": "#56b6c2",
    "--sel": "rgba(97,175,239,.25)",
  },
};

export function applyTheme(root: HTMLElement, id: ThemeId): void {
  const tokens = themes[id];
  for (const [key, value] of Object.entries(tokens)) {
    root.style.setProperty(key, value);
  }
}
