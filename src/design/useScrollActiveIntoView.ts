import { useEffect, useRef } from "react";

/** Keeps a manually keyboard-navigated list's highlighted item scrolled
 * into view as the active index changes. Radix menus (the app's other
 * dropdowns) get this for free — arrow keys move real DOM focus, and
 * focusing an off-screen element is natively scrolled into view by the
 * browser. A hand-rolled list (a plain `.map()` of divs tracking
 * `activeIndex` in React state + `data-active`, used where a menu needs
 * to co-exist with a live-typed text input, e.g. the composer's
 * @-mention/slash-command menus and the command palette) has no DOM
 * focus to piggyback on, so without this the highlight silently drifts
 * off-screen as soon as it moves past whatever's currently visible.
 *
 * Usage: attach the returned ref only to the currently-active row
 * (`ref={i === activeIndex ? activeItemRef : undefined}`); pass any
 * value that changes when the *list itself* changes (not just the
 * index) as `listVersion` so switching lists re-scrolls to the new
 * active item too, not just re-highlighting within the same one. */
export function useScrollActiveIntoView<T extends HTMLElement>(
  activeIndex: number,
  listVersion?: unknown,
) {
  const ref = useRef<T>(null);
  useEffect(() => {
    ref.current?.scrollIntoView({ block: "nearest" });
  }, [activeIndex, listVersion]);
  return ref;
}
