import { useEffect, useRef } from "react";
import * as monaco from "monaco-editor";
import { useTabsStore } from "../../state/tabsStore";
import { useOpenFilesStore } from "../../state/openFilesStore";
import { useFileLoadStore } from "../../state/fileLoadStore";
import { useExplorerStore } from "../../state/explorerStore";
import { useUiStore } from "../../state/uiStore";
import { useSearchStore } from "../../state/searchStore";
import { fsApi } from "../../api/fs";
import { listenToFsEvents } from "../../api/fsEvents";
import { getModel, getOrCreateModel } from "../../editor/monacoModelRegistry";
import { saveFileTab } from "../../editor/saveFile";
import styles from "./MonacoHost.module.css";

const LARGE_FILE_BYTES = 2 * 1024 * 1024;
const AUTO_SAVE_DELAY_MS = 800;

const MONACO_FONT_FAMILY =
  "'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";
const BASE_FONT_SIZE = 13;

/** The one Monaco instance for the whole app session — mounted lazily
 * (see MainContent.tsx) on first file/markdown-source tab open, then kept
 * alive as a persistent, CSS-display-toggled sibling so switching tabs
 * calls `setModel()`/`restoreViewState()` against this shared editor
 * instead of re-paying Monaco's init cost on every click. */
export function MonacoHost() {
  const containerRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const viewStates = useRef(new Map<string, monaco.editor.ICodeEditorViewState | null>());
  const loadedTabIdRef = useRef<string | null>(null);
  const autoSaveTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>());

  const tabs = useTabsStore((s) => s.tabs);
  const activeTabId = useTabsStore((s) => s.activeTabId);
  const activeTab = tabs.find((t) => t.id === activeTabId);

  const markdownMode = useOpenFilesStore((s) =>
    activeTab ? (s.byTabId[activeTab.id]?.markdownMode ?? "preview") : "preview",
  );
  const registerLoaded = useOpenFilesStore((s) => s.registerLoaded);
  const setDirty = useOpenFilesStore((s) => s.setDirty);
  const setExternalChangePending = useOpenFilesStore((s) => s.setExternalChangePending);
  const setLoadState = useFileLoadStore((s) => s.setState);
  const worktreeId = useExplorerStore((s) => s.worktreeId);

  const zoom = useUiStore((s) => s.zoom);

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
      automaticLayout: true,
      theme: "vs-dark",
      fontFamily: MONACO_FONT_FAMILY,
      fontSize: BASE_FONT_SIZE,
      minimap: { enabled: true },
      scrollBeyondLastLine: false,
    });
    editorRef.current = editor;
    const timers = autoSaveTimers.current;

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
    editorRef.current?.updateOptions({ fontSize: Math.round(BASE_FONT_SIZE * zoom) });
  }, [zoom]);

  // Attach the right model whenever the visible target tab changes.
  useEffect(() => {
    const editor = editorRef.current;
    if (!editor) return;

    const prevTabId = loadedTabIdRef.current;
    if (prevTabId) viewStates.current.set(prevTabId, editor.saveViewState());

    if (!isTarget || !activeTab?.filePath || !activeTab.worktreeRoot) {
      editor.setModel(null);
      loadedTabIdRef.current = null;
      return;
    }

    const tabId = activeTab.id;
    const { filePath, worktreeRoot } = activeTab;

    function attach(model: monaco.editor.ITextModel, isLarge: boolean) {
      editor?.updateOptions({
        minimap: { enabled: !isLarge },
        folding: !isLarge,
        wordWrap: isLarge ? "off" : "on",
      });
      editor?.setModel(model);
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
        const model = getOrCreateModel(tabId, filePath, result.content, isLarge);
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

  // External-change detection: only re-stats files that are actually
  // loaded into a Monaco model (unopened tabs fetch fresh on open anyway,
  // nothing to go stale) and only flags a real mtime mismatch — this is
  // what suppresses the false-positive from the watcher echoing our own
  // save, since `registerLoaded`/`registerSaved` already updated the
  // recorded mtime by the time that echo arrives.
  useEffect(() => {
    if (!worktreeId) return;
    const unlistenPromise = listenToFsEvents(worktreeId, (event) => {
      // Defensive: a malformed/partial event should skip this pass, not
      // crash the whole renderer (see `api/fsEvents.ts`).
      if (!event?.touchedPaths) return;
      for (const touched of event.touchedPaths) {
        const tab = tabs.find(
          (t) => (t.type === "file" || t.type === "markdown") && t.filePath === touched,
        );
        if (!tab || !getModel(tab.id) || !tab.worktreeRoot) continue;

        void fsApi.readFile(tab.worktreeRoot, touched).then((result) => {
          if (result.kind !== "text") return;
          const recordedMtime = useOpenFilesStore.getState().byTabId[tab.id]?.diskMtimeMs;
          if (recordedMtime != null && result.mtimeMs !== recordedMtime) {
            setExternalChangePending(tab.id, true);
          }
        });
      }
    });
    return () => {
      void unlistenPromise.then((unlisten) => unlisten());
    };
  }, [worktreeId, tabs, setExternalChangePending]);

  return (
    <div
      ref={containerRef}
      className={styles.host}
      style={{ display: isTarget ? "block" : "none" }}
    />
  );
}
