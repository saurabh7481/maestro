import { useCallback, useEffect, useState } from "react";
import { CaretDown, Check, Copy, PencilSimple, Plus, Trash } from "@phosphor-icons/react";
import QRCode from "qrcode";
import { relayApi } from "../../api/relay";
import type { PairedDevice, RelayStatus } from "../../api/relay";
import { Button, IconButton, Switch, TextInput } from "../primitives";
import settingsStyles from "./SettingsModal.module.css";
import styles from "./ConnectedDevicesPane.module.css";

/** How often the device list is re-polled while this pane is open, so the
 * online/offline dot and "last seen" stay roughly live without a push
 * channel of their own — same tradeoff as `processStore.ts`'s polling. */
const REFRESH_INTERVAL_MS = 5000;

function CopyField({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    await navigator.clipboard.writeText(value);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }
  return (
    <div className={styles.copyField}>
      <div className={styles.copyFieldBody}>
        <span className={styles.copyFieldLabel}>{label}</span>
        <code className={styles.copyFieldValue}>{value}</code>
      </div>
      <IconButton
        icon={copied ? Check : Copy}
        label={`Copy ${label.toLowerCase()}`}
        size="sm"
        onClick={() => void copy()}
      />
    </div>
  );
}

export function ConnectedDevicesPane() {
  const [status, setStatus] = useState<RelayStatus>({ enabled: false, port: null, hostname: null });
  const [devices, setDevices] = useState<PairedDevice[]>([]);
  const [busy, setBusy] = useState(false);
  const [pairingCode, setPairingCode] = useState<string | null>(null);
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [showManual, setShowManual] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingName, setEditingName] = useState("");

  const refreshDevices = useCallback(async () => {
    try {
      setDevices(await relayApi.listDevices());
    } catch (e) {
      setError(String(e));
    }
  }, []);

  useEffect(() => {
    relayApi
      .status()
      .then(setStatus)
      .catch((e) => setError(String(e)));
    relayApi
      .listDevices()
      .then(setDevices)
      .catch((e) => setError(String(e)));
    const interval = setInterval(() => void refreshDevices(), REFRESH_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [refreshDevices]);

  async function toggleEnabled(next: boolean) {
    setBusy(true);
    setError(null);
    try {
      setStatus(await relayApi.setEnabled(next));
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  // The relay only ever reports itself as enabled once Funnel has
  // successfully exposed it (see `relay::set_relay_enabled`), so a
  // hostname is always present by the time "Add device" is clickable.
  async function addDevice() {
    setError(null);
    setShowManual(false);
    setQrDataUrl(null);
    try {
      const code = await relayApi.createPairingCode();
      setPairingCode(code);
      if (status.hostname) {
        // The mobile app's own pair screen reads `?code=` and pairs
        // automatically — scanning this is the entire flow, no typing.
        const pairUrl = `https://${status.hostname}/?code=${code}`;
        setQrDataUrl(await QRCode.toDataURL(pairUrl, { width: 260, margin: 1 }));
      }
    } catch (e) {
      setError(String(e));
    }
  }

  async function revoke(deviceId: string) {
    try {
      await relayApi.revokeDevice(deviceId);
      await refreshDevices();
    } catch (e) {
      setError(String(e));
    }
  }

  async function deleteDevice(deviceId: string) {
    try {
      await relayApi.deleteDevice(deviceId);
      await refreshDevices();
    } catch (e) {
      setError(String(e));
    }
  }

  async function toggleAccess(device: PairedDevice) {
    try {
      await relayApi.setDeviceAccess(device.id, device.accessLevel === "write" ? "read" : "write");
      await refreshDevices();
    } catch (e) {
      setError(String(e));
    }
  }

  function startEditing(device: PairedDevice) {
    setEditingId(device.id);
    setEditingName(device.name);
  }

  async function commitEditing() {
    const id = editingId;
    const name = editingName.trim();
    setEditingId(null);
    if (!id || !name) return;
    try {
      await relayApi.renameDevice(id, name);
      await refreshDevices();
    } catch (e) {
      setError(String(e));
    }
  }

  const pairUrl =
    status.hostname && pairingCode ? `https://${status.hostname}/?code=${pairingCode}` : null;

  return (
    <>
      <div className={settingsStyles.group}>
        <span className={settingsStyles.groupLabel}>Remote access</span>
        <div className={styles.toggleRow}>
          <div className={styles.toggleCopy}>
            <div className={styles.toggleTitle}>Enable remote access</div>
            <p className={settingsStyles.placeholder} style={{ margin: 0 }}>
              {status.enabled
                ? status.hostname
                  ? `Reachable at https://${status.hostname} — paired devices can control agent and terminal tabs from anywhere.`
                  : `Relay running on 127.0.0.1:${status.port}.`
                : "Starts a relay server, reachable from anywhere via Tailscale Funnel, that a paired device — phone, tablet, or another computer — can control agent and terminal tabs through."}
            </p>
          </div>
          <Switch
            checked={status.enabled}
            onCheckedChange={(next) => void toggleEnabled(next)}
            label="Enable remote access"
            disabled={busy}
          />
        </div>
      </div>

      <div className={settingsStyles.group}>
        <div className={styles.groupHeader}>
          <span className={settingsStyles.groupLabel}>Connected devices</span>
          <Button variant="secondary" onClick={() => void addDevice()} disabled={!status.enabled}>
            <Plus size={14} />
            Add device
          </Button>
        </div>

        {pairingCode && (
          <div className={styles.pairingCard}>
            {qrDataUrl ? (
              <>
                <img src={qrDataUrl} alt="Pairing QR code" className={styles.qrImage} />
                <p className={styles.pairingHint}>Scan this with your phone's camera to connect.</p>
              </>
            ) : (
              <p className={styles.pairingHint}>
                Open Maestro on your phone and enter this code to connect.
              </p>
            )}
            <p className={styles.pairingExpiry}>Expires in 5 minutes.</p>

            <button
              type="button"
              className={styles.manualToggle}
              onClick={() => setShowManual((v) => !v)}
              aria-expanded={showManual}
            >
              <CaretDown size={12} style={{ transform: showManual ? "rotate(180deg)" : "none" }} />
              Can't scan? Enter it manually
            </button>
            {showManual && (
              <div className={styles.manualFields}>
                {pairUrl && <CopyField label="Link" value={pairUrl} />}
                <CopyField label="Code" value={pairingCode} />
              </div>
            )}
          </div>
        )}

        {error && <p className={styles.error}>{error}</p>}

        {devices.length === 0 && (
          <p className={settingsStyles.placeholder}>No devices paired yet.</p>
        )}

        {devices.map((device) => (
          <div key={device.id} className={styles.row}>
            <span className={styles.onlineDot} data-online={device.online} />
            <div className={styles.rowBody}>
              {editingId === device.id ? (
                <TextInput
                  autoFocus
                  value={editingName}
                  onChange={(e) => setEditingName(e.target.value)}
                  onBlur={() => void commitEditing()}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") void commitEditing();
                    if (e.key === "Escape") setEditingId(null);
                  }}
                />
              ) : (
                <span className={styles.rowLabel}>{device.name}</span>
              )}
              <span className={styles.rowDetail}>
                {device.revokedAt
                  ? "Revoked"
                  : device.lastSeenAt
                    ? `Last seen ${new Date(device.lastSeenAt).toLocaleString()}`
                    : "Never connected"}
              </span>
            </div>
            <div className={styles.rowActions}>
              <button
                type="button"
                className={styles.accessButton}
                data-write={device.accessLevel === "write"}
                onClick={() => void toggleAccess(device)}
                disabled={!!device.revokedAt}
              >
                {device.accessLevel === "write" ? "Write" : "Read-only"}
              </button>
              <IconButton
                icon={PencilSimple}
                label={`Rename ${device.name}`}
                size="sm"
                onClick={() => startEditing(device)}
                disabled={!!device.revokedAt}
              />
              {device.revokedAt ? (
                <IconButton
                  icon={Trash}
                  label={`Remove ${device.name}`}
                  size="sm"
                  tone="danger"
                  onClick={() => void deleteDevice(device.id)}
                />
              ) : (
                <IconButton
                  icon={Trash}
                  label={`Revoke ${device.name}`}
                  size="sm"
                  tone="danger"
                  onClick={() => void revoke(device.id)}
                />
              )}
            </div>
          </div>
        ))}
      </div>
    </>
  );
}
