import { create } from "zustand";
import { clearToken, getToken, setToken } from "../api/auth";
import { ApiError, relayClient } from "../api/client";

interface AuthState {
  status: "checking" | "unauthenticated" | "authenticated";
  accessLevel: "write" | "read" | null;
  deviceId: string | null;
  pairError: string | null;
  pairing: boolean;
  boot: () => Promise<void>;
  pair: (code: string, deviceName: string) => Promise<boolean>;
  /** Re-checks access level — called on stream reconnect, so a desktop-side
   * downgrade to read-only (or a revoke) takes effect without the user
   * having to reopen the app. */
  refresh: () => Promise<void>;
  logout: () => void;
}

export const useAuthStore = create<AuthState>((set) => ({
  status: "checking",
  accessLevel: null,
  deviceId: null,
  pairError: null,
  pairing: false,

  boot: async () => {
    if (!getToken()) {
      set({ status: "unauthenticated" });
      return;
    }
    try {
      const me = await relayClient.whoAmI();
      set({ status: "authenticated", accessLevel: me.accessLevel, deviceId: me.deviceId });
    } catch {
      clearToken();
      set({ status: "unauthenticated" });
    }
  },

  pair: async (code, deviceName) => {
    set({ pairing: true, pairError: null });
    try {
      const result = await relayClient.exchangePairingCode(code, deviceName);
      setToken(result.token);
      const me = await relayClient.whoAmI();
      set({
        status: "authenticated",
        accessLevel: me.accessLevel,
        deviceId: me.deviceId,
        pairing: false,
      });
      return true;
    } catch (e) {
      set({ pairing: false, pairError: e instanceof ApiError ? e.message : String(e) });
      return false;
    }
  },

  refresh: async () => {
    if (!getToken()) return;
    try {
      const me = await relayClient.whoAmI();
      set({ accessLevel: me.accessLevel, deviceId: me.deviceId });
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) {
        clearToken();
        set({ status: "unauthenticated", accessLevel: null, deviceId: null });
      }
    }
  },

  logout: () => {
    clearToken();
    set({ status: "unauthenticated", accessLevel: null, deviceId: null });
  },
}));
