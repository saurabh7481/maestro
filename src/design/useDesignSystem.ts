import { useEffect, useRef } from "react";
import { useUiStore } from "../state/uiStore";
import { useKeybindingsStore } from "../state/keybindingsStore";
import { applyTheme } from "./themes";
import { clampZoom, ZOOM_DEFAULT, ZOOM_STEP } from "./zoom";
import { loadUiPrefs, saveUiPrefs } from "./persistence";
import { applyPlatformAttribute } from "./platform";
import { comboMatchesEvent } from "./keymap";

/** Wires the design system into the DOM: applies the platform attribute,
 * hydrates persisted theme/zoom, reflects store changes onto CSS custom
 * properties, persists changes back, and owns the zoom keyboard shortcuts.
 * Call once, at the app root. */
export function useDesignSystem(): void {
  const theme = useUiStore((s) => s.theme);
  const zoom = useUiStore((s) => s.zoom);
  const setZoom = useUiStore((s) => s.setZoom);
  const leftSidebarWidth = useUiStore((s) => s.leftSidebarWidth);
  const rightSidebarWidth = useUiStore((s) => s.rightSidebarWidth);
  const autoSaveEnabled = useUiStore((s) => s.autoSaveEnabled);
  const minimapEnabled = useUiStore((s) => s.minimapEnabled);
  const wordWrapEnabled = useUiStore((s) => s.wordWrapEnabled);
  const diffSideBySide = useUiStore((s) => s.diffSideBySide);
  const formatOnSaveEnabled = useUiStore((s) => s.formatOnSaveEnabled);
  const gitBlameEnabled = useUiStore((s) => s.gitBlameEnabled);
  const editorFontSize = useUiStore((s) => s.editorFontSize);
  const editorFontFamily = useUiStore((s) => s.editorFontFamily);
  const editorBackgroundColor = useUiStore((s) => s.editorBackgroundColor);
  const terminalFontSize = useUiStore((s) => s.terminalFontSize);
  const terminalFontFamily = useUiStore((s) => s.terminalFontFamily);
  const terminalLineHeight = useUiStore((s) => s.terminalLineHeight);
  const terminalCursorStyle = useUiStore((s) => s.terminalCursorStyle);
  const terminalCursorBlink = useUiStore((s) => s.terminalCursorBlink);
  const terminalScrollback = useUiStore((s) => s.terminalScrollback);
  const hydrate = useUiStore((s) => s.hydrate);
  const hydrated = useRef(false);

  useEffect(() => {
    applyPlatformAttribute();
    let cancelled = false;
    void loadUiPrefs().then((prefs) => {
      if (cancelled) return;
      hydrate(prefs);
      hydrated.current = true;
    });
    void useKeybindingsStore.getState().hydrate();
    return () => {
      cancelled = true;
    };
  }, [hydrate]);

  useEffect(() => {
    applyTheme(document.documentElement, theme);
  }, [theme]);

  useEffect(() => {
    document.documentElement.style.setProperty("--zoom", String(zoom));
  }, [zoom]);

  // Live drags write straight to these same CSS vars (see
  // `useResizablePanel.ts`) without touching the store — this effect only
  // needs to reflect the *committed* width, i.e. on hydrate and after a
  // drag ends, not per-frame.
  useEffect(() => {
    document.documentElement.style.setProperty("--left-sidebar-width", `${leftSidebarWidth}rem`);
  }, [leftSidebarWidth]);

  useEffect(() => {
    document.documentElement.style.setProperty("--right-sidebar-width", `${rightSidebarWidth}rem`);
  }, [rightSidebarWidth]);

  useEffect(() => {
    if (!hydrated.current) return;
    void saveUiPrefs({
      theme,
      zoom,
      leftSidebarWidth,
      rightSidebarWidth,
      autoSaveEnabled,
      minimapEnabled,
      wordWrapEnabled,
      diffSideBySide,
      formatOnSaveEnabled,
      gitBlameEnabled,
      editorFontSize,
      editorFontFamily,
      editorBackgroundColor,
      terminalFontSize,
      terminalFontFamily,
      terminalLineHeight,
      terminalCursorStyle,
      terminalCursorBlink,
      terminalScrollback,
    });
  }, [
    theme,
    zoom,
    leftSidebarWidth,
    rightSidebarWidth,
    autoSaveEnabled,
    minimapEnabled,
    wordWrapEnabled,
    diffSideBySide,
    formatOnSaveEnabled,
    gitBlameEnabled,
    editorFontSize,
    editorFontFamily,
    editorBackgroundColor,
    terminalFontSize,
    terminalFontFamily,
    terminalLineHeight,
    terminalCursorStyle,
    terminalCursorBlink,
    terminalScrollback,
  ]);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      const comboFor = useKeybindingsStore.getState().comboFor;
      if (comboMatchesEvent(comboFor("zoom.in"), event)) {
        event.preventDefault();
        setZoom(clampZoom(useUiStore.getState().zoom + ZOOM_STEP));
      } else if (comboMatchesEvent(comboFor("zoom.out"), event)) {
        event.preventDefault();
        setZoom(clampZoom(useUiStore.getState().zoom - ZOOM_STEP));
      } else if (comboMatchesEvent(comboFor("zoom.reset"), event)) {
        event.preventDefault();
        setZoom(ZOOM_DEFAULT);
      }
    }

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [setZoom]);
}
