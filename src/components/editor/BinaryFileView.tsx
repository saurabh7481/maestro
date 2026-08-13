import { FileArchive } from "@phosphor-icons/react";
import { formatBytes } from "../../editor/formatBytes";
import styles from "./PlaceholderView.module.css";

export function BinaryFileView({ sizeBytes }: { sizeBytes: number }) {
  return (
    <div className={styles.wrap}>
      <div className={styles.icon}>
        <FileArchive size={26} color="var(--text-mute)" />
      </div>
      <div className={styles.title}>Binary file</div>
      <div className={styles.note}>
        This file ({formatBytes(sizeBytes)}) isn't text — Maestro can't render it in the editor.
      </div>
    </div>
  );
}
