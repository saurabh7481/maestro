import { create } from "zustand";
import type { ThemeId } from "../design/themes";
import { ZOOM_DEFAULT } from "../design/zoom";

export type SidebarView = "explorer" | "scm" | "history" | "search" | "problems";

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
  /** Which pane's `+` menu is open, if any. A pane id rather than a
   * boolean because every pane has its own tab strip (and its own `+`)
   * once the editor can be split — one shared flag opened all of them at
   * once. */
  newTabMenuPaneId: string | null;
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
  toggleSidebarView: (view: SidebarView) => void;
  openSettings: () => void;
  closeSettings: () => void;
  setCommandPaletteOpen: (open: boolean) => void;
  openQuickOpen: () => void;
  setNewTabMenuOpen: (paneId: string | null) => void;
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
  newTabMenuPaneId: null,
  autoSaveEnabled: false,

  setTheme: (theme) => set({ theme }),
  setZoom: (zoom) => set({ zoom }),
  toggleLeftSidebar: () => set((s) => ({ leftSidebarOpen: !s.leftSidebarOpen })),
  toggleRightSidebar: () => set((s) => ({ rightSidebarOpen: !s.rightSidebarOpen })),
  setLeftSidebarWidth: (leftSidebarWidth) => set({ leftSidebarWidth }),
  setRightSidebarWidth: (rightSidebarWidth) => set({ rightSidebarWidth }),
  // "Show Source Control" has to actually show it: switching the view
  // while the panel is collapsed used to change what would render behind
  // a panel that stayed hidden, so the command appeared to do nothing.
  setSidebarView: (sidebarView) =>
    set({ sidebarView, rightSidebarOpen: true, settingsOpen: false }),
  // The activity rail's own semantics, VS Code style: a different icon
  // reveals that view, the icon already showing collapses the panel. Only
  // the top toggle used to do anything when the panel was open, so every
  // other icon was a dead click once you were already on its view.
  toggleSidebarView: (view) =>
    set((s) => ({
      sidebarView: view,
      rightSidebarOpen: s.sidebarView === view ? !s.rightSidebarOpen : true,
      settingsOpen: false,
    })),
  openSettings: () =>
    set({ settingsOpen: true, newTabMenuPaneId: null, commandPaletteOpen: false }),
  closeSettings: () => set({ settingsOpen: false }),
  setCommandPaletteOpen: (open) =>
    set({ commandPaletteOpen: open, newTabMenuPaneId: null, quickOpenMode: false }),
  openQuickOpen: () =>
    set({ commandPaletteOpen: true, newTabMenuPaneId: null, quickOpenMode: true }),
  setNewTabMenuOpen: (newTabMenuPaneId) => set({ newTabMenuPaneId }),
  setAutoSaveEnabled: (autoSaveEnabled) => set({ autoSaveEnabled }),
  hydrate: (partial) => set(partial),
}));
