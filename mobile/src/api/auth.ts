/** Bearer-token storage for this device's pairing with the relay. A single
 * device only ever has one active pairing, so this is deliberately a flat
 * module-level store, not something worth a zustand store of its own. */

const TOKEN_KEY = "maestro-relay-token";

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

export function setToken(token: string): void {
  localStorage.setItem(TOKEN_KEY, token);
}

export function clearToken(): void {
  localStorage.removeItem(TOKEN_KEY);
}

/** A short, human-recognizable default device name — the desktop pane lets
 * the user rename it, but "New device" (the server's own fallback) is
 * useless when three phones all pair in the same week. Best-effort parse
 * of the platform out of the UA string; falls back gracefully since this
 * is only ever a starting point, never load-bearing. */
export function defaultDeviceName(): string {
  const ua = navigator.userAgent;
  if (/iPhone/.test(ua)) return "iPhone";
  if (/iPad/.test(ua)) return "iPad";
  if (/Android/.test(ua)) return "Android device";
  if (/Macintosh/.test(ua)) return "Mac browser";
  if (/Windows/.test(ua)) return "Windows browser";
  return "Mobile browser";
}
