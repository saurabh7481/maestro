/** Mirrors `src-tauri/src/agents/opencode/providers.rs` 1:1. Every type
 * here is a *projection* — the raw sidecar responses carry provider keys
 * (Phase O1 finding), and only these field-by-field structs may cross
 * IPC. If you find yourself wanting to add a passthrough, the answer is
 * a new optional field on one of these structs instead. */

export interface ProviderSummary {
  id: string;
  name: string;
}

export interface ConnectedProvider {
  id: string;
  name: string;
  modelCount: number;
  defaultModel: string | null;
}

export interface ProviderOverview {
  connected: ConnectedProvider[];
  /** Catalog minus already-connected ids — the "Add provider" rows. */
  available: ProviderSummary[];
}

/** One declarative auth method from GET /provider/auth. `index` is what
 * the OAuth authorize call wants back as `method`. */
export interface AuthMethod {
  index: number;
  kind: "api" | "oauth" | string;
  label: string;
  prompts: AuthPrompt[];
}

/** A conditional form field declared by the provider itself (e.g.
 * Copilot's deployment-type select revealing an enterprise-URL text
 * field). Rendered generically by the connect sheet. */
export interface AuthPrompt {
  kind: "select" | "text" | string;
  key: string;
  message: string;
  placeholder?: string;
  options: AuthPromptOption[];
  /** Show this prompt only when answers[when.key] === when.value. */
  when?: [string, string];
}

export interface AuthPromptOption {
  label: string;
  value: string;
  hint?: string;
}

export interface Authorization {
  url: string;
  /** "auto" (browser completes alone) or "code" (show a device code). */
  method: "auto" | "code" | string;
  instructions: string;
}
