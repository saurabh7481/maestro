import { create } from "zustand";
import type { Tab } from "./tabsStore";

/** What the main window remembers about each detached window
 * (docs/V2_ROADMAP.md Phase 13).
 *
 * Two jobs. First, session persistence: a satellite's tabs are no longer
 * in `tabsStore`, so without this record they'd be missing from the saved
 * session entirely and a restart would lose them. Second, recovery: if a
 * satellite goes away without docking (a crash, a force-quit), the main
 * window still knows which tabs it held and can take them back rather
 * than leaving their agent/terminal processes running with no tab
 * anywhere. */
export interface SatelliteRecord {
  label: string;
  tabs: Tab[];
}

interface SatelliteState {
  byLabel: Record<string, SatelliteRecord>;
  track: (label: string, tabs: Tab[]) => void;
  forget: (label: string) => void;
  hydrate: (records: SatelliteRecord[]) => void;
}

export const useSatelliteStore = create<SatelliteState>((set) => ({
  byLabel: {},
  track: (label, tabs) => set((s) => ({ byLabel: { ...s.byLabel, [label]: { label, tabs } } })),
  forget: (label) =>
    set((s) => {
      if (!s.byLabel[label]) return s;
      const byLabel = { ...s.byLabel };
      delete byLabel[label];
      return { byLabel };
    }),
  hydrate: (records) =>
    set({ byLabel: Object.fromEntries(records.map((record) => [record.label, record])) }),
}));
