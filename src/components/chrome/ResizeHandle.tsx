import { useResizablePanel } from "../../design/useResizablePanel";
import styles from "./ResizeHandle.module.css";

export interface ResizeHandleProps {
  cssVar: string;
  edge: "left" | "right";
  minPx: number;
  maxPx: number;
  getWidthRem: () => number;
  onCommit: (widthRem: number) => void;
}

/** A thin drag strip pinned to a sidebar's inner edge, tracking that
 * sidebar's width via `cssVar` (see `Sidebar.module.css`'s
 * `.panel[data-side]` rules) so it moves with the panel automatically —
 * no measurement or ref-coordination with the sidebar's own content
 * needed. One of these is rendered per open sidebar, as a sibling in
 * `AppShell.tsx`'s `.body`. */
export function ResizeHandle({ cssVar, edge, minPx, maxPx, getWidthRem, onCommit }: ResizeHandleProps) {
  const { onPointerDown } = useResizablePanel({ cssVar, edge, minPx, maxPx, getWidthRem, onCommit });
  return (
    <div
      className={styles.handle}
      data-edge={edge}
      style={{ [edge]: `calc(var(${cssVar}) - 3px)` } as React.CSSProperties}
      onPointerDown={onPointerDown}
    />
  );
}
