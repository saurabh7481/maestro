import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import * as monaco from "monaco-editor/editor/editor.api";
import { ensureMonacoEnvironment } from "../../editor/monacoSetup";
import { languageForPath } from "../../editor/languages";
import { useUiStore } from "../../state/uiStore";
import { useScmStore } from "../../state/scmStore";
import { fsApi } from "../../api/fs";
import { gitApi } from "../../api/git";
import type { DiffMode } from "../../types/git";
import styles from "./MonacoDiffHost.module.css";

ensureMonacoEnvironment();

const MONACO_FONT_FAMILY =
  "'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";
const BASE_FONT_SIZE = 13;
const AUTO_SAVE_DELAY_MS = 800;

export interface DiffNavState {
  count: number;
  added: number;
  removed: number;
}

export interface MonacoDiffHostHandle {
  goToNextChange: () => void;
  goToPreviousChange: () => void;
  /** Stages the hunk at (or nearest after) the cursor from an
   * `"unstaged"` diff, or unstages it from a `"staged"` one — see
   * `git.rs::stage_hunk` for why "the hunk at the cursor" is identified
   * by its line range rather than an index this component would
   * otherwise have to keep in sync with the backend's own idea of hunk
   * ordering. No-op for `"commit"` diffs (there's no index to touch). */
  stageCurrentHunk: () => Promise<void>;
}

interface MonacoDiffHostProps {
  relPath: string;
  oldText: string;
  newText: string;
  worktreeRoot: string;
  mode: DiffMode;
  onNavStateChange?: (state: DiffNavState) => void;
}

function startLine(change: monaco.editor.ILineChange): number {
  return change.modifiedStartLineNumber || change.originalStartLineNumber || 1;
}

function lineCount(start: number, end: number): number {
  return end === 0 ? 0 : end - start + 1;
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
 * Editable only for `"unstaged"` diffs, same as VS Code: typing (or
 * clicking a gutter revert arrow) edits the modified-side model, which is
 * debounced and written straight to disk — there's no separate "save"
 * step because a diff tab isn't a `file`-type tab wired into the normal
 * dirty/save machinery. `"staged"` and `"commit"` diffs stay read-only:
 * there's no sensible "type into the index" or "type into history"
 * operation, and Monaco's revert-hunk gutter arrows are gated on
 * `!readOnly` internally anyway (see `diffEditorOptions.js`'s
 * `shouldRenderOldRevertArrows`) so they'd be misleading there regardless.
 * Deliberately doesn't refetch the diff after a save (which would
 * recreate the model via the effect below and blow away cursor
 * position/undo history mid-edit) — the diff editor already recomputes
 * its own view live as the modified model changes; `onNavStateChange`
 * reports the live added/removed counts for the header instead of DiffView
 * re-deriving them from another `getDiff()` round-trip. */
export const MonacoDiffHost = forwardRef<MonacoDiffHostHandle, MonacoDiffHostProps>(
  function MonacoDiffHost({ relPath, oldText, newText, worktreeRoot, mode, onNavStateChange }, ref) {
    const readOnly = mode !== "unstaged";
    const containerRef = useRef<HTMLDivElement>(null);
    const editorRef = useRef<monaco.editor.IStandaloneDiffEditor | null>(null);
    const changesRef = useRef<monaco.editor.ILineChange[]>([]);
    const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const zoom = useUiStore((s) => s.zoom);

    useImperativeHandle(
      ref,
      () => ({
        goToNextChange() {
          const editor = editorRef.current;
          const changes = changesRef.current;
          if (!editor || changes.length === 0) return;
          const modified = editor.getModifiedEditor();
          const line = modified.getPosition()?.lineNumber ?? 1;
          const target = changes.find((c) => startLine(c) > line) ?? changes[0];
          modified.revealLineInCenter(startLine(target));
          modified.setPosition({ lineNumber: startLine(target), column: 1 });
          modified.focus();
        },
        goToPreviousChange() {
          const editor = editorRef.current;
          const changes = changesRef.current;
          if (!editor || changes.length === 0) return;
          const modified = editor.getModifiedEditor();
          const line = modified.getPosition()?.lineNumber ?? 1;
          const reversed = [...changes].reverse();
          const target = reversed.find((c) => startLine(c) < line) ?? reversed[0];
          modified.revealLineInCenter(startLine(target));
          modified.setPosition({ lineNumber: startLine(target), column: 1 });
          modified.focus();
        },
        async stageCurrentHunk() {
          const editor = editorRef.current;
          const changes = changesRef.current;
          if (!editor || changes.length === 0 || mode === "commit") return;

          const line = editor.getModifiedEditor().getPosition()?.lineNumber ?? 1;
          const containing = changes.find((c) => {
            const start = c.modifiedStartLineNumber || startLine(c);
            const end = c.modifiedEndLineNumber || start;
            return line >= start && line <= end;
          });
          const hunk = containing ?? changes.find((c) => startLine(c) >= line) ?? changes[0];
          const newStart = startLine(hunk);
          const newEnd = hunk.modifiedEndLineNumber || newStart;

          await useScmStore.getState().stageHunk(relPath, mode === "staged", newStart, newEnd);

          // The hunk just moved between the index and its other side —
          // refresh only whichever side of *this* model represents the
          // index (never the working-tree side, which for `"unstaged"`
          // is the live, possibly-being-edited modified model). For
          // `"staged"` that side is read-only already, so overwriting it
          // outright can't clobber anything.
          const fresh = await gitApi.getDiffContent(worktreeRoot, relPath, mode);
          if (fresh.kind !== "text") return;
          const model = editor.getModel();
          if (!model) return;
          if (mode === "unstaged") model.original.setValue(fresh.oldText);
          else model.modified.setValue(fresh.newText);
        },
      }),
      [],
    );

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
        readOnly,
        renderSideBySide: useUiStore.getState().diffSideBySide,
        renderMarginRevertIcon: true,
        renderGutterMenu: true,
        fontFamily: MONACO_FONT_FAMILY,
        fontSize: Math.round(BASE_FONT_SIZE * useUiStore.getState().zoom),
        minimap: { enabled: false },
        scrollBeyondLastLine: false,
      });
      editorRef.current = editor;

      function reportNavState() {
        const changes = editor.getLineChanges() ?? [];
        changesRef.current = changes;
        let added = 0;
        let removed = 0;
        for (const change of changes) {
          added += lineCount(change.modifiedStartLineNumber, change.modifiedEndLineNumber);
          removed += lineCount(change.originalStartLineNumber, change.originalEndLineNumber);
        }
        onNavStateChange?.({ count: changes.length, added, removed });
      }

      const diffSub = editor.onDidUpdateDiff(reportNavState);

      const modified = editor.getModifiedEditor();
      const changeSub = modified.onDidChangeModelContent(() => {
        if (readOnly) return;
        if (saveTimer.current) clearTimeout(saveTimer.current);
        saveTimer.current = setTimeout(() => {
          saveTimer.current = null;
          const model = modified.getModel();
          if (model) void fsApi.writeFile(worktreeRoot, relPath, model.getValue());
        }, AUTO_SAVE_DELAY_MS);
      });

      return () => {
        // Order matters: disposing a model while it's still the widget's
        // active model throws ("TextModel got disposed before
        // DiffEditorWidget model got reset") — confirmed live. `dispose()`
        // the editor first (it detaches its model references internally),
        // capture the model reference beforehand since `getModel()` isn't
        // reliable to call after the editor itself is gone.
        diffSub.dispose();
        changeSub.dispose();
        if (saveTimer.current) clearTimeout(saveTimer.current);
        const model = editor.getModel();
        editor.dispose();
        model?.original.dispose();
        model?.modified.dispose();
        editorRef.current = null;
      };
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // App-level zoom (Cmd/Ctrl +/-) scales the whole rem-based UI via
    // --zoom, but Monaco manages its own canvas-rendered font size — it
    // never picks that up on its own, so mirror it explicitly here.
    useEffect(() => {
      editorRef.current?.updateOptions({ fontSize: Math.round(BASE_FONT_SIZE * zoom) });
    }, [zoom]);

    const diffSideBySide = useUiStore((s) => s.diffSideBySide);
    useEffect(() => {
      editorRef.current?.updateOptions({ renderSideBySide: diffSideBySide });
    }, [diffSideBySide]);

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
  },
);
