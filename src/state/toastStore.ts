import { create } from "zustand";

export type ToastTone = "info" | "success" | "error";

export interface Toast {
  id: string;
  tone: ToastTone;
  title: string;
  description?: string;
  /** ms before auto-dismiss; errors default longer since they're more
   * likely to need reading rather than just glancing at. */
  durationMs: number;
}

interface ToastState {
  toasts: Toast[];
  push: (toast: Omit<Toast, "id" | "durationMs"> & { durationMs?: number }) => string;
  dismiss: (id: string) => void;
}

const DEFAULT_DURATION_MS: Record<ToastTone, number> = {
  info: 5000,
  success: 5000,
  error: 8000,
};

export const useToastStore = create<ToastState>((set) => ({
  toasts: [],

  push: (toast) => {
    const id = crypto.randomUUID();
    set((s) => ({
      toasts: [
        ...s.toasts,
        { id, durationMs: toast.durationMs ?? DEFAULT_DURATION_MS[toast.tone], ...toast },
      ],
    }));
    return id;
  },

  dismiss: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
}));

/** Background events (agent finished, push failed, ...) should only
 * interrupt the user if they're not already looking at wherever that
 * event is reflected live — this is the one shared rule for "is the user
 * currently looking at the app" across every toast trigger site. */
export function isAppFocused(): boolean {
  return document.hasFocus();
}
