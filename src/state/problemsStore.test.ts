import { beforeEach, describe, expect, it } from "vitest";
import {
  buildProblemPathSummaries,
  problemSummaryForPath,
  useProblemsStore,
} from "./problemsStore";
import type { Problem } from "../types/problem";

const owner = { worktreeId: "wt", sourceKind: "lsp" as const, sourceId: "pyright" };

function problem(relativePath: string, message: string, severity: Problem["severity"]): Problem {
  return {
    ...owner,
    id: `${relativePath}:${message}`,
    uri: `file:///repo/${relativePath}`,
    relativePath,
    range: { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 2 },
    severity,
    message,
    observedAt: 1,
    stale: false,
  };
}

describe("problemsStore", () => {
  beforeEach(() => useProblemsStore.setState({ byOwner: {} }));

  it("replaces one document without disturbing another", () => {
    const store = useProblemsStore.getState();
    const a = problem("src/a.ts", "a", "error");
    const b = problem("src/b.ts", "b", "warning");
    store.replaceDocumentProblems({ ...owner, uri: a.uri, problems: [a] });
    store.replaceDocumentProblems({ ...owner, uri: b.uri, problems: [b] });
    store.replaceDocumentProblems({ ...owner, uri: a.uri, problems: [] });
    expect(Object.values(useProblemsStore.getState().byOwner).flat()).toEqual([b]);
  });

  it("isolates owners and marks only a failed source stale", () => {
    const lsp = problem("src/a.ts", "lsp", "error");
    const task = { ...problem("src/a.ts", "task", "warning"), sourceKind: "task" as const };
    useProblemsStore
      .getState()
      .replaceDocumentProblems({ ...owner, uri: lsp.uri, problems: [lsp] });
    useProblemsStore.getState().replaceDocumentProblems({
      ...owner,
      sourceKind: "task",
      uri: task.uri,
      problems: [task],
    });
    useProblemsStore.getState().markSourceStale(owner);
    const all = Object.values(useProblemsStore.getState().byOwner).flat();
    expect(all.find((entry) => entry.message === "lsp")?.stale).toBe(true);
    expect(all.find((entry) => entry.message === "task")?.stale).toBe(false);
  });

  it("aggregates directories with path boundaries", () => {
    const byOwner = {
      owner: [
        problem("src/app/a.ts", "a", "error"),
        problem("src/apple.ts", "apple", "warning"),
        problem("src/app/b.ts", "b", "warning"),
      ],
    };
    expect(problemSummaryForPath(byOwner, "wt", "src/app", true)).toMatchObject({
      total: 2,
      error: 1,
      warning: 1,
      highestSeverity: "error",
    });
    expect(buildProblemPathSummaries(byOwner, "wt")["src/app"]).toMatchObject({
      total: 2,
      error: 1,
      warning: 1,
    });
  });
});
