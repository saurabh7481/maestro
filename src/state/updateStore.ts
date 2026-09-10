import { create } from "zustand";
import { check, type Update } from "@tauri-apps/plugin-updater";

interface UpdateState {
  /** The pending update, once found — `null` means either "not checked
   * yet" or "checked, none available"; `checking`/`checked` disambiguate
   * those for the UI (e.g. the About pane's "Check for updates" button). */
  available: Update | null;
  checking: boolean;
  checked: boolean;
  checkForUpdates: () => Promise<void>;
}

export const useUpdateStore = create<UpdateState>((set) => ({
  available: null,
  checking: false,
  checked: false,

  checkForUpdates: async () => {
    set({ checking: true });
    try {
      const update = await check();
      set({ available: update, checking: false, checked: true });
    } catch {
      // Silent — a failed background check (offline, GitHub hiccup) isn't
      // worth surfacing as an error; the About pane's manual "Check for
      // updates" button reads this same store and can just be retried.
      set({ checking: false, checked: true });
    }
  },
}));
