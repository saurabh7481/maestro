import { useEffect, useRef, useState } from "react";
import * as monaco from "monaco-editor/editor/editor.api";
import { useTabsStore } from "../../state/tabsStore";
import { useOpenFilesStore } from "../../state/openFilesStore";
import { useFileLoadStore } from "../../state/fileLoadStore";
import { useExplorerStore } from "../../state/explorerStore";
import { useUiStore } from "../../state/uiStore";
import { useSearchStore } from "../../state/searchStore";
import { useEditorNavigationStore } from "../../state/editorNavigationStore";
import { fsApi } from "../../api/fs";
import { gitApi } from "../../api/git";
import { getModel, getOrCreateModel } from "../../editor/monacoModelRegistry";
import { saveFileTab } from "../../editor/saveFile";
import { lspClientManager } from "../../lsp/clientManager";
import { documentSymbols } from "../../lsp/providers";
import { relativeTime } from "../../design/relativeTime";
import { buildCodeFontFamily } from "../../design/codeFonts";
import { EDITOR_THEME_NAME, applyEditorTheme } from "../../editor/editorTheme";
import type { BlameLine } from "../../types/git";
import { EditorBreadcrumb } from "./EditorBreadcrumb";
import styles from "./MonacoHost.module.css";

const SYMBOL_REFRESH_DELAY_MS = 600;
const UNCOMMITTED_HASH = "0000000000000000000000000000000000000000";

const LARGE_FILE_BYTES = 2 * 1024 * 1024;
const AUTO_SAVE_DELAY_MS = 800;

function blameLabel(info: BlameLine): string {
  if (info.hash === UNCOMMITTED_HASH) return "Uncommitted changes";
  const when = relativeTime(new Date(info.authorTime * 1000).toISOString());
  return info.summary ? `${info.author}, ${when} · ${info.summary}` : `${info.author}, ${when}`;
}

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
  const symbolRefreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Blame data for the whole file, keyed by line — cheap to hold in full
  // (one `git blame` per file open/save) so a cursor move only needs a
  // map lookup, not a fetch. `blameDecorations` renders just the
  // cursor's current line, GitLens-style, not the whole file at once.
  const blameByLine = useRef<Map<number, BlameLine>>(new Map());
  const blameDecorations = useRef<monaco.editor.IEditorDecorationsCollection | null>(null);

  // Breadcrumb state: the active model's outline (refetched on model
  // switch and, debounced, on edits) and where the cursor currently sits
  // within it. Lives here rather than in a store since it's purely this
  // pane's editor's own live state, same rationale as `editorRef` itself.
  const [symbols, setSymbols] = useState<monaco.languages.DocumentSymbol[]>([]);
  const [cursorPosition, setCursorPosition] = useState<monaco.Position | null>(null);

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

  // Fetches this model's outline for the breadcrumb, straight off the
  // same `lspClientManager` router `lsp/providers.ts` uses internally for
  // Monaco's own `documentSymbolProvider` — going through the LSP client
  // directly rather than Monaco's provider API, since Monaco doesn't
  // expose "run the registered providers and give me the result" as a
  // public call. Guarded on `forTabId` staying the loaded tab: a slow LSP
  // response arriving after the user has already switched tabs (or away
  // from a target tab entirely) must not paint a stale outline.
  function refreshSymbols(forTabId: string, model: monaco.editor.ITextModel) {
    if (!lspClientManager.capability(model, "textDocument/documentSymbol")) {
      setSymbols([]);
      return;
    }
    const cts = new monaco.CancellationTokenSource();
    void lspClientManager
      .request<unknown[]>(
        model,
        "textDocument/documentSymbol",
        { textDocument: { uri: model.uri.toString() } },
        cts.token,
      )
      .then((result) => {
        if (loadedTabIdRef.current !== forTabId) return;
        setSymbols(documentSymbols(result ?? [], model.uri.toString()));
      })
      .catch(() => {
        if (loadedTabIdRef.current === forTabId) setSymbols([]);
      });
  }

  // Paints (or clears) the current-line blame annotation as inline
  // "ghost" text after the line's last column — only the cursor's line,
  // not the whole file, both to stay cheap and to avoid the visual noise
  // of every single line getting an attribution.
  function renderBlameForLine(line: number | null) {
    const editor = editorRef.current;
    const collection = blameDecorations.current;
    if (!editor || !collection) return;
    const info = line != null ? blameByLine.current.get(line) : undefined;
    if (!useUiStore.getState().gitBlameEnabled || !info) {
      collection.set([]);
      return;
    }
    const model = editor.getModel();
    if (!model || line == null) return;
    const column = model.getLineMaxColumn(line);
    collection.set([
      {
        range: new monaco.Range(line, column, line, column),
        options: {
          after: { content: `  ${blameLabel(info)}`, inlineClassName: styles.blameAnnotation },
          showIfCollapsed: false,
        },
      },
    ]);
  }

  // One `git blame` per file open, plus once more (debounced) per edit
  // settling — not per keystroke, and not per cursor move (`blameByLine`
  // already has the full map by then; moving the cursor is just a
  // lookup via `renderBlameForLine`). Guarded on `forTabId` the same way
  // `refreshSymbols` is: a slow response after switching tabs away must
  // not paint blame for a file that isn't showing anymore.
  function refreshBlame(forTabId: string, worktreeRoot: string, relPath: string) {
    if (!useUiStore.getState().gitBlameEnabled) return;
    void gitApi
      .getBlame(worktreeRoot, relPath)
      .then((lines) => {
        if (loadedTabIdRef.current !== forTabId) return;
        blameByLine.current = new Map(lines.map((l) => [l.line, l]));
        renderBlameForLine(editorRef.current?.getPosition()?.lineNumber ?? null);
      })
      .catch(() => {
        if (loadedTabIdRef.current === forTabId) blameByLine.current = new Map();
      });
  }

  // Create the editor once, dispose on unmount (only happens app-wide).
  useEffect(() => {
    if (!containerRef.current) return;
    const prefs = useUiStore.getState();
    applyEditorTheme(monaco, prefs.editorBackgroundColor);
    const editor = monaco.editor.create(containerRef.current, {
      automaticLayout: false,
      theme: EDITOR_THEME_NAME,
      fontFamily: buildCodeFontFamily(prefs.editorFontFamily),
      fontSize: prefs.editorFontSize,
      // Minimap painting is disproportionately expensive in WebKitGTK,
      // hence off by default — Settings → Editor → Minimap opts back in.
      minimap: { enabled: prefs.minimapEnabled },
      wordWrap: prefs.wordWrapEnabled ? "on" : "off",
      // WebKitGTK can retain enormous compositor surfaces for Monaco's
      // promoted text/margin layers. Monaco exposes this specifically for
      // browsers where layer hinting causes high GPU memory usage.
      disableLayerHinting: true,
      scrollBeyondLastLine: false,
    });
    editorRef.current = editor;
    blameDecorations.current = editor.createDecorationsCollection();
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

    const cursorSub = editor.onDidChangeCursorPosition((e) => {
      setCursorPosition(e.position);
      renderBlameForLine(e.position.lineNumber);
    });

    const changeSub = editor.onDidChangeModelContent(() => {
      const tabId = loadedTabIdRef.current;
      if (!tabId) return;
      setDirty(tabId, true);

      if (symbolRefreshTimer.current) clearTimeout(symbolRefreshTimer.current);
      symbolRefreshTimer.current = setTimeout(() => {
        symbolRefreshTimer.current = null;
        const model = editor.getModel();
        if (model && loadedTabIdRef.current === tabId) refreshSymbols(tabId, model);
        const tab = useTabsStore.getState().tabs.find((t) => t.id === tabId);
        if (tab?.worktreeRoot && tab?.filePath && loadedTabIdRef.current === tabId) {
          refreshBlame(tabId, tab.worktreeRoot, tab.filePath);
        }
      }, SYMBOL_REFRESH_DELAY_MS);

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
      cursorSub.dispose();
      observer.disconnect();
      window.removeEventListener("resize", scheduleLayout);
      if (layoutFrame != null) cancelAnimationFrame(layoutFrame);
      if (symbolRefreshTimer.current) clearTimeout(symbolRefreshTimer.current);
      editor.dispose();
      editorRef.current = null;
      blameDecorations.current = null;
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const editorFontSize = useUiStore((s) => s.editorFontSize);

  // App-level zoom (Cmd/Ctrl +/-) scales the whole rem-based UI via
  // --zoom, but Monaco manages its own canvas-rendered font size — it
  // never picks that up on its own, so mirror it explicitly here.
  useEffect(() => {
    const editor = editorRef.current;
    editor?.updateOptions({ fontSize: Math.round(editorFontSize * zoom) });
    editor?.layout();
  }, [
    zoom,
    editorFontSize,
    leftSidebarWidth,
    rightSidebarWidth,
    leftSidebarOpen,
    rightSidebarOpen,
  ]);

  const editorFontFamily = useUiStore((s) => s.editorFontFamily);
  useEffect(() => {
    const editor = editorRef.current;
    editor?.updateOptions({ fontFamily: buildCodeFontFamily(editorFontFamily) });
    editor?.layout();
  }, [editorFontFamily]);

  const editorBackgroundColor = useUiStore((s) => s.editorBackgroundColor);
  useEffect(() => {
    if (!editorRef.current) return;
    applyEditorTheme(monaco, editorBackgroundColor);
  }, [editorBackgroundColor]);

  const minimapEnabled = useUiStore((s) => s.minimapEnabled);
  useEffect(() => {
    editorRef.current?.updateOptions({ minimap: { enabled: minimapEnabled } });
  }, [minimapEnabled]);

  const wordWrapEnabled = useUiStore((s) => s.wordWrapEnabled);
  useEffect(() => {
    editorRef.current?.updateOptions({ wordWrap: wordWrapEnabled ? "on" : "off" });
  }, [wordWrapEnabled]);

  const gitBlameEnabled = useUiStore((s) => s.gitBlameEnabled);
  useEffect(() => {
    if (!gitBlameEnabled) {
      blameDecorations.current?.set([]);
      return;
    }
    // Turned back on for an already-open tab that never fetched (it was
    // off at attach time) — fetch now rather than waiting for the next
    // edit or tab switch to happen to trigger it.
    const tabId = loadedTabIdRef.current;
    const tab = tabId ? useTabsStore.getState().tabs.find((t) => t.id === tabId) : undefined;
    if (tabId && tab?.worktreeRoot && tab?.filePath) {
      if (blameByLine.current.size > 0) {
        renderBlameForLine(editorRef.current?.getPosition()?.lineNumber ?? null);
      } else {
        refreshBlame(tabId, tab.worktreeRoot, tab.filePath);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gitBlameEnabled]);

  // A pending "jump to this match" from the Search panel (see
  // searchStore.ts's `reveal`) targeting a tab this pane already has
  // loaded — applied straight to the live editor, since the tab-attach
  // effect below only re-runs when `activeTab.id` *changes* and so never
  // fires for a second match clicked within the same already-open file.
  function applyPendingReveal(tabId: string) {
    const editor = editorRef.current;
    const pendingReveal = useSearchStore.getState().pendingReveal;
    if (!editor || pendingReveal?.tabId !== tabId) return;
    const { line, matchStart, matchEnd } = pendingReveal;
    const selection = {
      startLineNumber: line,
      startColumn: matchStart + 1,
      endLineNumber: line,
      endColumn: matchEnd + 1,
    };
    editor.revealLineInCenter(line);
    editor.setSelection(selection);
    editor.focus();
    useSearchStore.getState().clearPendingReveal();
  }

  const pendingReveal = useSearchStore((s) => s.pendingReveal);
  useEffect(() => {
    if (pendingReveal && loadedTabIdRef.current) applyPendingReveal(loadedTabIdRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingReveal]);

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
      // Resetting the breadcrumb/status-bar state that goes with the
      // now-detached model — not "external system" synchronization, just
      // local UI state whose lifetime is tied to `isTarget`/`activeTab`
      // flipping away from this pane, so the extra render this causes is
      // the correct, intended outcome rather than the cascading-render
      // footgun the rule is guarding against.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setSymbols([]);
      setCursorPosition(null);
      blameByLine.current = new Map();
      blameDecorations.current?.set([]);
      return;
    }

    const tabId = activeTab.id;
    const { filePath, worktreeRoot } = activeTab;

    function attach(model: monaco.editor.ITextModel, isLarge: boolean) {
      editor?.updateOptions({
        // Large files stay minimap-off regardless of the user's setting —
        // painting one for a multi-MB file is its own separate cost on
        // top of the general WebKitGTK expense the setting already trades
        // off (see the `minimapEnabled` effect above).
        minimap: { enabled: !isLarge && useUiStore.getState().minimapEnabled },
        folding: !isLarge,
        wordWrap: !isLarge && useUiStore.getState().wordWrapEnabled ? "on" : "off",
      });
      editor?.setModel(model);
      editor?.layout();
      const saved = viewStates.current.get(tabId);
      if (saved) editor?.restoreViewState(saved);

      setCursorPosition(editor?.getPosition() ?? null);
      refreshSymbols(tabId, model);
      blameByLine.current = new Map();
      blameDecorations.current?.set([]);
      refreshBlame(tabId, worktreeRoot, filePath);

      applyPendingReveal(tabId);

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
    <div className={styles.wrap} style={{ display: isTarget ? "flex" : "none" }}>
      {activeTab?.filePath && (
        <EditorBreadcrumb
          filePath={activeTab.filePath}
          symbols={symbols}
          position={cursorPosition}
          onRevealSymbol={(symbol) => {
            const editor = editorRef.current;
            if (!editor) return;
            editor.revealRangeInCenter(symbol.range);
            editor.setSelection(symbol.selectionRange);
            editor.focus();
          }}
        />
      )}
      <div ref={containerRef} className={styles.host} />
    </div>
  );
}
