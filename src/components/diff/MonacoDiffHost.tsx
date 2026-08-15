import { useEffect, useRef } from "react";
import * as monaco from "monaco-editor";
import { ensureMonacoEnvironment } from "../../editor/monacoSetup";
import { languageForPath } from "../../editor/monacoModelRegistry";
import { useUiStore } from "../../state/uiStore";
import styles from "./MonacoDiffHost.module.css";

ensureMonacoEnvironment();

const MONACO_FONT_FAMILY =
  "'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";
const BASE_FONT_SIZE = 13;

interface MonacoDiffHostProps {
  relPath: string;
  oldText: string;
  newText: string;
}

/** Mounts a Monaco diff editor for the lifetime of the enclosing
 * `DiffView` — one editor created per activated diff tab, disposed on
 * unmount (tab switched away from or closed), rather than `MonacoHost`'s
 * single persistent model-swapping instance. Diff tabs are reviewed far
 * more briefly and intermittently than the main file editor, so the
 * simpler mount/dispose-per-activation lifecycle is the right tradeoff —
 * it also sidesteps needing to coordinate absolute-positioning with a
 * sibling-owned header the way `MonacoHost`/`MarkdownPane` do, since this
 * is a normal in-flow child of `DiffView`'s own layout.
 *
 * Always read-only: editing the working tree from inside the diff view
 * (writing the modified side back to disk) isn't in Phase 4 scope — Stage/
 * Unstage/Revert are the only mutation paths a diff tab exposes. */
export function MonacoDiffHost({ relPath, oldText, newText }: MonacoDiffHostProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<monaco.editor.IStandaloneDiffEditor | null>(null);
  const zoom = useUiStore((s) => s.zoom);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    // StrictMode's dev-mode double-invoke (mount, cleanup, mount again)
    // creates and disposes a throwaway editor into this same container
    // before the real one — `dispose()` doesn't reliably strip every DOM
    // node it injected, and the second `createDiffEditor` call into a
    // container that isn't truly empty has been observed to render a
    // broken/blank diff despite the model API reporting correct content.
    // Clearing the container first guarantees each instance starts clean.
    container.innerHTML = "";
    const editor = monaco.editor.createDiffEditor(container, {
      automaticLayout: true,
      theme: "vs-dark",
      readOnly: true,
      renderSideBySide: true,
      fontFamily: MONACO_FONT_FAMILY,
      fontSize: Math.round(BASE_FONT_SIZE * useUiStore.getState().zoom),
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
    });
    editorRef.current = editor;

    return () => {
      // Order matters: disposing a model while it's still the widget's
      // active model throws ("TextModel got disposed before
      // DiffEditorWidget model got reset") — confirmed live. `dispose()`
      // the editor first (it detaches its model references internally),
      // capture the model reference beforehand since `getModel()` isn't
      // reliable to call after the editor itself is gone.
      const model = editor.getModel();
      editor.dispose();
      model?.original.dispose();
      model?.modified.dispose();
      editorRef.current = null;
    };
  }, []);

  // App-level zoom (Cmd/Ctrl +/-) scales the whole rem-based UI via
  // --zoom, but Monaco manages its own canvas-rendered font size — it
  // never picks that up on its own, so mirror it explicitly here.
  useEffect(() => {
    editorRef.current?.updateOptions({ fontSize: Math.round(BASE_FONT_SIZE * zoom) });
  }, [zoom]);

  useEffect(() => {
    const editor = editorRef.current;
    if (!editor) return;
    const language = languageForPath(relPath);
    const prevModel = editor.getModel();
    const original = monaco.editor.createModel(oldText, language);
    const modified = monaco.editor.createModel(newText, language);
    editor.setModel({ original, modified });
    prevModel?.original.dispose();
    prevModel?.modified.dispose();
  }, [relPath, oldText, newText]);

  return <div ref={containerRef} className={styles.host} />;
}
