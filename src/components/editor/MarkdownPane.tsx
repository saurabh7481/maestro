import { useEffect, useLayoutEffect, useReducer, useRef, useState } from "react";
import { FileText } from "@phosphor-icons/react";
import { fsApi } from "../../api/fs";
import {
  recallPreviewScroll,
  rememberPreviewScroll,
  useOpenFilesStore,
} from "../../state/openFilesStore";
import { getEditorModel } from "../../editor/modelBridge";
import { useMarkdownHtml } from "../../design/renderMarkdown";
import type { Tab } from "../../state/tabsStore";
import styles from "./MarkdownPane.module.css";

/** Renders the Source/Preview toggle header for a markdown tab, plus the
 * Preview body when that mode is active. Source mode intentionally renders
 * nothing in its body — the pane's `MonacoHost` takes the space below the
 * header instead, since it self-hides via `display:none` in every mode
 * except file/markdown-source (see MonacoHost.tsx). Both this header and
 * that editor are flex children of the pane's content column, so the
 * header stays visible and clickable in either mode; `PaneView` renders
 * this component first to keep it on top. */
export function MarkdownPane({ tab }: { tab: Tab }) {
  const mode = useOpenFilesStore((s) => s.byTabId[tab.id]?.previewMode ?? "preview");
  const setPreviewMode = useOpenFilesStore((s) => s.setPreviewMode);
  const [fetchedContent, setFetchedContent] = useState<string | null>(null);
  // Bumped by the Monaco model's own change subscription below so a live
  // buffer (unsaved edits in Source mode) is reflected in Preview without
  // re-fetching from disk. `.getValue()` itself is read directly during
  // render — a pure, synchronous read of already-existing external state,
  // not something that needs an effect.
  const [, forceRerender] = useReducer((c: number) => c + 1, 0);

  // `getModel()` can hand back a model the LRU registry is about to evict
  // (see `monacoModelRegistry.ts`) — guarding with `isDisposed()` here
  // means a stale/disposed reference falls back to `fetchedContent`
  // instead of a `.getValue()` call throwing during render.
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

  // `null` only for the one chunk-load on the session's first markdown
  // render (see `renderMarkdown.ts`); an empty preview body for that
  // moment is preferable to a flash of unformatted source here, since a
  // whole file's worth of raw markdown would be a much bigger reflow than
  // a single chat message.
  const html = useMarkdownHtml(content) ?? "";

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
      {mode === "preview" && <PreviewBody tabId={tab.id} html={html} />}
    </>
  );
}

/** The scrolling preview itself. Split out so the scroll-restore state
 * below belongs to one *mounting* of the preview: `MarkdownPane` survives a
 * Source/Preview toggle, this does not. */
function PreviewBody({ tabId, html }: { tabId: string; html: string }) {
  const scrollerRef = useRef<HTMLDivElement>(null);
  /** Whether this mounting has already put the reader back where they
   * were. Also gates the scroll handler — see below. */
  const restoredRef = useRef(false);

  // `PaneView` renders only its active tab's body, so switching tabs
  // unmounts a markdown tab outright and coming back rebuilds this
  // scroller at the top — the reader lost their place in a long file on
  // every switch. Source mode never had the problem, since Monaco keeps
  // its own per-tab view state; this is Preview's equivalent.
  //
  // It can't be a one-shot on mount. The content arrives after a
  // `readFile` round-trip (and, for the first markdown in a session, after
  // the renderer chunk lands), and anything inside it that loads — an
  // image — settles later still. At every one of those moments the
  // scroller is too short to hold the offset, and assigning `scrollTop`
  // would just clamp to the bottom of whatever exists so far. So the
  // restore re-runs on each render that changes the HTML *and* on the
  // height changes a render doesn't announce, and only commits once the
  // content is genuinely tall enough.
  useLayoutEffect(() => {
    const scroller = scrollerRef.current;
    if (!scroller || restoredRef.current) return;
    const target = recallPreviewScroll(tabId);
    if (target === 0) {
      restoredRef.current = true;
      return;
    }
    const restore = () => {
      if (restoredRef.current) return;
      if (scroller.scrollHeight - scroller.clientHeight < target) return;
      scroller.scrollTop = target;
      restoredRef.current = true;
      observer.disconnect();
    };
    const observer = new ResizeObserver(restore);
    observer.observe(scroller);
    if (scroller.firstElementChild) observer.observe(scroller.firstElementChild);
    restore();
    return () => observer.disconnect();
  }, [tabId, html]);

  return (
    <div
      className={styles.previewScroller}
      ref={scrollerRef}
      // Gated on the restore having happened: a freshly mounted, still-empty
      // scroller reports 0, and recording that would erase the very offset
      // the effect above is waiting to restore.
      onScroll={(event) => {
        if (restoredRef.current) rememberPreviewScroll(tabId, event.currentTarget.scrollTop);
      }}
    >
      <div className={styles.previewBody} dangerouslySetInnerHTML={{ __html: html }} />
    </div>
  );
}
