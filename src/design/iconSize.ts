/** Shared icon size scale for Phosphor `<Icon size={...} />` props.
 *
 * Plain px numbers, not rem strings: Phosphor's `IconBase` passes `size`
 * straight through as an `<svg width/height>` **attribute**, not a CSS
 * property (see `IconBase.es.js`). WebKitGTK — the engine this app's
 * Linux build actually renders in — doesn't reliably resolve a `rem`
 * unit on that attribute the way Chromium does; icons using a rem-string
 * size were confirmed missing/invisible in the running app. Numbers are
 * always interpreted as px and render everywhere. The tradeoff: icon
 * size no longer scales with `--zoom` the way rem-based text/spacing
 * does — an acceptable loss versus icons not rendering at all. */
export const ICON_SIZE = {
  xs: 12,
  sm: 14,
  md: 16,
  lg: 20,
} as const;
