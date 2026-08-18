export type UiPlatform = "linux" | "macos" | "windows" | "unknown";

export function detectPlatform(): UiPlatform {
  const ua = navigator.userAgent;
  if (/Mac OS X/.test(ua)) return "macos";
  if (/Windows/.test(ua)) return "windows";
  if (/Linux/.test(ua) && !/Android/.test(ua)) return "linux";
  return "unknown";
}

/** Used for the "mod" key in keybindings: ⌘ on macOS, Ctrl elsewhere. */
export function isMac(): boolean {
  return detectPlatform() === "macos";
}

/** Stamps `data-platform` on the root element once, at startup, so CSS can
 * apply platform-specific corrections (e.g. the WebKitGTK bold-text fix in
 * src/styles/tokens.css). */
export function applyPlatformAttribute(): void {
  document.documentElement.dataset.platform = detectPlatform();
}

/** Label for "reveal this file's containing folder in the OS's own file
 * manager" — same action everywhere, but what that file manager is even
 * *called* is platform vocabulary (Finder vs. File Explorer), not a
 * Maestro concept, so every call site should share this rather than
 * re-deriving it. */
export function revealInOsLabel(): string {
  switch (detectPlatform()) {
    case "macos":
      return "Reveal in Finder";
    case "windows":
      return "Reveal in File Explorer";
    default:
      return "Reveal in Files";
  }
}
