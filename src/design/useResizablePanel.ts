import { useCallback, useRef } from "react";
import { ZOOM_DEFAULT } from "./zoom";

const BASE_ROOT_FONT_PX = 16;

export interface UseResizablePanelOptions {
  /** The CSS custom property this hook drives live during a drag, e.g.
   * "--left-sidebar-width". */
  cssVar: string;
  /** Which side of the panel the drag handle sits on — determines whether
   * a rightward pointer movement grows or shrinks the panel. */
  edge: "left" | "right";
  minPx: number;
  maxPx: number;
  /** The panel's current committed width, in rem, read fresh at drag-start
   * (not subscribed to) — this hook only needs it as the drag's starting
   * point, not as a re-render trigger. */
  getWidthRem: () => number;
  /** Called once, on pointer-up, with the final width in rem. */
  onCommit: (widthRem: number) => void;
}

/** Wires up a drag-to-resize handle. Writes the live width directly onto
 * `documentElement`'s style during the drag (no React state, no
 * re-render per frame — the same imperative-CSS-var approach
 * `useDesignSystem.ts` already uses for `--zoom`), then converts to rem
 * and commits to the store once, on release. */
export function useResizablePanel({
  cssVar,
  edge,
  minPx,
  maxPx,
  getWidthRem,
  onCommit,
}: UseResizablePanelOptions) {
  const dragState = useRef<{ startX: number; startPx: number } | null>(null);

  const onPointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (event.button !== 0) return;
      event.preventDefault();

      const root = document.documentElement;
      const zoom = Number(getComputedStyle(root).getPropertyValue("--zoom")) || ZOOM_DEFAULT;
      const rootFontPx = BASE_ROOT_FONT_PX * zoom;
      const startPx = getWidthRem() * rootFontPx;
      dragState.current = { startX: event.clientX, startPx };

      const target = event.currentTarget;
      target.setPointerCapture(event.pointerId);
      root.dataset.resizingSidebar = edge;

      let rafId = 0;
      let pendingPx: number | null = null;

      function applyPending() {
        rafId = 0;
        if (pendingPx == null) return;
        root.style.setProperty(cssVar, `${pendingPx}px`);
      }

      function onPointerMove(moveEvent: PointerEvent) {
        const drag = dragState.current;
        if (!drag) return;
        const delta = moveEvent.clientX - drag.startX;
        const raw = edge === "left" ? drag.startPx + delta : drag.startPx - delta;
        pendingPx = Math.min(maxPx, Math.max(minPx, raw));
        if (!rafId) rafId = window.requestAnimationFrame(applyPending);
      }

      function onPointerUp() {
        if (rafId) window.cancelAnimationFrame(rafId);
        window.removeEventListener("pointermove", onPointerMove);
        window.removeEventListener("pointerup", onPointerUp);
        delete root.dataset.resizingSidebar;
        target.releasePointerCapture(event.pointerId);

        const finalPx = pendingPx ?? startPx;
        const finalZoom = Number(getComputedStyle(root).getPropertyValue("--zoom")) || ZOOM_DEFAULT;
        onCommit(finalPx / (BASE_ROOT_FONT_PX * finalZoom));
        dragState.current = null;
      }

      window.addEventListener("pointermove", onPointerMove);
      window.addEventListener("pointerup", onPointerUp);
    },
    [cssVar, edge, minPx, maxPx, getWidthRem, onCommit],
  );

  return { onPointerDown };
}
