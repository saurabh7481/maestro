import { FileDashed } from "@phosphor-icons/react";
import { formatBytes } from "../../editor/formatBytes";
import styles from "./PlaceholderView.module.css";

export function TooLargeFileView({ sizeBytes }: { sizeBytes: number }) {
  return (
    <div className={styles.wrap}>
      <div className={styles.icon}>
        <FileDashed size={26} color="var(--text-mute)" />
      </div>
      <div className={styles.title}>File too large</div>
      <div className={styles.note}>
        This file is {formatBytes(sizeBytes)} — too large to open in the editor safely.
      </div>
    </div>
  );
}
