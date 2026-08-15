import { create } from "zustand";
import type { ThemeId } from "../design/themes";
import { ZOOM_DEFAULT } from "../design/zoom";

export type SidebarView = "explorer" | "scm" | "history" | "search";

export const LEFT_SIDEBAR_WIDTH_DEFAULT = 16.625;
export const RIGHT_SIDEBAR_WIDTH_DEFAULT = 19;

interface UiState {
  theme: ThemeId;
  zoom: number;
  leftSidebarOpen: boolean;
  rightSidebarOpen: boolean;
  /** Committed widths, in rem — live drag updates go straight to the
   * `--left/right-sidebar-width` CSS vars (see `useResizablePanel.ts`)
   * and only land here once, on pointer-up. */
  leftSidebarWidth: number;
  rightSidebarWidth: number;
  sidebarView: SidebarView;
  settingsOpen: boolean;
  commandPaletteOpen: boolean;
  /** True when the command palette should search worktree file paths
   * (⌘P) instead of the static command list (⌘K) — see
   * `CommandPalette.tsx`. Reset to false whenever the palette opens via
   * the normal ⌘K/Titlebar-search path. */
  quickOpenMode: boolean;
  newTabMenuOpen: boolean;
  /** VS Code-style "save as you type" — when on, `MonacoHost` debounces a
   * write-to-disk after each edit instead of waiting for Cmd/Ctrl+S. See
   * Settings → General. */
  autoSaveEnabled: boolean;

  setTheme: (theme: ThemeId) => void;
  setZoom: (zoom: number) => void;
  toggleLeftSidebar: () => void;
  toggleRightSidebar: () => void;
  setLeftSidebarWidth: (widthRem: number) => void;
  setRightSidebarWidth: (widthRem: number) => void;
  setSidebarView: (view: SidebarView) => void;
  openSettings: () => void;
  closeSettings: () => void;
  setCommandPaletteOpen: (open: boolean) => void;
  openQuickOpen: () => void;
  setNewTabMenuOpen: (open: boolean) => void;
  setAutoSaveEnabled: (enabled: boolean) => void;
  hydrate: (
    partial: Partial<
      Pick<UiState, "theme" | "zoom" | "leftSidebarWidth" | "rightSidebarWidth" | "autoSaveEnabled">
    >,
  ) => void;
}

export const useUiStore = create<UiState>((set) => ({
  theme: "maestro",
  zoom: ZOOM_DEFAULT,
  leftSidebarOpen: true,
  rightSidebarOpen: true,
  leftSidebarWidth: LEFT_SIDEBAR_WIDTH_DEFAULT,
  rightSidebarWidth: RIGHT_SIDEBAR_WIDTH_DEFAULT,
  sidebarView: "explorer",
  settingsOpen: false,
  commandPaletteOpen: false,
  quickOpenMode: false,
  newTabMenuOpen: false,
  autoSaveEnabled: false,

  setTheme: (theme) => set({ theme }),
  setZoom: (zoom) => set({ zoom }),
  toggleLeftSidebar: () => set((s) => ({ leftSidebarOpen: !s.leftSidebarOpen })),
  toggleRightSidebar: () => set((s) => ({ rightSidebarOpen: !s.rightSidebarOpen })),
  setLeftSidebarWidth: (leftSidebarWidth) => set({ leftSidebarWidth }),
  setRightSidebarWidth: (rightSidebarWidth) => set({ rightSidebarWidth }),
  setSidebarView: (sidebarView) => set({ sidebarView, settingsOpen: false }),
  openSettings: () => set({ settingsOpen: true, newTabMenuOpen: false, commandPaletteOpen: false }),
  closeSettings: () => set({ settingsOpen: false }),
  setCommandPaletteOpen: (open) =>
    set({ commandPaletteOpen: open, newTabMenuOpen: false, quickOpenMode: false }),
  openQuickOpen: () =>
    set({ commandPaletteOpen: true, newTabMenuOpen: false, quickOpenMode: true }),
  setNewTabMenuOpen: (open) => set({ newTabMenuOpen: open }),
  setAutoSaveEnabled: (autoSaveEnabled) => set({ autoSaveEnabled }),
  hydrate: (partial) => set(partial),
}));
