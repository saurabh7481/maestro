import type { ExcalidrawInitialDataState } from "@excalidraw/excalidraw/types";

export const NOTE_SCHEMA_VERSION = 1;

/** One durable notebook document. The scene is Excalidraw's portable JSON
 * model; `writing` is kept beside it so long-form prose does not have to be
 * forced into dozens of independent canvas text boxes. */
export interface NoteDocument {
  schemaVersion: typeof NOTE_SCHEMA_VERSION;
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  writing: string;
  scene: ExcalidrawInitialDataState;
}

export interface NoteSummary {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
}

export interface LoadedNote {
  note: NoteDocument;
  mtimeMs: number;
}

export interface NoteListResult {
  notes: NoteSummary[];
  unreadableFiles: string[];
}
