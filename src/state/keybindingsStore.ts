import { create } from "zustand";
import { KEYBINDING_ACTIONS, type KeyCombo } from "../design/keymap";
import { loadKeybindingOverrides, saveKeybindingOverrides } from "../design/persistence";

interface KeybindingsState {
  /** action id → user override. Missing entries fall back to the action's
   * `defaultCombo`. */
  overrides: Record<string, KeyCombo>;
  hydrated: boolean;

  hydrate: () => Promise<void>;
  setBinding: (actionId: string, combo: KeyCombo) => void;
  resetBinding: (actionId: string) => void;
  resetAll: () => void;
  comboFor: (actionId: string) => KeyCombo;
}

function persist(overrides: Record<string, KeyCombo>): void {
  void saveKeybindingOverrides(overrides);
}

export const useKeybindingsStore = create<KeybindingsState>((set, get) => ({
  overrides: {},
  hydrated: false,

  hydrate: async () => {
    const overrides = await loadKeybindingOverrides();
    set({ overrides, hydrated: true });
  },

  setBinding: (actionId, combo) =>
    set((s) => {
      const overrides = { ...s.overrides, [actionId]: combo };
      persist(overrides);
      return { overrides };
    }),

  resetBinding: (actionId) =>
    set((s) => {
      const overrides = { ...s.overrides };
      delete overrides[actionId];
      persist(overrides);
      return { overrides };
    }),

  resetAll: () => {
    persist({});
    set({ overrides: {} });
  },

  comboFor: (actionId) => {
    const override = get().overrides[actionId];
    if (override) return override;
    const action = KEYBINDING_ACTIONS.find((a) => a.id === actionId);
    return action?.defaultCombo ?? "";
  },
}));
