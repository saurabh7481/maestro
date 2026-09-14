/** True when a camera could plausibly be opened for QR scanning.
 *
 * `getUserMedia` is only exposed in a secure context, which the relay
 * always is over Tailscale Funnel (HTTPS) but is not if someone reaches it
 * over plain http on the LAN — worth checking up front so the pairing
 * screen can lead with manual entry instead of offering a camera button
 * that cannot work. */
export function cameraAvailable(): boolean {
  return window.isSecureContext && !!navigator.mediaDevices?.getUserMedia;
}
