import { useEffect, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { relaunch } from "@tauri-apps/plugin-process";
import type { DownloadEvent, Update } from "@tauri-apps/plugin-updater";
import { ArrowClockwise, CheckCircle, Download, WarningCircle } from "@phosphor-icons/react";
import { useUpdateStore } from "../../state/updateStore";
import { updatesApi, listenToRevertEvents } from "../../api/updates";
import type { ReleaseOption } from "../../api/updates";
import { Button } from "../primitives";
import styles from "./SettingsModal.module.css";

/** Tracks one download's progress from a plugin `DownloadEvent` stream —
 * shared shape for both "install the latest version" (the plugin's own
 * `Update.downloadAndInstall`) and "revert to an older one" (this app's
 * own `revert_to_version` command), even though they arrive over two
 * different transports (a JS callback vs. a Tauri event channel). */
interface Progress {
  downloaded: number;
  total: number | null;
}

function ProgressBar({ progress }: { progress: Progress }) {
  const pct =
    progress.total && progress.total > 0
      ? Math.min(100, Math.round((progress.downloaded / progress.total) * 100))
      : null;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-2)" }}>
      <div
        style={{
          height: "6px",
          borderRadius: "var(--radius-full)",
          background: "var(--bg-3)",
          overflow: "hidden",
        }}
      >
        <div
          style={{
            height: "100%",
            width: pct != null ? `${pct}%` : "40%",
            background: "var(--accent)",
            borderRadius: "var(--radius-full)",
            transition: "width 150ms ease",
          }}
        />
      </div>
      <span style={{ fontSize: "var(--text-xs)", color: "var(--text-mute)" }}>
        {pct != null ? `${pct}%` : "Downloading…"}
      </span>
    </div>
  );
}

function ErrorNote({ text }: { text: string }) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "flex-start",
        gap: "var(--space-3)",
        padding: "var(--space-4) var(--space-5)",
        borderRadius: "var(--radius-md)",
        background: "rgba(224,108,117,.1)",
        border: "1px solid rgba(224,108,117,.3)",
        color: "var(--red)",
        fontSize: "var(--text-xs)",
      }}
    >
      <WarningCircle size={14} style={{ flexShrink: 0, marginTop: "2px" }} />
      <span>{text}</span>
    </div>
  );
}

function LatestUpdateSection() {
  const available = useUpdateStore((s) => s.available);
  const checking = useUpdateStore((s) => s.checking);
  const checked = useUpdateStore((s) => s.checked);
  const checkForUpdates = useUpdateStore((s) => s.checkForUpdates);

  const [installing, setInstalling] = useState(false);
  const [progress, setProgress] = useState<Progress | null>(null);
  const [installed, setInstalled] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleInstall(update: Update) {
    setInstalling(true);
    setError(null);
    let downloaded = 0;
    try {
      await update.downloadAndInstall((event: DownloadEvent) => {
        if (event.event === "Progress") {
          downloaded += event.data.chunkLength;
          setProgress({ downloaded, total: progress?.total ?? null });
        } else if (event.event === "Started") {
          setProgress({ downloaded: 0, total: event.data.contentLength ?? null });
        }
      });
      setInstalled(true);
    } catch (err) {
      setError(String(err));
    } finally {
      setInstalling(false);
    }
  }

  return (
    <div className={styles.group}>
      <span className={styles.groupLabel}>Updates</span>
      <div className={styles.presetRow}>
        <div className={styles.presetText}>
          <div className={styles.presetTitle}>
            {available ? `Version ${available.version} is available` : "You're up to date"}
          </div>
          <div className={styles.presetDescription}>
            {available?.body?.trim() ||
              (checked ? "Checked against the latest GitHub release." : "Not checked yet.")}
          </div>
        </div>
        {!available && (
          <Button variant="secondary" onClick={() => void checkForUpdates()} disabled={checking}>
            <ArrowClockwise size={14} />
            {checking ? "Checking…" : "Check for updates"}
          </Button>
        )}
      </div>

      {available && !installed && (
        <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-3)" }}>
          {installing && progress ? (
            <ProgressBar progress={progress} />
          ) : (
            <div style={{ display: "flex" }}>
              <Button
                variant="primary"
                disabled={installing}
                onClick={() => void handleInstall(available)}
              >
                <Download size={14} />
                Download &amp; Install
              </Button>
            </div>
          )}
          {error && <ErrorNote text={error} />}
        </div>
      )}

      {installed && (
        <div className={styles.presetRow}>
          <CheckCircle size={18} color="var(--green)" weight="fill" />
          <div className={styles.presetText}>
            <div className={styles.presetTitle}>Installed — restart to finish</div>
          </div>
          <Button variant="primary" onClick={() => void relaunch()}>
            Restart Now
          </Button>
        </div>
      )}
    </div>
  );
}

function VersionHistorySection() {
  const [releases, setReleases] = useState<ReleaseOption[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [revertingTag, setRevertingTag] = useState<string | null>(null);
  const [progress, setProgress] = useState<Progress | null>(null);
  const [doneTag, setDoneTag] = useState<string | null>(null);
  const [revertError, setRevertError] = useState<string | null>(null);

  useEffect(() => {
    void updatesApi
      .listReleases()
      .then(setReleases)
      .catch((err) => setLoadError(String(err)));
  }, []);

  async function handleRevert(tag: string) {
    setRevertingTag(tag);
    setRevertError(null);
    setProgress(null);
    const opId = crypto.randomUUID();
    const unlisten = await listenToRevertEvents(opId, (event) => {
      if (event.type === "progress") {
        setProgress({ downloaded: event.downloaded, total: event.total });
      } else {
        if (event.success) setDoneTag(tag);
        else setRevertError(event.error ?? "Reinstall failed.");
        setRevertingTag(null);
      }
    });
    try {
      await updatesApi.revertToVersion(opId, tag);
    } catch (err) {
      setRevertError(String(err));
      setRevertingTag(null);
    } finally {
      void unlisten();
    }
  }

  return (
    <div className={styles.group}>
      <span className={styles.groupLabel}>Reinstall a previous version</span>
      <p className={styles.placeholder} style={{ marginBottom: "var(--space-2)" }}>
        Downloads and installs an older release the same verified way an update does. Only versions
        published with this feature are listed.
      </p>

      {doneTag && (
        <div className={styles.presetRow}>
          <CheckCircle size={18} color="var(--green)" weight="fill" />
          <div className={styles.presetText}>
            <div className={styles.presetTitle}>Reinstalled {doneTag} — restart to finish</div>
          </div>
          <Button variant="primary" onClick={() => void relaunch()}>
            Restart Now
          </Button>
        </div>
      )}

      {loadError && <ErrorNote text={loadError} />}
      {revertError && <ErrorNote text={revertError} />}

      {releases?.map((release) => (
        <div key={release.tag} className={styles.presetRow}>
          <div className={styles.presetText}>
            <div className={styles.presetTitle}>{release.name}</div>
            <div className={styles.presetDescription}>
              {release.publishedAt ? new Date(release.publishedAt).toLocaleDateString() : ""}
            </div>
          </div>
          {revertingTag === release.tag ? (
            progress ? (
              <div style={{ width: "8rem" }}>
                <ProgressBar progress={progress} />
              </div>
            ) : (
              <span style={{ fontSize: "var(--text-xs)", color: "var(--text-mute)" }}>
                Starting…
              </span>
            )
          ) : (
            <Button
              variant="secondary"
              disabled={revertingTag != null}
              onClick={() => void handleRevert(release.tag)}
            >
              Reinstall
            </Button>
          )}
        </div>
      ))}
    </div>
  );
}

export function AboutPane() {
  const [version, setVersion] = useState<string | null>(null);

  useEffect(() => {
    void getVersion().then(setVersion);
  }, []);

  return (
    <div className={styles.group}>
      <span className={styles.groupLabel}>About Maestro</span>
      <p className={styles.placeholder} style={{ marginBottom: "var(--space-2)" }}>
        Version {version ?? "…"}
      </p>
      <LatestUpdateSection />
      <VersionHistorySection />
    </div>
  );
}
