import { useEffect, useRef } from "react";
import * as monaco from "monaco-editor/editor/editor.api";
import { useTabsStore } from "../../state/tabsStore";
import { useOpenFilesStore } from "../../state/openFilesStore";
import { useFileLoadStore } from "../../state/fileLoadStore";
import { useExplorerStore } from "../../state/explorerStore";
import { useUiStore } from "../../state/uiStore";
import { useSearchStore } from "../../state/searchStore";
import { useEditorNavigationStore } from "../../state/editorNavigationStore";
import { fsApi } from "../../api/fs";
import { getModel, getOrCreateModel } from "../../editor/monacoModelRegistry";
import { saveFileTab } from "../../editor/saveFile";
import styles from "./MonacoHost.module.css";

const LARGE_FILE_BYTES = 2 * 1024 * 1024;
const AUTO_SAVE_DELAY_MS = 800;

const MONACO_FONT_FAMILY =
  "'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";
const BASE_FONT_SIZE = 13;

/** One Monaco instance per pane — mounted lazily (see `PaneView.tsx`) the
 * first time that pane shows a file/markdown-source tab, then kept alive
 * as a persistent, CSS-display-toggled sibling so switching tabs *within
 * the pane* calls `setModel()`/`restoreViewState()` against this editor
 * instead of re-paying Monaco's init cost on every click.
 *
 * Was a single app-wide instance driven by the global active tab until
 * splits landed (docs/V2_ROADMAP.md Phase 13) — two panes can show two
 * files at once, which one editor cannot do. Text models are still shared
 * app-wide through `monacoModelRegistry`, so the per-pane cost is the
 * editor view, not a second copy of any file. */
export function MonacoHost({ tabId }: { tabId: string | null }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const viewStates = useRef(new Map<string, monaco.editor.ICodeEditorViewState | null>());
  const loadedTabIdRef = useRef<string | null>(null);
  const autoSaveTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>());

  const tabs = useTabsStore((s) => s.tabs);
  const activeTab = tabId ? tabs.find((t) => t.id === tabId) : undefined;

  const markdownMode = useOpenFilesStore((s) =>
    activeTab ? (s.byTabId[activeTab.id]?.markdownMode ?? "preview") : "preview",
  );
  const registerLoaded = useOpenFilesStore((s) => s.registerLoaded);
  const setDirty = useOpenFilesStore((s) => s.setDirty);
  const setLoadState = useFileLoadStore((s) => s.setState);
  const worktreeId = useExplorerStore((s) => s.worktreeId);

  const zoom = useUiStore((s) => s.zoom);
  const leftSidebarWidth = useUiStore((s) => s.leftSidebarWidth);
  const rightSidebarWidth = useUiStore((s) => s.rightSidebarWidth);
  const leftSidebarOpen = useUiStore((s) => s.leftSidebarOpen);
  const rightSidebarOpen = useUiStore((s) => s.rightSidebarOpen);

  const loadState = useFileLoadStore((s) => (activeTab ? s.byTabId[activeTab.id] : undefined));
  const isNonTextKind =
    loadState?.kind === "binary" || loadState?.kind === "tooLarge" || loadState?.kind === "error";

  const isTarget =
    !!activeTab &&
    (activeTab.type === "file" || (activeTab.type === "markdown" && markdownMode === "source")) &&
    !isNonTextKind;

  // Create the editor once, dispose on unmount (only happens app-wide).
  useEffect(() => {
    if (!containerRef.current) return;
    const editor = monaco.editor.create(containerRef.current, {
      automaticLayout: false,
      theme: "vs-dark",
      fontFamily: MONACO_FONT_FAMILY,
      fontSize: BASE_FONT_SIZE,
      // Minimap painting is disproportionately expensive in WebKitGTK and
      // duplicates the scrollbar for navigation. Keep the primary editing
      // surface responsive; this can return later as an opt-in preference.
      minimap: { enabled: false },
      // WebKitGTK can retain enormous compositor surfaces for Monaco's
      // promoted text/margin layers. Monaco exposes this specifically for
      // browsers where layer hinting causes high GPU memory usage.
      disableLayerHinting: true,
      scrollBeyondLastLine: false,
    });
    editorRef.current = editor;
    const timers = autoSaveTimers.current;
    let layoutFrame: number | null = null;
    const scheduleLayout = () => {
      if (layoutFrame != null) cancelAnimationFrame(layoutFrame);
      layoutFrame = requestAnimationFrame(() => {
        layoutFrame = null;
        editor.layout();
      });
    };
    window.addEventListener("resize", scheduleLayout);
    // A pane resize (dragging a splitter, collapsing a split) doesn't
    // fire a window resize, and Monaco's own `automaticLayout` is off
    // because it polls. Observing the container covers both the window
    // and the pane, at no idle cost.
    const observer = new ResizeObserver(scheduleLayout);
    observer.observe(containerRef.current);
    scheduleLayout();

    const changeSub = editor.onDidChangeModelContent(() => {
      const tabId = loadedTabIdRef.current;
      if (!tabId) return;
      setDirty(tabId, true);

      const pending = timers.get(tabId);
      if (pending) clearTimeout(pending);
      if (!useUiStore.getState().autoSaveEnabled) return;

      timers.set(
        tabId,
        setTimeout(() => {
          timers.delete(tabId);
          const tab = useTabsStore.getState().tabs.find((t) => t.id === tabId);
          if (!tab || (tab.type !== "file" && tab.type !== "markdown")) return;
          if (!tab.worktreeRoot || !tab.filePath) return;
          if (!useOpenFilesStore.getState().byTabId[tabId]?.dirty) return;

          void saveFileTab(tabId, tab.worktreeRoot, tab.filePath).catch(() => {
            useOpenFilesStore.getState().setExternalChangePending(tabId, true);
          });
        }, AUTO_SAVE_DELAY_MS),
      );
    });

    return () => {
      changeSub.dispose();
      observer.disconnect();
      window.removeEventListener("resize", scheduleLayout);
      if (layoutFrame != null) cancelAnimationFrame(layoutFrame);
      editor.dispose();
      editorRef.current = null;
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // App-level zoom (Cmd/Ctrl +/-) scales the whole rem-based UI via
  // --zoom, but Monaco manages its own canvas-rendered font size — it
  // never picks that up on its own, so mirror it explicitly here.
  useEffect(() => {
    const editor = editorRef.current;
    editor?.updateOptions({ fontSize: Math.round(BASE_FONT_SIZE * zoom) });
    editor?.layout();
  }, [zoom, leftSidebarWidth, rightSidebarWidth, leftSidebarOpen, rightSidebarOpen]);

  // Attach the right model whenever the visible target tab changes.
  useEffect(() => {
    const editor = editorRef.current;
    if (!editor) return;

    const prevTabId = loadedTabIdRef.current;
    if (prevTabId) viewStates.current.set(prevTabId, editor.saveViewState());

    const modelWorktreeId = activeTab?.worktreeId ?? worktreeId;
    if (!isTarget || !activeTab?.filePath || !activeTab.worktreeRoot || !modelWorktreeId) {
      editor.setModel(null);
      loadedTabIdRef.current = null;
      return;
    }

    const tabId = activeTab.id;
    const { filePath, worktreeRoot } = activeTab;

    function attach(model: monaco.editor.ITextModel, isLarge: boolean) {
      editor?.updateOptions({
        minimap: { enabled: false },
        folding: !isLarge,
        wordWrap: isLarge ? "off" : "on",
      });
      editor?.setModel(model);
      editor?.layout();
      const saved = viewStates.current.get(tabId);
      if (saved) editor?.restoreViewState(saved);

      // A pending "jump to this match" from the Search panel (see
      // searchStore.ts's `reveal`) — consumed once, here, since this is
      // the point a tab's model actually becomes visible in the editor.
      const pendingReveal = useSearchStore.getState().pendingReveal;
      if (pendingReveal?.tabId === tabId) {
        const { line, matchStart, matchEnd } = pendingReveal;
        const selection = {
          startLineNumber: line,
          startColumn: matchStart + 1,
          endLineNumber: line,
          endColumn: matchEnd + 1,
        };
        editor?.revealLineInCenter(line);
        editor?.setSelection(selection);
        useSearchStore.getState().clearPendingReveal();
      }

      const pendingNavigation = useEditorNavigationStore.getState().consume(tabId);
      if (pendingNavigation?.selection) {
        const selection = pendingNavigation.selection;
        const line = "lineNumber" in selection ? selection.lineNumber : selection.startLineNumber;
        editor?.revealLineInCenter(line);
        editor?.setSelection(
          "lineNumber" in selection
            ? new monaco.Selection(
                selection.lineNumber,
                selection.column,
                selection.lineNumber,
                selection.column,
              )
            : selection,
        );
      }

      editor?.focus();
      loadedTabIdRef.current = tabId;
      setLoadState(tabId, { kind: "text" });
    }

    const existing = getModel(tabId);
    if (existing) {
      attach(existing, existing.getValueLength() > LARGE_FILE_BYTES);
      return;
    }

    let cancelled = false;
    setLoadState(tabId, { kind: "loading" });
    void fsApi
      .readFile(worktreeRoot, filePath)
      .then((result) => {
        if (cancelled) return;
        if (result.kind === "binary") {
          setLoadState(tabId, { kind: "binary", sizeBytes: result.sizeBytes });
          return;
        }
        if (result.kind === "tooLarge") {
          setLoadState(tabId, { kind: "tooLarge", sizeBytes: result.sizeBytes });
          return;
        }
        const isLarge = result.sizeBytes > LARGE_FILE_BYTES;
        const model = getOrCreateModel(
          tabId,
          modelWorktreeId,
          worktreeRoot,
          filePath,
          result.content,
          isLarge,
        );
        attach(model, isLarge);
        registerLoaded(tabId, result.mtimeMs);
      })
      .catch((error: unknown) => {
        if (!cancelled) setLoadState(tabId, { kind: "error", message: String(error) });
      });

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab?.id, isTarget]);

  return (
    <div
      ref={containerRef}
      className={styles.host}
      style={{ display: isTarget ? "block" : "none" }}
    />
  );
}
