export type UiPlatform = "linux" | "macos" | "windows" | "unknown";

function detectPlatform(): UiPlatform {
  const ua = navigator.userAgent;
  if (/Mac OS X/.test(ua)) return "macos";
  if (/Windows/.test(ua)) return "windows";
  if (/Linux/.test(ua) && !/Android/.test(ua)) return "linux";
  return "unknown";
}

/** Stamps `data-platform` on the root element once, at startup, so CSS can
 * apply platform-specific corrections (e.g. the WebKitGTK bold-text fix in
 * src/styles/tokens.css). */
export function applyPlatformAttribute(): void {
  document.documentElement.dataset.platform = detectPlatform();
}
