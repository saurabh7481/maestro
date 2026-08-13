import { useEffect, useRef } from "react";
import * as monaco from "monaco-editor";
import { ensureMonacoEnvironment } from "../../editor/monacoSetup";
import { languageForPath } from "../../editor/monacoModelRegistry";
import styles from "./MonacoDiffHost.module.css";

ensureMonacoEnvironment();

const MONACO_FONT_FAMILY =
  "'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";

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

  useEffect(() => {
    if (!containerRef.current) return;
    const editor = monaco.editor.createDiffEditor(containerRef.current, {
      automaticLayout: true,
      theme: "vs-dark",
      readOnly: true,
      renderSideBySide: true,
      fontFamily: MONACO_FONT_FAMILY,
      fontSize: 13,
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
    });
    editorRef.current = editor;

    return () => {
      const model = editor.getModel();
      model?.original.dispose();
      model?.modified.dispose();
      editor.dispose();
      editorRef.current = null;
    };
  }, []);

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
