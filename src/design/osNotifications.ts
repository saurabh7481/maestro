import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from "@tauri-apps/plugin-notification";

let granted: boolean | null = null;

/** Requests OS notification permission once, at startup — see
 * `AppShell.tsx`'s `useNotificationPermission`. Safe to call more than
 * once: the underlying APIs are idempotent, and a user who already
 * granted or denied isn't re-prompted. */
export async function ensureNotificationPermission(): Promise<void> {
  granted = await isPermissionGranted();
  if (!granted) {
    granted = (await requestPermission()) === "granted";
  }
}

/** Fires an OS-level desktop notification — silently does nothing if
 * permission was never granted (denied, or the startup request hasn't
 * resolved yet), the same "just doesn't show" behavior a toast has if
 * nothing calls `push()`. Never throws: a notification failing to fire
 * isn't worth surfacing as an error of its own. */
export function sendOsNotification(title: string, body?: string): void {
  if (!granted) return;
  try {
    sendNotification({ title, body });
  } catch {
    // Best-effort.
  }
}
