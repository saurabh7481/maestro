import { useEffect, useState } from "react";
import { Rocket } from "@phosphor-icons/react";
import { defaultDeviceName } from "../api/auth";
import { useAuthStore } from "../state/authStore";

/** The desktop's "Add device" QR encodes `https://<hostname>/?code=<code>`
 * — scanning it lands here with `code` already in the URL, so pairing
 * happens automatically with no typing. Manual entry (below) is the
 * fallback for a phone that can't scan. */
function codeFromUrl(): string | null {
  const code = new URLSearchParams(window.location.search).get("code");
  if (!code) return null;
  // Strips the code back out of the address bar so a page refresh (or the
  // browser restoring this tab later) doesn't silently re-attempt pairing
  // with a code that's likely expired or already used.
  window.history.replaceState(null, "", window.location.pathname);
  return code;
}

export function PairScreen() {
  // Read once, at construction — not in an effect — so there is no
  // synchronous `setState` inside an effect body to trip
  // `react-hooks/set-state-in-effect`; the only state changes an async
  // pairing flow ever needs happen inside the `.then()` below.
  const [scannedCode] = useState(codeFromUrl);
  const [code, setCode] = useState(scannedCode ?? "");
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
          On your computer, open Settings → Connected Devices and tap "Add device" to get a code.
        </div>
      </div>

      <div>
        <span className="field-label">Pairing code</span>
        <input
          className="text-input code-input"
          value={code}
          onChange={(e) => setCode(e.target.value)}
          placeholder="xxxxxxxxxxxxxxxx"
          autoCapitalize="none"
          autoCorrect="off"
          autoFocus
        />
        <span className="field-label">This device's name</span>
        <input className="text-input" value={name} onChange={(e) => setName(e.target.value)} />

        {pairError && <p className="error-banner">{pairError}</p>}

        <button
          type="button"
          className="btn btn-primary btn-block"
          disabled={!code.trim() || pairing}
          onClick={() => void submit()}
        >
          {pairing ? "Pairing…" : "Pair device"}
        </button>
      </div>
    </div>
  );
}
