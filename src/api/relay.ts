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

/** Mirrors `src-tauri/src/relay/funnel.rs`'s `FunnelState`. Remote access
 * has a multi-step setup (Tailscale installed → running → signed in →
 * Funnel enabled for the tailnet), and this says which step is missing. */
export type FunnelState =
  | "ready"
  | "notInstalled"
  | "daemonNotRunning"
  | "needsLogin"
  | "needsMachineAuth"
  | "stopped"
  | "starting"
  | "funnelNotEnabled"
  | "httpsNotEnabled"
  | "unknown";

/** The diagnosis behind a `FunnelState`, already phrased for display.
 * Returned by `checkFunnel()` and also what `setEnabled(true)` rejects
 * with, so the pane renders one card either way. */
export interface FunnelReport {
  state: FunnelState;
  /** True when turning remote access on is guaranteed to fail from here —
   * the backend's judgement, not re-derived from `state` (see
   * `FunnelState::blocks_enabling`). */
  blocksEnabling: boolean;
  title: string;
  message: string;
  /** A page that fixes it, offered as a button. */
  helpUrl: string | null;
  helpLabel: string | null;
  /** A command the user can run themselves, where that's the real fix. */
  command: string | null;
  /** The Tailscale CLI's own output, for a details disclosure. */
  detail: string;
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
  /** Rejects with a `FunnelReport` object, not a string. */
  setEnabled: (enabled: boolean) => invoke<RelayStatus>("set_relay_enabled", { enabled }),
  status: () => invoke<RelayStatus>("relay_status"),
  /** Read-only check of whether remote access *can* be turned on. Changes
   * nothing, so it's safe to poll. */
  checkFunnel: () => invoke<FunnelReport>("check_funnel"),
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
