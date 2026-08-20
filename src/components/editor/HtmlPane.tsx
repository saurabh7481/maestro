import { useEffect, useReducer, useState } from "react";
import { Code } from "@phosphor-icons/react";
import { fsApi } from "../../api/fs";
import { useOpenFilesStore } from "../../state/openFilesStore";
import { getEditorModel } from "../../editor/modelBridge";
import type { Tab } from "../../state/tabsStore";
import styles from "./HtmlPane.module.css";

/** Same Source/Preview toggle shape as `MarkdownPane.tsx` (see that file's
 * comment for the header/self-hiding-`MonacoHost` mechanics, which this
 * shares verbatim) — the one real difference is what Preview renders.
 *
 * Markdown's preview is sanitized (DOMPurify) HTML from a trusted
 * renderer, safe to inject directly. This file's *own content* is
 * arbitrary HTML — routinely agent-generated, and Maestro has no way to
 * know it doesn't carry a `<script>` — so it renders inside a sandboxed
 * `<iframe srcdoc>` instead of `dangerouslySetInnerHTML`. `srcdoc` gives
 * the content an opaque (`null`) origin with no access to this app's DOM,
 * storage, or Tauri APIs; `sandbox="allow-scripts"` lets scripts that
 * exist in the file actually run (the point of previewing HTML, not just
 * text) while omitting `allow-same-origin` (nothing to gain here, and the
 * combination is the one that lets sandboxed script reach for real
 * privileges elsewhere), `allow-top-navigation` (so a link/script inside
 * can't do what a plain chat link already did once — see
 * `design/renderMarkdown.ts`'s `interceptMarkdownLinkClicks` comment —
 * and hijack the whole app window), and `allow-popups`. */
export function HtmlPane({ tab }: { tab: Tab }) {
  const mode = useOpenFilesStore((s) => s.byTabId[tab.id]?.previewMode ?? "preview");
  const setPreviewMode = useOpenFilesStore((s) => s.setPreviewMode);
  const [fetchedContent, setFetchedContent] = useState<string | null>(null);
  const [, forceRerender] = useReducer((c: number) => c + 1, 0);

  const rawLiveModel = mode === "preview" ? getEditorModel(tab.id) : undefined;
  const liveModel = rawLiveModel && !rawLiveModel.isDisposed() ? rawLiveModel : undefined;

  useEffect(() => {
    if (!liveModel) return;
    const sub = liveModel.onDidChangeContent(forceRerender);
    return () => {
      if (!liveModel.isDisposed()) sub.dispose();
    };
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

  return (
    <>
      <div className={styles.header}>
        <span className={styles.headerTitle}>
          <Code size={14} color="var(--accent-2)" />
          {tab.title}
        </span>
        <div className={styles.toggle}>
          <button
            type="button"
            className={styles.pill}
            data-active={mode === "source"}
            onClick={() => setPreviewMode(tab.id, "source")}
          >
            Source
          </button>
          <button
            type="button"
            className={styles.pill}
            data-active={mode === "preview"}
            onClick={() => setPreviewMode(tab.id, "preview")}
          >
            Preview
          </button>
        </div>
      </div>
      {mode === "preview" && (
        <div className={styles.previewScroller}>
          {content != null && (
            <iframe
              className={styles.frame}
              title={tab.title}
              sandbox="allow-scripts"
              srcDoc={content}
            />
          )}
        </div>
      )}
    </>
  );
}
