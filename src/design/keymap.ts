import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import { isMac } from "./platform";

/** A binding is stored as a normalized string: parts joined by "+", always
 * in `mod/ctrl/alt/shift` then-key order, key lowercased. "mod" means
 * Cmd on macOS / Ctrl elsewhere — the same abstraction every other
 * shortcut in this app already uses (`event.metaKey || event.ctrlKey`). */
export type KeyCombo = string;

export interface KeybindingAction {
  id: string;
  label: string;
  /** Which settings group this shows under. */
  group: "General" | "Editor" | "Navigation" | "View";
  defaultCombo: KeyCombo;
}

export const KEYBINDING_ACTIONS: KeybindingAction[] = [
  {
    id: "commandPalette.open",
    label: "Command Palette",
    group: "Navigation",
    defaultCombo: "mod+k",
  },
  {
    id: "commandPalette.openAlt",
    label: "Command Palette (alternate)",
    group: "Navigation",
    defaultCombo: "mod+shift+p",
  },
  { id: "quickOpen.open", label: "Go to File", group: "Navigation", defaultCombo: "mod+p" },
  { id: "file.save", label: "Save File", group: "Editor", defaultCombo: "mod+s" },
  { id: "terminal.new", label: "New Terminal", group: "General", defaultCombo: "mod+`" },
  { id: "zoom.in", label: "Zoom In", group: "View", defaultCombo: "mod+=" },
  { id: "zoom.out", label: "Zoom Out", group: "View", defaultCombo: "mod+-" },
  { id: "zoom.reset", label: "Reset Zoom", group: "View", defaultCombo: "mod+0" },
];

const MODIFIER_KEYS = new Set(["control", "meta", "shift", "alt"]);

/** A handful of keys where the physical key producing them depends on
 * whether Shift was needed to type them on the user's layout (e.g. US
 * QWERTY needs Shift for "+", the JIS/UK layouts don't) — browsers report
 * whichever character the layout actually produced in `event.key`, so a
 * combo recorded as `mod+=` must still match a `mod+shift+=` press that
 * came out as "+". Mirrors the special-case the old hardcoded zoom-in
 * handler carried before this module existed. */
const KEY_EQUIVALENTS: Record<string, string> = { "=": "+" };

function normalizeKey(key: string): string {
  return key.toLowerCase();
}

/** Builds the canonical combo string for a keydown event. Returns `null`
 * while only modifier keys are held (recording UIs should wait for the
 * next event rather than save a bare "mod"). */
export function comboFromEvent(event: KeyboardEvent | ReactKeyboardEvent): KeyCombo | null {
  const key = event.key;
  if (MODIFIER_KEYS.has(key.toLowerCase())) return null;
  const parts: string[] = [];
  if (event.metaKey || event.ctrlKey) parts.push("mod");
  if (event.altKey) parts.push("alt");
  if (event.shiftKey) parts.push("shift");
  parts.push(normalizeKey(key));
  return parts.join("+");
}

export function comboMatchesEvent(combo: KeyCombo, event: KeyboardEvent): boolean {
  const parts = combo.split("+");
  const key = parts[parts.length - 1];
  const wantMod = parts.includes("mod");
  const wantAlt = parts.includes("alt");
  const wantShift = parts.includes("shift");

  const hasMod = event.metaKey || event.ctrlKey;
  if (wantMod !== hasMod) return false;
  if (wantAlt !== event.altKey) return false;

  const eventKey = normalizeKey(event.key);
  if (eventKey === key) {
    // Shift is only significant when the combo doesn't rely on it to
    // produce the character itself (see KEY_EQUIVALENTS below).
    if (!(key in KEY_EQUIVALENTS)) return wantShift === event.shiftKey;
    return true;
  }
  const equivalent = KEY_EQUIVALENTS[key];
  return equivalent !== undefined && eventKey === equivalent;
}

const KEY_DISPLAY: Record<string, string> = {
  mod: "⌘",
  alt: "⌥",
  shift: "⇧",
  arrowup: "↑",
  arrowdown: "↓",
  arrowleft: "←",
  arrowright: "→",
  enter: "⏎",
  escape: "Esc",
  " ": "Space",
};

const KEY_DISPLAY_WIN: Record<string, string> = {
  mod: "Ctrl",
  alt: "Alt",
  shift: "Shift",
};

/** Renders a combo for display, e.g. "mod+shift+p" → "⌘⇧P" on macOS or
 * "Ctrl+Shift+P" on Linux/Windows (platform conventions differ on
 * whether modifiers are joined or separated). */
export function formatCombo(combo: KeyCombo): string {
  const mac = isMac();
  const parts = combo.split("+");
  const rendered = parts.map((part) => {
    const table = mac ? KEY_DISPLAY : KEY_DISPLAY_WIN;
    if (table[part]) return table[part];
    return part.length === 1 ? part.toUpperCase() : part.charAt(0).toUpperCase() + part.slice(1);
  });
  return mac ? rendered.join("") : rendered.join("+");
}
