/** What a scanned QR (or a pasted string) turned out to be.
 *
 * The desktop's "Add device" QR encodes `https://<hostname>/?code=<code>`,
 * not a bare code — so a scan can name a *different* relay than the one
 * this page was served from (two desktops, or a phone still holding an old
 * tab open). Exchanging that code against the wrong relay would just fail
 * with "invalid pairing code", which tells the user nothing, so that case
 * is reported separately and handled by going to the URL the QR actually
 * points at. */
export type ScanResult =
  { kind: "code"; code: string } | { kind: "redirect"; url: string } | { kind: "unrecognized" };

/** A pairing code is `uuid::Uuid::new_v4().simple()` — 32 hex characters,
 * no dashes. See `src-tauri/src/relay/pairing.rs`. */
const CODE_PATTERN = /^[0-9a-f]{32}$/i;

export function isPairingCode(value: string): boolean {
  return CODE_PATTERN.test(value.trim());
}

export function interpretScan(text: string, origin: string = window.location.origin): ScanResult {
  const trimmed = text.trim();
  if (!trimmed) return { kind: "unrecognized" };

  let url: URL | null = null;
  try {
    url = new URL(trimmed);
  } catch {
    // Not a URL — fall through to the bare-code check below.
  }

  if (url) {
    const code = url.searchParams.get("code")?.trim() ?? "";
    if (!CODE_PATTERN.test(code)) return { kind: "unrecognized" };
    // Same relay: pair right here, no navigation, no page reload.
    if (url.origin === origin) return { kind: "code", code };
    return { kind: "redirect", url: url.toString() };
  }

  if (CODE_PATTERN.test(trimmed)) return { kind: "code", code: trimmed };
  return { kind: "unrecognized" };
}
