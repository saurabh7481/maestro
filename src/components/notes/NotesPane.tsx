import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowsClockwise,
  Check,
  FileText,
  MagnifyingGlass,
  NotePencil,
  Plus,
  SpinnerGap,
  Trash,
  WarningCircle,
} from "@phosphor-icons/react";
import { Excalidraw, serializeAsJSON } from "@excalidraw/excalidraw";
import "@excalidraw/excalidraw/index.css";
import type { ExcalidrawInitialDataState } from "@excalidraw/excalidraw/types";
import { makeBlankNote, notesApi } from "../../api/notes";
import { useMarkdownHtml } from "../../design/renderMarkdown";
import { useTabsStore, type Tab } from "../../state/tabsStore";
import type { NoteDocument, NoteSummary } from "../../types/notes";
import { AlertDialog } from "../primitives";
import styles from "./NotesPane.module.css";

type SaveState = "saved" | "pending" | "saving" | "error";
type NoteMode = "canvas" | "write";

const AUTOSAVE_DELAY_MS = 700;

function displayDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "Unknown date";
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    ...(date.getFullYear() !== new Date().getFullYear() ? { year: "numeric" } : {}),
  }).format(date);
}

function normalizedTitle(value: string): string {
  return value.trim() || "Untitled note";
}

export function NotesPane({ tab }: { tab: Tab }) {
  const worktreeRoot = tab.worktreeRoot ?? "";
  const updateTab = useTabsStore((state) => state.updateTab);
  const [summaries, setSummaries] = useState<NoteSummary[]>([]);
  const [unreadableFiles, setUnreadableFiles] = useState<string[]>([]);
  const [query, setQuery] = useState("");
  const [loadingList, setLoadingList] = useState(true);
  const [note, setNote] = useState<NoteDocument | null>(null);
  const [loadingNote, setLoadingNote] = useState(Boolean(tab.noteId));
  const [mode, setMode] = useState<NoteMode>("canvas");
  const [saveState, setSaveState] = useState<SaveState>("saved");
  const [saveError, setSaveError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);

  const currentNoteRef = useRef<NoteDocument | null>(null);
  const mtimeRef = useRef<number | null>(null);
  const revisionRef = useRef(0);
  const savedRevisionRef = useRef(0);
  const saveTimerRef = useRef<number | null>(null);
  const saveInFlightRef = useRef(false);
  const savePromiseRef = useRef<Promise<void> | null>(null);
  const mountedRef = useRef(true);

  const refreshList = useCallback(async () => {
    if (!worktreeRoot) return;
    try {
      const result = await notesApi.list(worktreeRoot);
      if (!mountedRef.current) return;
      setSummaries(result.notes);
      setUnreadableFiles(result.unreadableFiles);
    } finally {
      if (mountedRef.current) setLoadingList(false);
    }
  }, [worktreeRoot]);

  const saveNow = useCallback(async (): Promise<void> => {
    if (saveTimerRef.current !== null) {
      window.clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }
    if (saveInFlightRef.current) {
      await savePromiseRef.current;
    }

    // Drain every revision serially. An edit made while a write is in
    // flight uses the mtime returned by that write, so autosave never
    // races itself or mistakes its own write for an external conflict.
    while (savedRevisionRef.current !== revisionRef.current) {
      const pending = currentNoteRef.current;
      const expectedMtime = mtimeRef.current;
      if (!pending || expectedMtime === null) return;
      const savingRevision = revisionRef.current;
      saveInFlightRef.current = true;
      if (mountedRef.current) setSaveState("saving");
      let succeeded = false;
      const job = (async () => {
        try {
          const mtime = await notesApi.save(worktreeRoot, pending, expectedMtime);
          succeeded = true;
          mtimeRef.current = mtime;
          savedRevisionRef.current = savingRevision;
          if (mountedRef.current) {
            setSaveError(null);
            setSaveState(savedRevisionRef.current === revisionRef.current ? "saved" : "pending");
          }
          void refreshList();
        } catch (reason) {
          if (mountedRef.current) {
            setSaveState("error");
            setSaveError(String(reason));
          }
        } finally {
          saveInFlightRef.current = false;
          savePromiseRef.current = null;
        }
      })();
      savePromiseRef.current = job;
      await job;
      if (!succeeded) return;
    }
  }, [refreshList, worktreeRoot]);

  const stageChange = useCallback(
    (update: (current: NoteDocument) => NoteDocument, reflectInReact: boolean) => {
      const current = currentNoteRef.current;
      if (!current) return;
      const next = update(current);
      const timestamped = { ...next, updatedAt: new Date().toISOString() };
      currentNoteRef.current = timestamped;
      revisionRef.current += 1;
      if (reflectInReact) setNote(timestamped);
      setSaveState("pending");
      setSaveError(null);
      if (saveTimerRef.current !== null) window.clearTimeout(saveTimerRef.current);
      saveTimerRef.current = window.setTimeout(() => void saveNow(), AUTOSAVE_DELAY_MS);
    },
    [saveNow],
  );

  useEffect(() => {
    mountedRef.current = true;
    void refreshList();
    return () => {
      mountedRef.current = false;
      if (saveTimerRef.current !== null) window.clearTimeout(saveTimerRef.current);
      // Closing/switching the tab does not discard the last debounce window.
      void saveNow();
    };
  }, [refreshList, saveNow]);

  useEffect(() => {
    const id = tab.noteId;
    if (!id) return;

    let cancelled = false;
    void notesApi
      .load(worktreeRoot, id)
      .then((loaded) => {
        if (cancelled) return;
        currentNoteRef.current = loaded.note;
        mtimeRef.current = loaded.mtimeMs;
        revisionRef.current = 0;
        savedRevisionRef.current = 0;
        setNote(loaded.note);
        setSaveState("saved");
        updateTab(tab.id, { title: loaded.note.title, noteId: loaded.note.id });
      })
      .catch((reason) => {
        if (!cancelled) {
          setNote(null);
          setSaveState("error");
          setSaveError(String(reason));
        }
      })
      .finally(() => {
        if (!cancelled) setLoadingNote(false);
      });
    return () => {
      cancelled = true;
    };
  }, [tab.id, tab.noteId, updateTab, worktreeRoot]);

  async function createNote() {
    if (!worktreeRoot || creating) return;
    setCreating(true);
    setSaveError(null);
    try {
      await saveNow();
      if (savedRevisionRef.current !== revisionRef.current) return;
      const fresh = makeBlankNote(crypto.randomUUID());
      const loaded = await notesApi.create(worktreeRoot, fresh);
      currentNoteRef.current = loaded.note;
      mtimeRef.current = loaded.mtimeMs;
      revisionRef.current = 0;
      savedRevisionRef.current = 0;
      setNote(loaded.note);
      setMode("canvas");
      setSaveState("saved");
      updateTab(tab.id, { title: fresh.title, noteId: fresh.id });
      await refreshList();
    } catch (reason) {
      setSaveState("error");
      setSaveError(String(reason));
    } finally {
      setCreating(false);
    }
  }

  async function selectNote(id: string) {
    if (id === tab.noteId) return;
    await saveNow();
    if (savedRevisionRef.current !== revisionRef.current) return;
    setMode("canvas");
    setLoadingNote(true);
    setSaveError(null);
    updateTab(tab.id, { noteId: id });
  }

  async function deleteCurrentNote() {
    if (!note) return;
    try {
      if (saveTimerRef.current !== null) window.clearTimeout(saveTimerRef.current);
      await savePromiseRef.current;
      await notesApi.delete(worktreeRoot, note.id);
      currentNoteRef.current = null;
      mtimeRef.current = null;
      setNote(null);
      setDeleteOpen(false);
      updateTab(tab.id, { title: "Notes", noteId: undefined });
      await refreshList();
    } catch (reason) {
      setSaveState("error");
      setSaveError(String(reason));
    }
  }

  const filtered = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    return needle
      ? summaries.filter((summary) => summary.title.toLocaleLowerCase().includes(needle))
      : summaries;
  }, [query, summaries]);

  return (
    <div className={styles.root}>
      <aside className={styles.library} aria-label="Notes library">
        <div className={styles.libraryHeader}>
          <span className={styles.libraryTitle}>
            <NotePencil size={17} weight="duotone" />
            Notes
          </span>
          <button
            type="button"
            className={styles.newButton}
            onClick={() => void createNote()}
            disabled={creating}
            aria-label="Create note"
          >
            {creating ? <SpinnerGap className="mo-spin" size={15} /> : <Plus size={15} />}
            New
          </button>
        </div>
        <label className={styles.search}>
          <MagnifyingGlass size={14} />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Find a note"
          />
        </label>
        <div className={styles.noteList}>
          {loadingList && (
            <div className={styles.libraryMessage}>
              <SpinnerGap className="mo-spin" size={14} /> Loading notes…
            </div>
          )}
          {!loadingList && filtered.length === 0 && (
            <div className={styles.libraryMessage}>
              {query ? "No notes match." : "No notes yet."}
            </div>
          )}
          {filtered.map((summary) => (
            <button
              type="button"
              key={summary.id}
              className={styles.noteRow}
              data-active={summary.id === tab.noteId}
              onClick={() => void selectNote(summary.id)}
            >
              <span>{summary.title}</span>
              <small>{displayDate(summary.updatedAt)}</small>
            </button>
          ))}
        </div>
        <div className={styles.libraryFooter}>
          <span>.maestro/notes</span>
          {unreadableFiles.length > 0 && (
            <span className={styles.corruptWarning} title={unreadableFiles.join("\n")}>
              <WarningCircle size={12} /> {unreadableFiles.length} unreadable
            </span>
          )}
        </div>
      </aside>

      <section className={styles.workspace}>
        {loadingNote ? (
          <div className={styles.centerState}>
            <SpinnerGap className="mo-spin" size={20} /> Opening note…
          </div>
        ) : note ? (
          <NoteWorkspace
            key={note.id}
            note={note}
            mode={mode}
            saveState={saveState}
            saveError={saveError}
            onModeChange={(nextMode) => {
              // Canvas changes live in a ref to avoid re-rendering the whole
              // Excalidraw tree on every pointer move. Materialize the latest
              // scene before replacing it with the writing surface.
              if (currentNoteRef.current) setNote(currentNoteRef.current);
              setMode(nextMode);
            }}
            onChange={stageChange}
            onRetrySave={() => void saveNow()}
            onDelete={() => setDeleteOpen(true)}
            onTitleCommit={(title) => updateTab(tab.id, { title })}
          />
        ) : (
          <div className={styles.emptyState}>
            <div className={styles.emptyMark}>
              <NotePencil size={28} weight="duotone" />
            </div>
            <h2>{saveError ? "Couldn't open that note" : "A workbench for thinking"}</h2>
            <p>
              {saveError
                ? saveError
                : "Sketch a system, map a flow, paste data as a chart, or switch to Write for long-form Markdown."}
            </p>
            <button
              type="button"
              className={styles.primaryAction}
              onClick={() => void createNote()}
            >
              <Plus size={16} /> Create a note
            </button>
          </div>
        )}
      </section>

      <AlertDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        title="Delete this note?"
        description={
          <>
            <strong>{note?.title ?? "This note"}</strong> and its canvas will be removed from the
            worktree. Closing this tab does not delete it; this action does.
          </>
        }
        confirmLabel="Delete note"
        onConfirm={() => void deleteCurrentNote()}
      />
    </div>
  );
}

function NoteWorkspace({
  note,
  mode,
  saveState,
  saveError,
  onModeChange,
  onChange,
  onRetrySave,
  onDelete,
  onTitleCommit,
}: {
  note: NoteDocument;
  mode: NoteMode;
  saveState: SaveState;
  saveError: string | null;
  onModeChange: (mode: NoteMode) => void;
  onChange: (update: (current: NoteDocument) => NoteDocument, reflectInReact: boolean) => void;
  onRetrySave: () => void;
  onDelete: () => void;
  onTitleCommit: (title: string) => void;
}) {
  const [titleDraft, setTitleDraft] = useState(note.title);
  const html = useMarkdownHtml(note.writing) ?? "";
  const words = note.writing.trim() ? note.writing.trim().split(/\s+/).length : 0;

  function commitTitle() {
    const title = normalizedTitle(titleDraft);
    setTitleDraft(title);
    if (title !== note.title) onChange((current) => ({ ...current, title }), true);
    onTitleCommit(title);
  }

  return (
    <>
      <header className={styles.noteHeader}>
        <input
          className={styles.titleInput}
          value={titleDraft}
          onChange={(event) => setTitleDraft(event.target.value)}
          onBlur={commitTitle}
          onKeyDown={(event) => {
            if (event.key === "Enter") event.currentTarget.blur();
          }}
          aria-label="Note title"
        />
        <div className={styles.modeSwitch} aria-label="Note view">
          <button
            type="button"
            data-active={mode === "canvas"}
            onClick={() => onModeChange("canvas")}
          >
            <NotePencil size={14} /> Canvas
          </button>
          <button
            type="button"
            data-active={mode === "write"}
            onClick={() => onModeChange("write")}
          >
            <FileText size={14} /> Write
          </button>
        </div>
        <SaveIndicator state={saveState} error={saveError} onRetry={onRetrySave} />
        <button
          type="button"
          className={styles.deleteButton}
          onClick={onDelete}
          aria-label="Delete note"
        >
          <Trash size={15} />
        </button>
      </header>

      {mode === "canvas" ? (
        <div className={styles.canvas}>
          <Excalidraw
            initialData={note.scene}
            theme="dark"
            name={note.title}
            autoFocus={false}
            handleKeyboardGlobally={false}
            UIOptions={{
              canvasActions: {
                loadScene: false,
                saveToActiveFile: false,
                toggleTheme: false,
              },
            }}
            onChange={(elements, appState, files) => {
              const scene = JSON.parse(
                serializeAsJSON(elements, appState, files, "local"),
              ) as ExcalidrawInitialDataState;
              onChange((current) => ({ ...current, scene }), false);
            }}
          />
        </div>
      ) : (
        <div className={styles.writer}>
          <div className={styles.sourceColumn}>
            <div className={styles.writerLabel}>Markdown</div>
            <textarea
              value={note.writing}
              onChange={(event) => {
                const writing = event.target.value;
                onChange((current) => ({ ...current, writing }), true);
              }}
              placeholder="Write freely. Markdown headings, lists, links, quotes, and code are supported."
              spellCheck
              aria-label="Note text"
            />
            <div className={styles.wordCount}>{words} words</div>
          </div>
          <div className={styles.previewColumn}>
            <div className={styles.writerLabel}>Preview</div>
            <article
              className={styles.markdownPreview}
              dangerouslySetInnerHTML={{ __html: html }}
            />
          </div>
        </div>
      )}
    </>
  );
}

function SaveIndicator({
  state,
  error,
  onRetry,
}: {
  state: SaveState;
  error: string | null;
  onRetry: () => void;
}) {
  if (state === "error") {
    return (
      <button
        type="button"
        className={styles.saveError}
        onClick={onRetry}
        title={error ?? undefined}
      >
        <WarningCircle size={13} /> Save failed <ArrowsClockwise size={12} />
      </button>
    );
  }
  return (
    <span className={styles.saveState}>
      {state === "saved" ? (
        <Check size={13} />
      ) : (
        <SpinnerGap className={state === "saving" ? "mo-spin" : undefined} size={13} />
      )}
      {state === "saved" ? "Saved" : state === "saving" ? "Saving…" : "Unsaved"}
    </span>
  );
}
