import { useEffect, useRef } from "react";
import { useUiStore } from "../state/uiStore";
import { applyTheme } from "./themes";
import { clampZoom, ZOOM_DEFAULT, ZOOM_STEP } from "./zoom";
import { loadUiPrefs, saveUiPrefs } from "./persistence";
import { applyPlatformAttribute } from "./platform";

/** Wires the design system into the DOM: applies the platform attribute,
 * hydrates persisted theme/zoom, reflects store changes onto CSS custom
 * properties, persists changes back, and owns the zoom keyboard shortcuts.
 * Call once, at the app root. */
export function useDesignSystem(): void {
  const theme = useUiStore((s) => s.theme);
  const zoom = useUiStore((s) => s.zoom);
  const setZoom = useUiStore((s) => s.setZoom);
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

  useEffect(() => {
    if (!hydrated.current) return;
    void saveUiPrefs({ theme, zoom });
  }, [theme, zoom]);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      const isModPressed = event.metaKey || event.ctrlKey;
      if (!isModPressed) return;

      if (event.key === "=" || event.key === "+") {
        event.preventDefault();
        setZoom(clampZoom(useUiStore.getState().zoom + ZOOM_STEP));
      } else if (event.key === "-") {
        event.preventDefault();
        setZoom(clampZoom(useUiStore.getState().zoom - ZOOM_STEP));
      } else if (event.key === "0") {
        event.preventDefault();
        setZoom(ZOOM_DEFAULT);
      }
    }

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [setZoom]);
}
