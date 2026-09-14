import { useEffect, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  ArrowSquareOut,
  ArrowsClockwise,
  CaretDown,
  CaretRight,
  Check,
  CheckCircle,
  Copy,
  DownloadSimple,
  Info,
  WarningCircle,
} from "@phosphor-icons/react";
import type { Icon } from "@phosphor-icons/react";
import { Button } from "../primitives";
import type { FunnelReport, FunnelState } from "../../api/relay";
import styles from "./ConnectedDevicesPane.module.css";

/** How each setup state reads: which glyph, and whether it's a problem or
 * just a step still in progress. `starting` is a race, not a fault — a
 * warning-red card for "Tailscale is connecting" would be alarming for
 * something that clears on its own. */
const TONE: Record<FunnelState, { icon: Icon; tone: "info" | "warn" }> = {
  ready: { icon: CheckCircle, tone: "info" },
  starting: { icon: Info, tone: "info" },
  notInstalled: { icon: DownloadSimple, tone: "warn" },
  daemonNotRunning: { icon: WarningCircle, tone: "warn" },
  needsLogin: { icon: WarningCircle, tone: "warn" },
  needsMachineAuth: { icon: WarningCircle, tone: "warn" },
  stopped: { icon: WarningCircle, tone: "warn" },
  funnelNotEnabled: { icon: WarningCircle, tone: "warn" },
  httpsNotEnabled: { icon: WarningCircle, tone: "warn" },
  unknown: { icon: WarningCircle, tone: "warn" },
};

/** Explains why remote access can't be turned on yet, and links straight at
 * the fix.
 *
 * Remote access depends on a four-step Tailscale setup — installed,
 * running, signed in, and Funnel enabled for the tailnet — and a user can
 * be stuck at any of them. Without this, all four looked identical: the
 * toggle snapped back and a raw line of CLI stderr appeared under it. The
 * backend now says which step is missing (`relay/funnel.rs::check`), so
 * this can name it and offer the one action that resolves it. */
export function FunnelSetupCard({
  report,
  rechecking,
  onRecheck,
}: {
  report: FunnelReport;
  rechecking: boolean;
  onRecheck: () => void;
}) {
  const [showDetail, setShowDetail] = useState(false);
  const [copied, setCopied] = useState(false);
  const { icon: Glyph, tone } = TONE[report.state] ?? TONE.unknown;

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(timer);
  }, [copied]);

  async function copyCommand() {
    if (!report.command) return;
    try {
      await navigator.clipboard.writeText(report.command);
      setCopied(true);
    } catch {
      // Clipboard denied — the command is on screen and selectable.
    }
  }

  return (
    <div className={styles.setupCard} data-tone={tone}>
      <div className={styles.setupHead}>
        <Glyph size={15} weight="fill" className={styles.setupGlyph} />
        <span className={styles.setupTitle}>{report.title}</span>
      </div>
      <p className={styles.setupMessage}>{report.message}</p>

      {report.command && (
        <div className={styles.setupCommand}>
          <code>{report.command}</code>
          <button
            type="button"
            className={styles.setupCopy}
            aria-label="Copy command"
            onClick={() => void copyCommand()}
          >
            {copied ? <Check size={12} /> : <Copy size={12} />}
          </button>
        </div>
      )}

      <div className={styles.setupActions}>
        {report.helpUrl && (
          <Button variant="primary" onClick={() => void openUrl(report.helpUrl!)}>
            <ArrowSquareOut size={13} />
            {report.helpLabel ?? "Open"}
          </Button>
        )}
        <Button variant="secondary" disabled={rechecking} onClick={onRecheck}>
          <ArrowsClockwise size={13} className={rechecking ? "mo-spin" : undefined} />
          Recheck
        </Button>
        {report.detail && (
          <button
            type="button"
            className={styles.manualToggle}
            aria-expanded={showDetail}
            onClick={() => setShowDetail((open) => !open)}
          >
            {showDetail ? <CaretDown size={11} /> : <CaretRight size={11} />}
            Details
          </button>
        )}
      </div>

      {showDetail && report.detail && <pre className={styles.setupDetail}>{report.detail}</pre>}
    </div>
  );
}
