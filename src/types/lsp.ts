export const LSP_SERVER_KINDS = ["typeScript", "rustAnalyzer", "pyright", "gopls"] as const;
export type LspServerKind = (typeof LSP_SERVER_KINDS)[number];

export type LspAvailability = "ready" | "missing" | "notExecutable" | "timedOut" | "probeFailed";

export interface LspServerStatus {
  kind: LspServerKind;
  displayName: string;
  availability: LspAvailability;
  binaryPath: string;
  serverArgs: string[];
  version: string | null;
  detail: string | null;
  installHint: string;
  checkedAt: string;
}

export interface GlobalLspSettings {
  enabled: boolean;
}

export interface ProjectLspSettings {
  enabledOverride: boolean | null;
  effectiveEnabled: boolean;
}

export interface LspProcessKey {
  worktreeId: string;
  kind: LspServerKind;
}

export interface RunningLspServer {
  key: LspProcessKey;
  generation: string;
  pid: number | null;
  typeScriptSdk: {
    path: string;
    version: string | null;
    source: string;
  } | null;
}

export type LspTransportEvent =
  | { type: "started"; generation: string; pid: number | null }
  | { type: "message"; message: string }
  | { type: "stderr"; line: string }
  | { type: "protocolError"; message: string; fatal: boolean }
  | { type: "exited"; code: number | null; requested: boolean; detail: string | null };
