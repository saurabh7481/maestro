import { fsApi } from "./fs";
import {
  NOTE_SCHEMA_VERSION,
  type LoadedNote,
  type NoteDocument,
  type NoteListResult,
  type NoteSummary,
} from "../types/notes";

export const NOTES_DIRECTORY = ".maestro/notes";
const NOTE_FILE_SUFFIX = ".maestro-note.json";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function notePath(id: string): string {
  if (!/^[a-zA-Z0-9-]{8,80}$/.test(id)) throw new Error("Invalid note id.");
  return `${NOTES_DIRECTORY}/${id}${NOTE_FILE_SUFFIX}`;
}

/** Validates the metadata and minimum scene structure before a disk file is
 * trusted. Excalidraw performs its own forward/backward scene restoration;
 * these checks protect Maestro's surrounding document envelope. */
export function parseNoteDocument(content: string, expectedId?: string): NoteDocument {
  let raw: unknown;
  try {
    raw = JSON.parse(content);
  } catch {
    throw new Error("The note file is not valid JSON.");
  }
  if (!isRecord(raw) || raw.schemaVersion !== NOTE_SCHEMA_VERSION) {
    throw new Error("The note file uses an unsupported format.");
  }
  if (typeof raw.id !== "string" || (expectedId && raw.id !== expectedId)) {
    throw new Error("The note id does not match its file name.");
  }
  if (typeof raw.title !== "string" || typeof raw.writing !== "string") {
    throw new Error("The note metadata is incomplete.");
  }
  if (typeof raw.createdAt !== "string" || typeof raw.updatedAt !== "string") {
    throw new Error("The note timestamps are missing.");
  }
  if (!isRecord(raw.scene) || !Array.isArray(raw.scene.elements)) {
    throw new Error("The note canvas is missing or damaged.");
  }
  return raw as unknown as NoteDocument;
}

function summaryOf(note: NoteDocument): NoteSummary {
  return {
    id: note.id,
    title: note.title,
    createdAt: note.createdAt,
    updatedAt: note.updatedAt,
  };
}

export function makeBlankNote(id: string, now = new Date()): NoteDocument {
  // Validate ids at creation too; otherwise the first autosave would fail
  // several seconds after the user had already started drawing.
  notePath(id);
  const timestamp = now.toISOString();
  return {
    schemaVersion: NOTE_SCHEMA_VERSION,
    id,
    title: "Untitled note",
    createdAt: timestamp,
    updatedAt: timestamp,
    writing: "",
    scene: {
      elements: [],
      appState: { viewBackgroundColor: "#12151c" },
      files: {},
      scrollToContent: true,
    },
  };
}

async function readNote(worktreeRoot: string, id: string): Promise<LoadedNote> {
  const result = await fsApi.readFile(worktreeRoot, notePath(id));
  if (result.kind !== "text") throw new Error("The note is not a readable text file.");
  return { note: parseNoteDocument(result.content, id), mtimeMs: result.mtimeMs };
}

export const notesApi = {
  list: async (worktreeRoot: string): Promise<NoteListResult> => {
    let entries;
    try {
      entries = await fsApi.listDir(worktreeRoot, NOTES_DIRECTORY);
    } catch {
      return { notes: [], unreadableFiles: [] };
    }

    const files = entries.filter(
      (entry) => !entry.isDir && !entry.isSymlink && entry.name.endsWith(NOTE_FILE_SUFFIX),
    );
    const settled = await Promise.allSettled(
      files.map(async (entry) => {
        const id = entry.name.slice(0, -NOTE_FILE_SUFFIX.length);
        return summaryOf((await readNote(worktreeRoot, id)).note);
      }),
    );
    const notes: NoteSummary[] = [];
    const unreadableFiles: string[] = [];
    settled.forEach((result, index) => {
      if (result.status === "fulfilled") notes.push(result.value);
      else unreadableFiles.push(files[index].name);
    });
    notes.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    return { notes, unreadableFiles };
  },

  load: readNote,

  create: async (worktreeRoot: string, note: NoteDocument): Promise<LoadedNote> => {
    const path = notePath(note.id);
    await fsApi.createEntry(worktreeRoot, path, false);
    const result = await fsApi.writeFile(worktreeRoot, path, JSON.stringify(note));
    return { note, mtimeMs: result.mtimeMs };
  },

  save: async (
    worktreeRoot: string,
    note: NoteDocument,
    expectedMtimeMs: number,
  ): Promise<number> => {
    const content = JSON.stringify(note);
    // Keep one runaway canvas from exhausting the webview/IPC allocation.
    if (content.length > 40 * 1024 * 1024) {
      throw new Error("This note is larger than Maestro's 40 MB safety limit.");
    }
    const result = await fsApi.writeFile(worktreeRoot, notePath(note.id), content, expectedMtimeMs);
    return result.mtimeMs;
  },

  delete: (worktreeRoot: string, id: string) => fsApi.deleteEntry(worktreeRoot, notePath(id)),
};
