import { ArrowClockwise, Warning, X } from "@phosphor-icons/react";
import { fsApi } from "../../api/fs";
import { useOpenFilesStore } from "../../state/openFilesStore";
import { getEditorModel } from "../../editor/modelBridge";
import { Button } from "../primitives";
import styles from "./ExternalChangeBanner.module.css";

interface ExternalChangeBannerProps {
  tabId: string;
  worktreeRoot: string;
  filePath: string;
}

/** Shown per-tab, only while that tab is actually being viewed — a watcher
 * event can fire for a file the user isn't looking at, so this stays a
 * scoped banner rather than a modal that would need to queue across tabs. */
export function ExternalChangeBanner({ tabId, worktreeRoot, filePath }: ExternalChangeBannerProps) {
  const registerLoaded = useOpenFilesStore((s) => s.registerLoaded);
  const acknowledgeExternalChange = useOpenFilesStore((s) => s.acknowledgeExternalChange);

  async function reload() {
    const result = await fsApi.readFile(worktreeRoot, filePath);
    if (result.kind !== "text") return;
    getEditorModel(tabId)?.setValue(result.content);
    registerLoaded(tabId, result.mtimeMs);
  }

  async function keepMine() {
    const result = await fsApi.readFile(worktreeRoot, filePath);
    if (result.kind !== "text") return;
    acknowledgeExternalChange(tabId, result.mtimeMs);
  }

  return (
    <div className={styles.banner}>
      <Warning size={16} color="var(--yellow)" />
      <span>This file changed on disk.</span>
      <div className={styles.actions}>
        <Button variant="secondary" onClick={() => void reload()}>
          <ArrowClockwise size={14} />
          Reload
        </Button>
        <Button variant="ghost" onClick={() => void keepMine()}>
          <X size={14} />
          Keep mine
        </Button>
      </div>
    </div>
  );
}
