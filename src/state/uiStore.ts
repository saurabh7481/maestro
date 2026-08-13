import { create } from "zustand";
import type { ThemeId } from "../design/themes";
import { ZOOM_DEFAULT } from "../design/zoom";

export type SidebarView = "explorer" | "scm" | "history" | "search";

interface UiState {
  theme: ThemeId;
  zoom: number;
  leftSidebarOpen: boolean;
  rightSidebarOpen: boolean;
  sidebarView: SidebarView;
  settingsOpen: boolean;
  commandPaletteOpen: boolean;
  newTabMenuOpen: boolean;

  setTheme: (theme: ThemeId) => void;
  setZoom: (zoom: number) => void;
  toggleLeftSidebar: () => void;
  toggleRightSidebar: () => void;
  setSidebarView: (view: SidebarView) => void;
  openSettings: () => void;
  closeSettings: () => void;
  setCommandPaletteOpen: (open: boolean) => void;
  setNewTabMenuOpen: (open: boolean) => void;
  hydrate: (partial: Partial<Pick<UiState, "theme" | "zoom">>) => void;
}

export const useUiStore = create<UiState>((set) => ({
  theme: "maestro",
  zoom: ZOOM_DEFAULT,
  leftSidebarOpen: true,
  rightSidebarOpen: true,
  sidebarView: "explorer",
  settingsOpen: false,
  commandPaletteOpen: false,
  newTabMenuOpen: false,

  setTheme: (theme) => set({ theme }),
  setZoom: (zoom) => set({ zoom }),
  toggleLeftSidebar: () => set((s) => ({ leftSidebarOpen: !s.leftSidebarOpen })),
  toggleRightSidebar: () => set((s) => ({ rightSidebarOpen: !s.rightSidebarOpen })),
  setSidebarView: (sidebarView) => set({ sidebarView, settingsOpen: false }),
  openSettings: () => set({ settingsOpen: true, newTabMenuOpen: false, commandPaletteOpen: false }),
  closeSettings: () => set({ settingsOpen: false }),
  setCommandPaletteOpen: (open) => set({ commandPaletteOpen: open, newTabMenuOpen: false }),
  setNewTabMenuOpen: (open) => set({ newTabMenuOpen: open }),
  hydrate: (partial) => set(partial),
}));
