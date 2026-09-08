import { beforeEach, describe, expect, it, vi } from "vitest";
import { fsApi } from "./fs";
import { makeBlankNote, notesApi, notePath, parseNoteDocument } from "./notes";

vi.mock("./fs", () => ({
  fsApi: {
    listDir: vi.fn(),
    readFile: vi.fn(),
    createEntry: vi.fn(),
    writeFile: vi.fn(),
    deleteEntry: vi.fn(),
  },
}));

describe("notesApi", () => {
  beforeEach(() => vi.clearAllMocks());

  it("rejects unsafe ids and mismatched document envelopes", () => {
    expect(() => notePath("../../outside")).toThrow("Invalid note id");
    const note = makeBlankNote("12345678");
    expect(() => parseNoteDocument(JSON.stringify(note), "different-id")).toThrow("does not match");
  });

  it("lists newest readable notes and reports damaged files", async () => {
    vi.mocked(fsApi.listDir).mockResolvedValue([
      {
        name: "12345678.maestro-note.json",
        relPath: ".maestro/notes/12345678.maestro-note.json",
        isDir: false,
        isSymlink: false,
        sizeBytes: 10,
      },
      {
        name: "damaged1.maestro-note.json",
        relPath: ".maestro/notes/damaged1.maestro-note.json",
        isDir: false,
        isSymlink: false,
        sizeBytes: 10,
      },
    ]);
    const note = makeBlankNote("12345678", new Date("2026-09-08T06:00:00Z"));
    vi.mocked(fsApi.readFile)
      .mockResolvedValueOnce({
        kind: "text",
        content: JSON.stringify(note),
        sizeBytes: 10,
        mtimeMs: 4,
      })
      .mockResolvedValueOnce({ kind: "text", content: "{", sizeBytes: 1, mtimeMs: 5 });

    await expect(notesApi.list("/worktree")).resolves.toEqual({
      notes: [
        {
          id: "12345678",
          title: "Untitled note",
          createdAt: "2026-09-08T06:00:00.000Z",
          updatedAt: "2026-09-08T06:00:00.000Z",
        },
      ],
      unreadableFiles: ["damaged1.maestro-note.json"],
    });
  });

  it("uses the loaded mtime as an optimistic save guard", async () => {
    const note = makeBlankNote("12345678");
    vi.mocked(fsApi.writeFile).mockResolvedValue({ mtimeMs: 12 });
    await expect(notesApi.save("/worktree", note, 9)).resolves.toBe(12);
    expect(fsApi.writeFile).toHaveBeenCalledWith(
      "/worktree",
      ".maestro/notes/12345678.maestro-note.json",
      JSON.stringify(note),
      9,
    );
  });
});
