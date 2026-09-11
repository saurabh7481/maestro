import { getToken } from "./auth";
import type {
  AgentCapabilities,
  AgentConfiguration,
  AgentKind,
  ManagedProcess,
  ModelOption,
  PermissionDecision,
  PermissionMode,
  PermissionOutcome,
  Project,
  RelayDevice,
  StoredTranscript,
  WhoAmI,
  Worktree,
} from "./types";

/** Same-origin by default — the mobile app is served by the relay itself
 * (`relay/server.rs`'s static fallback), so a relative `fetch("/api/...")`
 * already reaches it whether that origin is `https://<funnel-hostname>` on
 * a phone or `http://127.0.0.1:51823` when testing locally. Overridable
 * only for `pnpm --filter mobile dev`, where Vite's own dev server (port
 * 4173) isn't the relay. */
const API_BASE: string = (import.meta.env.VITE_API_BASE as string | undefined) ?? "";

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const token = getToken();
  const headers = new Headers(init?.headers);
  if (token) headers.set("Authorization", `Bearer ${token}`);
  if (init?.body) headers.set("Content-Type", "application/json");
  const res = await fetch(`${API_BASE}${path}`, { ...init, headers });
  if (!res.ok) {
    let message = res.statusText;
    try {
      const body: unknown = await res.json();
      if (body && typeof body === "object" && "error" in body) {
        message = String((body as { error: unknown }).error);
      }
    } catch {
      // Non-JSON error body — fall back to the status text above.
    }
    throw new ApiError(res.status, message);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

function post<T>(path: string, body?: unknown): Promise<T> {
  return request<T>(path, { method: "POST", body: body ? JSON.stringify(body) : undefined });
}

/** The relay's own `?token=` convention for WebSocket auth (browsers can't
 * set custom headers on `new WebSocket()`) — see `relay/auth.rs`. Resolves
 * against the current page origin so it works identically over the Funnel
 * `https://` origin (as `wss://`) and a local `http://` origin (as `ws://`). */
export function wsUrl(path: string): string {
  const token = getToken() ?? "";
  const base = API_BASE || window.location.origin;
  const url = new URL(path, base);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.searchParams.set("token", token);
  return url.toString();
}

export interface ExchangeResult {
  deviceId: string;
  token: string;
}

export const relayClient = {
  exchangePairingCode: (code: string, deviceName: string) =>
    post<ExchangeResult>("/api/pair/exchange", { code, deviceName }),
  whoAmI: () => request<WhoAmI>("/api/me"),

  listProjects: () => request<Project[]>("/api/projects"),
  listWorktrees: (projectId: string) =>
    request<Worktree[]>(`/api/projects/${encodeURIComponent(projectId)}/worktrees`),
  listSessions: (worktreeId: string) =>
    request<ManagedProcess[]>(`/api/worktrees/${encodeURIComponent(worktreeId)}/sessions`),
  /** Every agent/terminal session across every worktree — what the tab
   * dock polls, so a session started on the desktop shows up without the
   * user having to go find it first. */
  listAllSessions: () => request<ManagedProcess[]>("/api/sessions"),
  listWorktreeFiles: (worktreeId: string) =>
    request<string[]>(`/api/worktrees/${encodeURIComponent(worktreeId)}/files`),

  createAgentSession: (
    worktreeId: string,
    body: {
      kind: AgentKind;
      firstMessage: string;
      model?: string;
      effort?: string;
      fast?: boolean;
      permissionMode?: PermissionMode;
    },
  ) => post<{ runId: string }>(`/api/worktrees/${encodeURIComponent(worktreeId)}/agents`, body),
  getAgentTranscript: (runId: string) =>
    request<StoredTranscript | null>(`/api/agents/${encodeURIComponent(runId)}/transcript`),
  getAgentModels: (kind: AgentKind) => request<ModelOption[]>(`/api/agent-models/${kind}`),
  getAgentCapabilities: (kind: AgentKind) =>
    request<AgentCapabilities>(`/api/agent-capabilities/${kind}`),
  sendAgentMessage: (runId: string, text: string) =>
    post<void>(`/api/agents/${encodeURIComponent(runId)}/message`, { text }),
  setAgentConfiguration: (
    runId: string,
    body: { model?: string | null; effort?: string | null; fast?: boolean },
  ) => post<void>(`/api/agents/${encodeURIComponent(runId)}/configuration`, body),
  getAgentConfiguration: (runId: string) =>
    request<AgentConfiguration | null>(`/api/agents/${encodeURIComponent(runId)}/config`),
  setPermissionMode: (runId: string, mode: PermissionMode) =>
    post<void>(`/api/agents/${encodeURIComponent(runId)}/permission-mode`, { mode }),
  respondToPermission: (runId: string, decision: PermissionDecision) =>
    post<PermissionOutcome>(`/api/agents/${encodeURIComponent(runId)}/permission`, decision),
  interruptAgent: (runId: string) =>
    post<void>(`/api/agents/${encodeURIComponent(runId)}/interrupt`),
  killAgent: (runId: string) => post<void>(`/api/agents/${encodeURIComponent(runId)}/kill`),

  getTerminalScrollback: (terminalId: string) =>
    request<{ text: string }>(`/api/terminals/${encodeURIComponent(terminalId)}/scrollback`),
  writeTerminal: (terminalId: string, data: string) =>
    post<void>(`/api/terminals/${encodeURIComponent(terminalId)}/write`, { data }),
  resizeTerminal: (terminalId: string, rows: number, cols: number) =>
    post<void>(`/api/terminals/${encodeURIComponent(terminalId)}/resize`, { rows, cols }),
  killTerminal: (terminalId: string) =>
    post<void>(`/api/terminals/${encodeURIComponent(terminalId)}/kill`),

  listDevices: () => request<RelayDevice[]>("/api/devices"),
  revokeDevice: (deviceId: string) =>
    post<void>(`/api/devices/${encodeURIComponent(deviceId)}/revoke`),
};
