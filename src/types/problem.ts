export type ProblemSeverity = "error" | "warning" | "info" | "hint";

export type ProblemSourceKind = "lsp" | "task";

export interface ProblemRange {
  startLineNumber: number;
  startColumn: number;
  endLineNumber: number;
  endColumn: number;
}

export interface ProblemRelatedInformation {
  message: string;
  uri: string;
  range: ProblemRange;
}

/** A source-owned diagnostic. `sourceId` identifies a language server or
 * task definition, while `ownerRunId` lets future task runs replace only
 * their own output without disturbing LSP or another run's findings. */
export interface Problem {
  id: string;
  worktreeId: string;
  sourceKind: ProblemSourceKind;
  sourceId: string;
  ownerRunId?: string;
  uri: string;
  relativePath: string;
  range: ProblemRange;
  severity: ProblemSeverity;
  message: string;
  code?: string;
  relatedInformation?: ProblemRelatedInformation[];
  tags?: Array<"unnecessary" | "deprecated">;
  observedDocumentVersion?: number;
  observedAt: number;
  stale: boolean;
}

export interface ProblemSummary {
  total: number;
  error: number;
  warning: number;
  info: number;
  hint: number;
  stale: number;
  highestSeverity?: ProblemSeverity;
}
