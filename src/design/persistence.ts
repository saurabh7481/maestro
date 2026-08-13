import { load, type Store } from "@tauri-apps/plugin-store";
import type { ThemeId } from "./themes";

export interface UiPrefs {
  theme: ThemeId;
  zoom: number;
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
