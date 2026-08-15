import { useEffect, useMemo, useRef, useState } from "react";
import * as monaco from "monaco-editor/editor/editor.api";
import { Check, GitMerge, WarningCircle } from "@phosphor-icons/react";
import { ensureMonacoEnvironment } from "../../editor/monacoSetup";
import { languageForPath } from "../../editor/languages";
import { gitApi } from "../../api/git";
import { useTabsStore, type Tab } from "../../state/tabsStore";
import type { ConflictContent } from "../../types/git";
import styles from "./MergeView.module.css";

ensureMonacoEnvironment();
const FONT = "'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";
const CONFLICT = /<<<<<<<[^\n]*\n([\s\S]*?)=======\n([\s\S]*?)>>>>>>>[^\n]*(?:\n|$)/g;
const FIRST_CONFLICT = /<<<<<<<[^\n]*\n([\s\S]*?)=======\n([\s\S]*?)>>>>>>>[^\n]*(?:\n|$)/;

function conflicts(text: string) {
  return [...text.matchAll(CONFLICT)];
}

function applyFirst(text: string, choice: "current" | "incoming" | "both") {
  return text.replace(FIRST_CONFLICT, (_whole, current: string, incoming: string) => {
    if (choice === "current") return current;
    if (choice === "incoming") return incoming;
    const separator = current.endsWith("\n") || incoming.startsWith("\n") ? "" : "\n";
    return `${current}${separator}${incoming}`;
  });
}

function MergeEditors({
  path,
  data,
  result,
  onResult,
}: {
  path: string;
  data: ConflictContent;
  result: string;
  onResult: (value: string) => void;
}) {
  const currentRef = useRef<HTMLDivElement>(null);
  const incomingRef = useRef<HTMLDivElement>(null);
  const resultRef = useRef<HTMLDivElement>(null);
  const resultEditor = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);

  useEffect(() => {
    if (!currentRef.current || !incomingRef.current || !resultRef.current) return;
    const language = languageForPath(path);
    const base = {
      automaticLayout: true,
      theme: "vs-dark",
      fontFamily: FONT,
      fontSize: 13,
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
    } satisfies monaco.editor.IStandaloneEditorConstructionOptions;
    const current = monaco.editor.create(currentRef.current, {
      ...base,
      readOnly: true,
      value: data.currentText,
      language,
    });
    const incoming = monaco.editor.create(incomingRef.current, {
      ...base,
      readOnly: true,
      value: data.incomingText,
      language,
    });
    const merged = monaco.editor.create(resultRef.current, {
      ...base,
      value: data.resultText,
      language,
    });
    resultEditor.current = merged;
    const subscription = merged.onDidChangeModelContent(() => onResult(merged.getValue()));
    return () => {
      subscription.dispose();
      const currentModel = current.getModel();
      const incomingModel = incoming.getModel();
      const mergedModel = merged.getModel();
      current.dispose();
      currentModel?.dispose();
      incoming.dispose();
      incomingModel?.dispose();
      merged.dispose();
      mergedModel?.dispose();
      resultEditor.current = null;
    };
  }, [data, onResult, path]);

  useEffect(() => {
    const editor = resultEditor.current;
    if (editor && editor.getValue() !== result) editor.setValue(result);
  }, [result]);

  return (
    <div className={styles.editors}>
      <section className={styles.input}>
        <div className={styles.paneTitle}>Current</div>
        <div className={styles.editor} ref={currentRef} />
      </section>
      <section className={styles.input}>
        <div className={styles.paneTitle}>Incoming</div>
        <div className={styles.editor} ref={incomingRef} />
      </section>
      <section className={styles.result}>
        <div className={styles.paneTitle}>Result · editable</div>
        <div className={styles.editor} ref={resultRef} />
      </section>
    </div>
  );
}

export function MergeView({ tab }: { tab: Tab }) {
  const [data, setData] = useState<ConflictContent | null>(null);
  const [result, setResult] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const closeTab = useTabsStore((state) => state.closeTab);
  const unresolved = useMemo(() => conflicts(result).length, [result]);
  const path = tab.filePath ?? "";

  useEffect(() => {
    if (!tab.worktreeRoot) return;
    gitApi
      .getConflictContent(tab.worktreeRoot, path)
      .then((value) => {
        setData(value);
        setResult(value.resultText);
      })
      .catch((reason) => setError(String(reason)));
  }, [path, tab.worktreeRoot]);

  async function complete() {
    if (!tab.worktreeId || !tab.worktreeRoot || unresolved > 0) return;
    setSaving(true);
    try {
      await gitApi.resolveConflict(tab.worktreeId, tab.worktreeRoot, path, result);
      closeTab(tab.id);
    } catch (reason) {
      setError(String(reason));
    } finally {
      setSaving(false);
    }
  }

  if (error)
    return (
      <div className={styles.center}>
        <WarningCircle size={24} />
        {error}
      </div>
    );
  if (!data) return <div className={styles.center}>Loading conflict…</div>;
  return (
    <div className={styles.wrap}>
      <header className={styles.header}>
        <GitMerge size={17} className={styles.mergeIcon} />
        <div>
          <strong>{path}</strong>
          <span>Three-way merge</span>
        </div>
        <span className={styles.counter} data-done={unresolved === 0 || undefined}>
          {unresolved === 0 ? "All conflicts resolved" : `${unresolved} unresolved`}
        </span>
        <button
          type="button"
          className={styles.complete}
          disabled={unresolved > 0 || saving}
          onClick={() => void complete()}
        >
          <Check size={14} />
          {saving ? "Completing…" : "Complete merge"}
        </button>
      </header>
      <div className={styles.resolutionBar}>
        <span>
          {unresolved
            ? "Resolve next conflict"
            : "Review the editable result, then complete the merge."}
        </span>
        {unresolved > 0 && (
          <>
            <button
              type="button"
              onClick={() => setResult((value) => applyFirst(value, "current"))}
            >
              Accept current
            </button>
            <button
              type="button"
              onClick={() => setResult((value) => applyFirst(value, "incoming"))}
            >
              Accept incoming
            </button>
            <button type="button" onClick={() => setResult((value) => applyFirst(value, "both"))}>
              Accept combination
            </button>
          </>
        )}
      </div>
      <MergeEditors path={path} data={data} result={result} onResult={setResult} />
    </div>
  );
}
