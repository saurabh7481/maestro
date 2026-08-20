import { create } from "zustand";
import type { ThemeId } from "../design/themes";
import { ZOOM_DEFAULT } from "../design/zoom";
import {
  TERMINAL_CURSOR_STYLE_DEFAULT,
  TERMINAL_FONT_FAMILY_DEFAULT,
  TERMINAL_FONT_SIZE_DEFAULT,
  TERMINAL_LINE_HEIGHT_DEFAULT,
  TERMINAL_SCROLLBACK_DEFAULT,
  type TerminalCursorStyle,
} from "../design/terminalPrefs";
import {
  EDITOR_BACKGROUND_DEFAULT,
  EDITOR_FONT_FAMILY_DEFAULT,
  EDITOR_FONT_SIZE_DEFAULT,
} from "../design/editorPrefs";

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
   * Settings → Editor. */
  autoSaveEnabled: boolean;
  /** Off by default — minimap painting is disproportionately expensive in
   * WebKitGTK (see `MonacoHost.tsx`), so this is opt-in rather than
   * on-by-default like upstream VS Code. See Settings → Editor. */
  minimapEnabled: boolean;
  /** On by default, matching the prior hardcoded behavior for anything
   * under the large-file threshold — `MonacoHost.tsx` still forces this
   * off for large files regardless, same as it forces minimap off. See
   * Settings → Editor. */
  wordWrapEnabled: boolean;
  /** How `MonacoDiffHost` lays out a diff — two columns (default,
   * matching VS Code) or one inline column with +/− lines interleaved.
   * A per-tab override wouldn't survive switching tabs, so this is a
   * single app-wide preference like `minimapEnabled`, not per-DiffView
   * state. See the toggle button in `DiffView.tsx`'s header. */
  diffSideBySide: boolean;
  /** Off by default — silently rewriting a file's formatting on every
   * save is the kind of surprise that erodes trust in autosave, so this
   * is opt-in even though the formatter itself (LSP if available, else
   * the bundled Prettier fallback — see `editor/formatOnSave.ts`) is
   * always registered and available on demand via the command palette.
   * See Settings → Editor. */
  formatOnSaveEnabled: boolean;
  /** On by default — purely informational (who/when last touched the
   * cursor's current line, rendered as dimmed end-of-line text), so
   * there's no correctness risk in defaulting it on the way there is for
   * `formatOnSaveEnabled`. See Settings → Editor. */
  gitBlameEnabled: boolean;
  /** Monaco appearance — Settings → Editor. `zoom` still scales this
   * multiplicatively on top (`MonacoHost.tsx`), matching how it already
   * scaled the previously-hardcoded base size. */
  editorFontSize: number;
  editorFontFamily: string;
  /** Hex color for `editor.background` on the custom theme `MonacoHost.tsx`
   * defines (inherits from Monaco's built-in "vs-dark" otherwise
   * unchanged) — not a full theme editor, just the one thing asked for. */
  editorBackgroundColor: string;
  /** Terminal appearance/behavior — Settings → Terminal. Applied to every
   * open `TerminalTab` live (xterm.js's `term.options` accepts updates
   * after construction), not just to terminals opened afterward. */
  terminalFontSize: number;
  terminalFontFamily: string;
  terminalLineHeight: number;
  terminalCursorStyle: TerminalCursorStyle;
  terminalCursorBlink: boolean;
  terminalScrollback: number;

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
  setMinimapEnabled: (enabled: boolean) => void;
  setWordWrapEnabled: (enabled: boolean) => void;
  setDiffSideBySide: (enabled: boolean) => void;
  setFormatOnSaveEnabled: (enabled: boolean) => void;
  setGitBlameEnabled: (enabled: boolean) => void;
  setEditorFontSize: (size: number) => void;
  setEditorFontFamily: (family: string) => void;
  setEditorBackgroundColor: (color: string) => void;
  setTerminalFontSize: (size: number) => void;
  setTerminalFontFamily: (family: string) => void;
  setTerminalLineHeight: (lineHeight: number) => void;
  setTerminalCursorStyle: (style: TerminalCursorStyle) => void;
  setTerminalCursorBlink: (enabled: boolean) => void;
  setTerminalScrollback: (lines: number) => void;
  hydrate: (
    partial: Partial<
      Pick<
        UiState,
        | "theme"
        | "zoom"
        | "leftSidebarWidth"
        | "rightSidebarWidth"
        | "autoSaveEnabled"
        | "minimapEnabled"
        | "wordWrapEnabled"
        | "diffSideBySide"
        | "formatOnSaveEnabled"
        | "gitBlameEnabled"
        | "editorFontSize"
        | "editorFontFamily"
        | "editorBackgroundColor"
        | "terminalFontSize"
        | "terminalFontFamily"
        | "terminalLineHeight"
        | "terminalCursorStyle"
        | "terminalCursorBlink"
        | "terminalScrollback"
      >
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
  minimapEnabled: false,
  wordWrapEnabled: true,
  diffSideBySide: true,
  formatOnSaveEnabled: false,
  gitBlameEnabled: true,
  editorFontSize: EDITOR_FONT_SIZE_DEFAULT,
  editorFontFamily: EDITOR_FONT_FAMILY_DEFAULT,
  editorBackgroundColor: EDITOR_BACKGROUND_DEFAULT,
  terminalFontSize: TERMINAL_FONT_SIZE_DEFAULT,
  terminalFontFamily: TERMINAL_FONT_FAMILY_DEFAULT,
  terminalLineHeight: TERMINAL_LINE_HEIGHT_DEFAULT,
  terminalCursorStyle: TERMINAL_CURSOR_STYLE_DEFAULT,
  terminalCursorBlink: true,
  terminalScrollback: TERMINAL_SCROLLBACK_DEFAULT,

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
  setMinimapEnabled: (minimapEnabled) => set({ minimapEnabled }),
  setWordWrapEnabled: (wordWrapEnabled) => set({ wordWrapEnabled }),
  setDiffSideBySide: (diffSideBySide) => set({ diffSideBySide }),
  setFormatOnSaveEnabled: (formatOnSaveEnabled) => set({ formatOnSaveEnabled }),
  setGitBlameEnabled: (gitBlameEnabled) => set({ gitBlameEnabled }),
  setEditorFontSize: (editorFontSize) => set({ editorFontSize }),
  setEditorFontFamily: (editorFontFamily) => set({ editorFontFamily }),
  setEditorBackgroundColor: (editorBackgroundColor) => set({ editorBackgroundColor }),
  setTerminalFontSize: (terminalFontSize) => set({ terminalFontSize }),
  setTerminalFontFamily: (terminalFontFamily) => set({ terminalFontFamily }),
  setTerminalLineHeight: (terminalLineHeight) => set({ terminalLineHeight }),
  setTerminalCursorStyle: (terminalCursorStyle) => set({ terminalCursorStyle }),
  setTerminalCursorBlink: (terminalCursorBlink) => set({ terminalCursorBlink }),
  setTerminalScrollback: (terminalScrollback) => set({ terminalScrollback }),
  hydrate: (partial) => set(partial),
}));
