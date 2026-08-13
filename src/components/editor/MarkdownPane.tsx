import { useEffect, useMemo, useReducer, useState } from "react";
import DOMPurify from "dompurify";
import { marked } from "marked";
import { FileText } from "@phosphor-icons/react";
import { fsApi } from "../../api/fs";
import { useOpenFilesStore } from "../../state/openFilesStore";
import { getModel } from "../../editor/monacoModelRegistry";
import type { Tab } from "../../state/tabsStore";
import styles from "./MarkdownPane.module.css";

/** Renders the Source/Preview toggle header for a markdown tab, plus the
 * Preview body when that mode is active. Source mode intentionally renders
 * nothing in its body — `MonacoHost` (mounted once at `MainContent` level)
 * shows through underneath, since it self-hides via `display:none` in
 * every mode except file/markdown-source (see MonacoHost.tsx). */
export function MarkdownPane({ tab }: { tab: Tab }) {
  const mode = useOpenFilesStore((s) => s.byTabId[tab.id]?.markdownMode ?? "preview");
  const setMarkdownMode = useOpenFilesStore((s) => s.setMarkdownMode);
  const [fetchedContent, setFetchedContent] = useState<string | null>(null);
  // Bumped by the Monaco model's own change subscription below so a live
  // buffer (unsaved edits in Source mode) is reflected in Preview without
  // re-fetching from disk. `.getValue()` itself is read directly during
  // render — a pure, synchronous read of already-existing external state,
  // not something that needs an effect.
  const [, forceRerender] = useReducer((c: number) => c + 1, 0);

  const liveModel = mode === "preview" ? getModel(tab.id) : undefined;

  useEffect(() => {
    if (!liveModel) return;
    const sub = liveModel.onDidChangeContent(forceRerender);
    return () => sub.dispose();
  }, [liveModel]);

  useEffect(() => {
    if (mode !== "preview" || liveModel || !tab.worktreeRoot || !tab.filePath) return;
    let cancelled = false;
    void fsApi.readFile(tab.worktreeRoot, tab.filePath).then((result) => {
      if (!cancelled && result.kind === "text") setFetchedContent(result.content);
    });
    return () => {
      cancelled = true;
    };
  }, [mode, tab.id, tab.worktreeRoot, tab.filePath, liveModel]);

  const content = liveModel ? liveModel.getValue() : fetchedContent;

  const html = useMemo(() => {
    if (content == null) return "";
    return DOMPurify.sanitize(marked.parse(content, { async: false }) as string);
  }, [content]);

  return (
    <>
      <div className={styles.header}>
        <span className={styles.headerTitle}>
          <FileText size={14} color="var(--accent-2)" />
          {tab.title}
        </span>
        <div className={styles.toggle}>
          <button
            type="button"
            className={styles.pill}
            data-active={mode === "source"}
            onClick={() => setMarkdownMode(tab.id, "source")}
          >
            Source
          </button>
          <button
            type="button"
            className={styles.pill}
            data-active={mode === "preview"}
            onClick={() => setMarkdownMode(tab.id, "preview")}
          >
            Preview
          </button>
        </div>
      </div>
      {mode === "preview" && (
        <div className={styles.previewScroller}>
          <div className={styles.previewBody} dangerouslySetInnerHTML={{ __html: html }} />
        </div>
      )}
    </>
  );
}
