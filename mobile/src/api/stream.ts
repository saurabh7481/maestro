import { wsUrl } from "./client";

/** Opens a reconnecting WebSocket against a relay stream route
 * (`/api/agents/{id}/stream` or `/api/terminals/{id}/stream`). A phone's
 * network is expected to drop and hand off (WiFi↔cellular, sleep/wake) far
 * more than a desktop's ever does, so unlike the desktop's own Tauri
 * `listen()` (a stable in-process channel), this has to actually retry.
 * Exponential backoff capped at 10s; resets to the fast retry once a
 * connection is held open for a few seconds, so one real drop doesn't
 * leave a session crawling back for minutes. */
export function openStream(
  /** A function, not a string, when the URL has to change between
   * attempts: the agent stream appends `?since=<lastSeq>` so a reconnect
   * asks for exactly the events it missed, and that sequence advances with
   * every frame received. Evaluated fresh on each connect. */
  path: string | (() => string),
  onMessage: (raw: string) => void,
  onStatus?: (status: "connecting" | "open" | "closed") => void,
): () => void {
  let socket: WebSocket | null = null;
  let stopped = false;
  let attempt = 0;
  let retryTimer: number | undefined;
  let openedAt = 0;

  function scheduleRetry() {
    if (stopped) return;
    const delay = Math.min(10_000, 500 * 2 ** attempt);
    attempt += 1;
    retryTimer = window.setTimeout(connect, delay);
  }

  function connect() {
    if (stopped) return;
    onStatus?.("connecting");
    const ws = new WebSocket(wsUrl(typeof path === "function" ? path() : path));
    socket = ws;
    ws.onopen = () => {
      openedAt = Date.now();
      onStatus?.("open");
    };
    ws.onmessage = (event) => {
      if (typeof event.data === "string") onMessage(event.data);
    };
    ws.onclose = () => {
      onStatus?.("closed");
      if (Date.now() - openedAt > 5000) attempt = 0;
      scheduleRetry();
    };
    ws.onerror = () => ws.close();
  }

  connect();

  return () => {
    stopped = true;
    if (retryTimer !== undefined) window.clearTimeout(retryTimer);
    socket?.close();
  };
}
