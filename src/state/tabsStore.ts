import { create } from "zustand";

export type TabType = "agent" | "file" | "markdown" | "diff" | "terminal";

export interface Tab {
  id: string;
  type: TabType;
  title: string;
}

interface TabsState {
  tabs: Tab[];
  activeTabId: string | null;

  setActiveTab: (id: string) => void;
  closeTab: (id: string) => void;
  openTab: (tab: Tab) => void;
  ensureTab: (tab: Tab) => void;
}

// Placeholder content matching docs/design/Maestro IDE.dc.html — swapped
// for real project/session data starting in Phase 2+.
const initialTabs: Tab[] = [
  { id: "a1", type: "agent", title: "Claude Code" },
  { id: "f1", type: "file", title: "payment.service.ts" },
  { id: "m1", type: "markdown", title: "README.md" },
  { id: "d1", type: "diff", title: "auth.controller.ts" },
  { id: "t1", type: "terminal", title: "zsh — payments" },
];

export const useTabsStore = create<TabsState>((set, get) => ({
  tabs: initialTabs,
  activeTabId: initialTabs[0].id,

  setActiveTab: (id) => set({ activeTabId: id }),

  closeTab: (id) =>
    set((s) => {
      const tabs = s.tabs.filter((t) => t.id !== id);
      const activeTabId = s.activeTabId === id ? (tabs[0]?.id ?? null) : s.activeTabId;
      return { tabs, activeTabId };
    }),

  openTab: (tab) => set((s) => ({ tabs: [...s.tabs, tab], activeTabId: tab.id })),

  ensureTab: (tab) => {
    const exists = get().tabs.some((t) => t.id === tab.id);
    if (exists) {
      set({ activeTabId: tab.id });
    } else {
      get().openTab(tab);
    }
  },
}));
