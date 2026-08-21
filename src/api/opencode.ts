import { invoke } from "@tauri-apps/api/core";
import type { AuthMethod, Authorization, ProviderOverview } from "../types/opencode";

/** Thin, typed wrapper around the OpenCode provider-management command
 * surface — same pattern as `agentsApi`. Every call projects on the Rust
 * side; nothing here ever sees credential material. */
export const opencodeApi = {
  /** Read-only supervisor snapshot. Never starts the server. */
  sidecarStatus: () => invoke<{ phase: string; handles: number }>("opencode_sidecar_status"),

  /** Pane-lifetime server hold (§2.2's "pane visible" consumer). Call on
   * mount, release the token on unmount. */
  acquireSidecar: () => invoke<number>("opencode_sidecar_acquire"),
  releaseSidecar: (token: number) => invoke<void>("opencode_sidecar_release", { token }),

  listProviders: (force = false) => invoke<ProviderOverview>("opencode_list_providers", { force }),
  providerAuthMethods: (providerId: string) =>
    invoke<AuthMethod[]>("opencode_provider_auth_methods", { providerId }),
  connectWithKey: (providerId: string, key: string) =>
    invoke<void>("opencode_connect_with_key", { providerId, key }),
  beginOauth: (providerId: string, methodIndex: number, inputs: [string, string][]) =>
    invoke<Authorization>("opencode_begin_oauth", { providerId, methodIndex, inputs }),
  /** Polled during an OAuth wait until this id turns up connected. */
  oauthStatus: (providerId: string) => invoke<boolean>("opencode_oauth_status", { providerId }),
  disconnect: (providerId: string) => invoke<void>("opencode_disconnect", { providerId }),
};
