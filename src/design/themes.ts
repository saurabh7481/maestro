export type ThemeId = "maestro" | "darkplus" | "onedark" | "oled";

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
  oled: "OLED Black",
};

// Ported verbatim from docs/design/Maestro IDE.dc.html's `themes` object —
// this file is the color-token source of truth, not a redesign. `text`/
// `text-dim`/`text-mute` were bumped brighter across every theme (and
// `oled` added) in response to user feedback that both text and
// icon-via-`currentColor` legibility read as too low-contrast overall.
export const themes: Record<ThemeId, ThemeTokens> = {
  maestro: {
    "--bg": "#0d1016",
    "--bg-2": "#12151c",
    "--bg-3": "#1a1f28",
    "--titlebar": "#0a0c11",
    "--border": "rgba(255,255,255,.07)",
    "--border-2": "rgba(255,255,255,.12)",
    "--text": "#e7ebf2",
    "--text-dim": "#aab4c6",
    "--text-mute": "#7d8898",
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
    "--text": "#e4e4e4",
    "--text-dim": "#b8b8b8",
    "--text-mute": "#8c8c8c",
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
    "--text": "#c2c8d4",
    "--text-dim": "#9aa1ae",
    "--text-mute": "#7d8492",
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
  // True/near black backgrounds for OLED power savings + max perceived
  // contrast, with brighter text and slightly more saturated accents than
  // the other themes so nothing washes out against pure black.
  oled: {
    "--bg": "#000000",
    "--bg-2": "#000000",
    "--bg-3": "#0e0e10",
    "--titlebar": "#000000",
    "--border": "rgba(255,255,255,.09)",
    "--border-2": "rgba(255,255,255,.16)",
    "--text": "#ffffff",
    "--text-dim": "#c7cddb",
    "--text-mute": "#98a1b3",
    "--accent": "#8f9dff",
    "--accent-2": "#5ec2ff",
    "--accent-soft": "rgba(143,157,255,.18)",
    "--hover": "rgba(255,255,255,.07)",
    "--active": "rgba(143,157,255,.22)",
    "--green": "#6bffa0",
    "--red": "#ff6b6b",
    "--yellow": "#ffd166",
    "--purple": "#d68fff",
    "--orange": "#ffab5e",
    "--blue": "#6ab8ff",
    "--cyan": "#5ff0e0",
    "--sel": "rgba(143,157,255,.32)",
  },
};

export function applyTheme(root: HTMLElement, id: ThemeId): void {
  const tokens = themes[id];
  for (const [key, value] of Object.entries(tokens)) {
    root.style.setProperty(key, value);
  }
}
