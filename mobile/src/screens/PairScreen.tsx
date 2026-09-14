import { useEffect, useState } from "react";
import { Keyboard, QrCode, Rocket } from "@phosphor-icons/react";
import { defaultDeviceName } from "../api/auth";
import { interpretScan } from "../api/pairingCode";
import { QrScanner } from "../components/QrScanner";
import { cameraAvailable } from "../design/camera";
import { useAuthStore } from "../state/authStore";

/** The desktop's "Add device" QR encodes `https://<hostname>/?code=<code>`
 * — following that link (from the phone's own camera app, or from the
 * in-app scanner below when it points at another relay) lands here with
 * `code` already in the URL, so pairing happens with no typing at all. */
function codeFromUrl(): string | null {
  const code = new URLSearchParams(window.location.search).get("code");
  if (!code) return null;
  // Strips the code back out of the address bar so a page refresh (or the
  // browser restoring this tab later) doesn't silently re-attempt pairing
  // with a code that's likely expired or already used.
  window.history.replaceState(null, "", window.location.pathname);
  return code;
}

/** The two ways to hand this device a pairing code. Both end in the same
 * `pair()` call — scanning just fills the code in for you. */
type Mode = "scan" | "manual";

export function PairScreen() {
  // Read once, at construction — not in an effect — so there is no
  // synchronous `setState` inside an effect body to trip
  // `react-hooks/set-state-in-effect`; the only state changes an async
  // pairing flow ever needs happen inside the `.then()` below.
  const [scannedCode] = useState(codeFromUrl);
  const [supportsCamera] = useState(cameraAvailable);
  // Scanning leads when it's possible at all, but the camera itself only
  // opens on an explicit tap below — landing on this screen should not
  // fire a permission prompt at someone who came here to type a code.
  const [mode, setMode] = useState<Mode>(supportsCamera ? "scan" : "manual");
  const [scanning, setScanning] = useState(false);
  const [scanError, setScanError] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [name, setName] = useState(defaultDeviceName());
  const [autoPairing, setAutoPairing] = useState(!!scannedCode);
  const pair = useAuthStore((s) => s.pair);
  const pairing = useAuthStore((s) => s.pairing);
  const pairError = useAuthStore((s) => s.pairError);

  useEffect(() => {
    if (!scannedCode) return;
    void pair(scannedCode, defaultDeviceName()).then((ok) => {
      if (!ok) setAutoPairing(false);
    });
    // Runs once for the code present at mount — a scanned code is single
    // use, so there is nothing to re-run on a later `pair` identity change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function submit() {
    if (!code.trim()) return;
    await pair(code.trim(), name.trim() || defaultDeviceName());
  }

  function handleScan(text: string) {
    const result = interpretScan(text);
    if (result.kind === "unrecognized") {
      setScanError(
        "That isn't a Maestro pairing QR code. Point the camera at the code shown in Settings → Connected Devices.",
      );
      return;
    }
    if (result.kind === "redirect") {
      // The QR names a different desktop than the one serving this page;
      // its code is worthless here. Go where it points instead — that page
      // pairs itself from `?code=` on arrival.
      window.location.href = result.url;
      return;
    }
    // Release the camera before the pairing round-trip rather than after:
    // on success this screen unmounts and never gets to tidy up visibly.
    setScanning(false);
    setScanError(null);
    setCode(result.code);
    void pair(result.code, name.trim() || defaultDeviceName());
  }

  function switchMode(next: Mode) {
    setMode(next);
    setScanning(false);
    setScanError(null);
  }

  if (autoPairing) {
    return (
      <div className="pair-screen">
        <div style={{ textAlign: "center" }}>
          <div className="pair-logo" style={{ margin: "0 auto var(--space-3)" }}>
            <Rocket size={26} weight="fill" />
          </div>
          <div className="pair-title">Connecting…</div>
        </div>
      </div>
    );
  }

  return (
    <div className="pair-screen">
      <div>
        <div className="pair-logo">
          <Rocket size={26} weight="fill" />
        </div>
        <div className="pair-title">Pair with Maestro</div>
        <div className="pair-subtitle">
          On your computer, open Settings → Connected Devices and tap "Add device".
        </div>
      </div>

      <div>
        <div className="kind-grid">
          <button
            type="button"
            className="kind-option"
            data-selected={mode === "scan"}
            onClick={() => switchMode("scan")}
          >
            <QrCode size={16} weight={mode === "scan" ? "fill" : "regular"} />
            Scan QR code
          </button>
          <button
            type="button"
            className="kind-option"
            data-selected={mode === "manual"}
            onClick={() => switchMode("manual")}
          >
            <Keyboard size={16} weight={mode === "manual" ? "fill" : "regular"} />
            Enter code
          </button>
        </div>

        {mode === "scan" ? (
          <>
            {scanning ? (
              <QrScanner onScan={handleScan} />
            ) : (
              <div className="qr-viewfinder qr-viewfinder-idle">
                <QrCode size={44} weight="thin" />
                <span className="qr-status">
                  {pairing ? "Pairing…" : "Point your camera at the QR code on your computer"}
                </span>
              </div>
            )}
            {scanError && <p className="error-banner qr-error">{scanError}</p>}
            <button
              type="button"
              className="btn btn-secondary btn-block qr-toggle"
              disabled={pairing}
              onClick={() => {
                setScanError(null);
                setScanning((on) => !on);
              }}
            >
              {scanning ? "Stop camera" : "Open camera"}
            </button>
          </>
        ) : (
          <>
            <span className="field-label">Pairing code</span>
            <input
              className="text-input code-input"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              placeholder="00000000000000000000000000000000"
              autoCapitalize="none"
              autoCorrect="off"
              autoFocus
            />
          </>
        )}

        <span className="field-label">This device's name</span>
        <input className="text-input" value={name} onChange={(e) => setName(e.target.value)} />

        {pairError && <p className="error-banner">{pairError}</p>}

        {mode === "manual" && (
          <button
            type="button"
            className="btn btn-primary btn-block"
            disabled={!code.trim() || pairing}
            onClick={() => void submit()}
          >
            {pairing ? "Pairing…" : "Pair device"}
          </button>
        )}
      </div>
    </div>
  );
}
