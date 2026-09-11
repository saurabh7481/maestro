import { invoke } from "@tauri-apps/api/core";

/** Thin, typed wrapper around the mobile relay's Tauri command surface —
 * same pattern as `terminalApi`/`gitApi`. Backs the "Connected Devices"
 * Settings pane. */

export interface RelayStatus {
  enabled: boolean;
  port: number | null;
  /** The Funnel-public hostname the relay is reachable on, e.g.
   * `"my-laptop.tailxxxx.ts.net"`. `null` unless `enabled`. */
  hostname: string | null;
}

export type DeviceAccessLevel = "write" | "read";

export interface PairedDevice {
  id: string;
  name: string;
  accessLevel: DeviceAccessLevel;
  createdAt: string;
  lastSeenAt: string | null;
  revokedAt: string | null;
  /** Has a currently-open WebSocket stream — best-effort presence, not a
   * durable record (see `relay/mod.rs::RelayState`). */
  online: boolean;
}

export const relayApi = {
  setEnabled: (enabled: boolean) => invoke<RelayStatus>("set_relay_enabled", { enabled }),
  status: () => invoke<RelayStatus>("relay_status"),
  /** Mints a one-time pairing code (5-minute TTL) for the "Add Device" QR
   * flow. Exchanged by `POST /api/pair/exchange` on the relay itself. */
  createPairingCode: () => invoke<string>("create_pairing_code"),
  listDevices: () => invoke<PairedDevice[]>("list_paired_devices"),
  revokeDevice: (deviceId: string) => invoke<void>("revoke_device", { deviceId }),
  /** Permanently removes a device row — only meaningful once it's already
   * revoked (see `devices.rs::delete_device`'s own doc comment). */
  deleteDevice: (deviceId: string) => invoke<void>("delete_device", { deviceId }),
  setDeviceAccess: (deviceId: string, accessLevel: DeviceAccessLevel) =>
    invoke<void>("set_device_access", { deviceId, accessLevel }),
  renameDevice: (deviceId: string, name: string) =>
    invoke<void>("rename_device", { deviceId, name }),
};
