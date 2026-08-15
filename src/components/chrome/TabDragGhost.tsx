import { createPortal } from "react-dom";
import { useTabDragStore } from "../../state/tabDragStore";
import { TAB_VISUALS } from "../../design/tabVisuals";
import { ICON_SIZE } from "../../design/iconSize";
import styles from "./TabDragGhost.module.css";

/** The tab that follows the pointer during a drag. Rendered into
 * `document.body` so it isn't clipped by the pane it started in, and
 * positioned with a transform (not `left`/`top`) so it moves on the
 * compositor rather than triggering layout on every pointer move — the
 * same constraint documented for animations in
 * docs/ARCHITECTURE.md §9. */
export function TabDragGhost() {
  const subject = useTabDragStore((s) => s.subject);
  const x = useTabDragStore((s) => s.x);
  const y = useTabDragStore((s) => s.y);

  if (!subject) return null;
  const visual = TAB_VISUALS[subject.type];
  const Icon = visual.icon;

  return createPortal(
    <div className={styles.ghost} style={{ transform: `translate3d(${x}px, ${y}px, 0)` }}>
      <Icon size={ICON_SIZE.md} color={visual.color} />
      <span className={styles.title}>{subject.title}</span>
    </div>,
    document.body,
  );
}
