import { load, type Store } from "@tauri-apps/plugin-store";
import type { ThemeId } from "./themes";
import type { Pane, Tab } from "../state/tabsStore";
import type { LayoutNode } from "../state/paneLayout";
import type { SatelliteRecord } from "../state/satelliteStore";

export interface UiPrefs {
  theme: ThemeId;
  zoom: number;
  leftSidebarWidth: number;
  rightSidebarWidth: number;
  autoSaveEnabled: boolean;
  minimapEnabled: boolean;
  wordWrapEnabled: boolean;
  diffSideBySide: boolean;
  formatOnSaveEnabled: boolean;
  gitBlameEnabled: boolean;
}

const STORE_FILE = "ui-prefs.json";
const PREFS_KEY = "prefs";

let storePromise: Promise<Store> | null = null;

function getStore(): Promise<Store> {
  if (!storePromise) storePromise = load(STORE_FILE, { autoSave: true });
  return storePromise;
}

export async function loadUiPrefs(): Promise<Partial<UiPrefs>> {
  const store = await getStore();
  return (await store.get<Partial<UiPrefs>>(PREFS_KEY)) ?? {};
}

export async function saveUiPrefs(prefs: Partial<UiPrefs>): Promise<void> {
  const store = await getStore();
  const existing = (await store.get<Partial<UiPrefs>>(PREFS_KEY)) ?? {};
  await store.set(PREFS_KEY, { ...existing, ...prefs });
}

const KEYBINDINGS_STORE_FILE = "keybindings.json";
const KEYBINDINGS_KEY = "overrides";

let keybindingsStorePromise: Promise<Store> | null = null;

function getKeybindingsStore(): Promise<Store> {
  if (!keybindingsStorePromise) {
    keybindingsStorePromise = load(KEYBINDINGS_STORE_FILE, { autoSave: true });
  }
  return keybindingsStorePromise;
}

/** Maps action id → user-overridden combo. Actions without an entry here
 * use their `defaultCombo` from `design/keymap.ts`. */
export async function loadKeybindingOverrides(): Promise<Record<string, string>> {
  const store = await getKeybindingsStore();
  return (await store.get<Record<string, string>>(KEYBINDINGS_KEY)) ?? {};
}

export async function saveKeybindingOverrides(overrides: Record<string, string>): Promise<void> {
  const store = await getKeybindingsStore();
  await store.set(KEYBINDINGS_KEY, overrides);
}

export interface SessionPrefs {
  activeProjectId: string | null;
  activeWorktreeId: string | null;
  tabs: Tab[];
  /** Per-worktree "which tab was active" — see `state/tabsStore.ts`.
   * Keyed by worktree root path, same as the in-memory store. */
  activeTabIdByWorktree: Record<string, string | null>;
  /** Pane layout (docs/V2_ROADMAP.md Phase 13). Optional throughout:
   * a session file written before splits existed restores fine, with
   * every tab landing in one pane per worktree — `tabsStore.hydrate`
   * treats a missing layout the same as an unusable one. */
  panes?: Record<string, Pane>;
  layouts?: Record<string, LayoutNode>;
  activePaneByWorktree?: Record<string, string>;
  /** Detached windows and the tabs they held. Their tabs are *not* in
   * `tabs` — a satellite's tabs live in that window's own store — so
   * without this they'd be missing from the restored session entirely. */
  satellites?: SatelliteRecord[];
}

const SESSION_STORE_FILE = "session.json";
const SESSION_KEY = "session";

let sessionStorePromise: Promise<Store> | null = null;

function getSessionStore(): Promise<Store> {
  if (!sessionStorePromise) sessionStorePromise = load(SESSION_STORE_FILE, { autoSave: true });
  return sessionStorePromise;
}

/** See `design/useSessionPersistence.ts` for restore semantics — this is
 * just the raw disk read/write, same shape as `loadUiPrefs`/`saveUiPrefs`
 * above. */
export async function loadSessionPrefs(): Promise<SessionPrefs | null> {
  const store = await getSessionStore();
  return (await store.get<SessionPrefs>(SESSION_KEY)) ?? null;
}

export async function saveSessionPrefs(prefs: SessionPrefs): Promise<void> {
  const store = await getSessionStore();
  await store.set(SESSION_KEY, prefs);
}
