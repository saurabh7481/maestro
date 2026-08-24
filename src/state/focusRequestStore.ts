import { useEffect, useRef } from "react";
import { create } from "zustand";

/** Lets a keybinding/command reach into a component instance it has no
 * direct handle to — the active agent tab's composer, the search panel's
 * input — without those components lifting a ref up to a store just to be
 * reachable. `target` is whatever key the requester and the listening
 * component agree on (a run id, a fixed string like "search"); bumping its
 * counter is the signal, the counter's value itself carries no meaning. */
interface FocusRequestState {
  tokens: Record<string, number>;
  requestFocus: (target: string) => void;
}

export const useFocusRequestStore = create<FocusRequestState>((set) => ({
  tokens: {},
  requestFocus: (target) =>
    set((s) => ({ tokens: { ...s.tokens, [target]: (s.tokens[target] ?? 0) + 1 } })),
}));

/** Runs `onFocus` each time `requestFocus(target)` fires. `target` of
 * `null`/`undefined` (e.g. no active worktree yet) just never fires. */
export function useFocusRequest(target: string | null | undefined, onFocus: () => void): void {
  const token = useFocusRequestStore((s) => (target ? s.tokens[target] : undefined));
  const onFocusRef = useRef(onFocus);
  const mounted = useRef(false);

  // Kept current in its own effect (never during render, which the React
  // Compiler flags as unsafe) — runs before the token effect below on
  // every commit, so that one always sees this render's `onFocus`.
  useEffect(() => {
    onFocusRef.current = onFocus;
  });

  useEffect(() => {
    if (!mounted.current) {
      mounted.current = true;
      return;
    }
    if (token === undefined) return;
    onFocusRef.current();
  }, [token]);
}
