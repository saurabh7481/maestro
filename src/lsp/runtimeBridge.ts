import type { LspServerKind } from "../types/lsp";

type RuntimeControl = {
  retry: (kind: LspServerKind) => Promise<void>;
  refresh: () => Promise<void>;
};

let control: RuntimeControl | null = null;

/** Keeps Settings independent of Monaco's multi-megabyte runtime. The editor
 * registers this bridge only after its lazy chunk has been loaded. */
export function registerLspRuntimeControl(value: RuntimeControl) {
  control = value;
}

export function retryLspRuntime(kind: LspServerKind): Promise<void> {
  return control?.retry(kind) ?? Promise.resolve();
}

export function refreshLspRuntime(): Promise<void> {
  return control?.refresh() ?? Promise.resolve();
}
