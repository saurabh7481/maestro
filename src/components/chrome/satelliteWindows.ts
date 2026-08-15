import { emit, listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { useTabsStore, type Tab } from "../../state/tabsStore";
import { useOpenFilesStore } from "../../state/openFilesStore";
import { useToastStore } from "../../state/toastStore";
import { useAgentSessionStore, type AgentTabState } from "../../state/agentSessionStore";
import { exportTerminalBuffer, seedTerminalBuffer } from "../../state/terminalSessionStore";
import { useSatelliteStore } from "../../state/satelliteStore";

/** Detached windows (docs/V2_ROADMAP.md Phase 13).
 *
 * A satellite is a second Tauri window running the same frontend in a
 * reduced "mini shell" mode (`SatelliteShell.tsx`): its own tab strip,
 * its own panes, splitting and reordering inside it, and a dock button
 * that hands its tabs back.
 *
 * What makes this work without any shared state layer is that the things
 * a detached tab actually depends on don't live in the window at all:
 * agent runs and PTY terminals live in Rust (`AppState.agent_runs`,
 * `AppState.terminals`) and stream over app-wide Tauri events, which
 * *every* window receives. Moving a tab is therefore a matter of moving
 * its descriptor, not its process — the shell keeps running, uninterrupted,
 * while its tab changes windows.
 *
 * The transcript and scrollback a user has already accumulated *are*
 * per-window, so those ride along in the handover payload rather than the
 * detached tab opening blank. The origin window keeps its own listeners
 * alive, so both windows stay in sync and docking back returns to an
 * up-to-date tab.
 */

const HANDOVER_EVENT = "maestro://satellite/handover";
const READY_EVENT = "maestro://satellite/ready";
const DOCK_EVENT = "maestro://satellite/dock";

export const SATELLITE_LABEL_PREFIX = "satellite-";

export interface SatelliteHandover {
  label: string;
  tabs: Tab[];
  activeTabId: string | null;
  /** Agent transcripts, so a detached agent tab isn't blank. */
  agentRuns: Record<string, AgentTabState>;
  /** Base64 PTY scrollback, so a detached terminal isn't blank. */
  terminalReplays: Record<string, string>;
}

interface DockRequest {
  label: string;
  tabs: Tab[];
}

/** This window's Tauri label, defensively.
 *
 * `getCurrentWindow()` reads `window.__TAURI_INTERNALS__.metadata
 * .currentWindow.label`, which is injected by an initialization script —
 * so it throws a bare `TypeError` anywhere that script hasn't run
 * (a browser tab pointed at the dev server, a unit test, a webview whose
 * init scripts haven't landed yet). Thrown from module scope that would
 * take down the entire module graph before React or the error handlers
 * exist, which shows up as a blank white window with nothing in the log.
 * Treating an unknown label as the main window is both the safe default
 * and the correct one: satellites are only ever created with an explicit
 * label. */
export function currentWindowLabel(): string {
  try {
    return getCurrentWindow()?.label ?? "main";
  } catch {
    return "main";
  }
}

export function isSatelliteWindow(): boolean {
  return currentWindowLabel().startsWith(SATELLITE_LABEL_PREFIX);
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

/** Everything the receiving window needs to render these tabs as they
 * looked in the window they left. */
export function buildHandover(label: string, tabs: Tab[]): SatelliteHandover {
  const agentRuns: Record<string, AgentTabState> = {};
  const terminalReplays: Record<string, string> = {};
  const agentState = useAgentSessionStore.getState().byRunId;
  for (const tab of tabs) {
    if (tab.type === "agent" && agentState[tab.id]) agentRuns[tab.id] = agentState[tab.id];
    if (tab.type === "terminal") {
      const buffer = exportTerminalBuffer(tab.id);
      if (buffer) terminalReplays[tab.id] = bytesToBase64(buffer);
    }
  }
  return {
    label,
    tabs,
    activeTabId: tabs[tabs.length - 1]?.id ?? null,
    agentRuns,
    terminalReplays,
  };
}

/** Handovers waiting for their window to finish booting. A satellite
 * announces itself when its React tree mounts, which is well after
 * `WebviewWindow`'s own "created" event — emitting the payload before
 * then would go to a window with no listener yet. */
const pending = new Map<string, SatelliteHandover>();

/** Moves one tab into a brand-new window. */
export async function detachTabToNewWindow(tabId: string): Promise<void> {
  const tab = useTabsStore.getState().tabs.find((candidate) => candidate.id === tabId);
  if (!tab) return;

  // Unsaved edits live in this window's Monaco model, which the new
  // window has no access to — it would re-read the file from disk and the
  // edits would be silently gone. Refusing beats losing work.
  if (useOpenFilesStore.getState().byTabId[tabId]?.dirty) {
    useToastStore.getState().push({
      tone: "error",
      title: "Save before moving this tab",
      description: `${tab.title} has unsaved changes.`,
    });
    return;
  }

  const label = `${SATELLITE_LABEL_PREFIX}${crypto.randomUUID()}`;
  const handover = buildHandover(label, [tab]);
  pending.set(label, handover);

  try {
    const webview = new WebviewWindow(label, {
      url: "index.html",
      title: tab.title,
      width: 900,
      height: 640,
      minWidth: 480,
      minHeight: 360,
      decorations: false,
    });
    await new Promise<void>((resolve, reject) => {
      void webview.once("tauri://created", () => resolve());
      void webview.once("tauri://error", (event) => reject(new Error(String(event.payload))));
    });
  } catch (error) {
    pending.delete(label);
    useToastStore.getState().push({
      tone: "error",
      title: "Couldn't open a new window",
      description: String(error),
    });
    return;
  }

  useSatelliteStore.getState().track(label, [tab]);
  // Released only once the window exists: a failed creation must leave the
  // tab exactly where it was, not vanish it.
  useTabsStore.getState().releaseTabs([tabId]);
}

/** Reopens the detached windows a previous session left behind
 * (`design/useSessionPersistence.ts`). Labels are reused: the windows
 * they named are gone with the process that owned them, and reusing the
 * label keeps the saved session stable across repeated restarts.
 *
 * What comes back is the *layout* — which tabs were in which window. The
 * agent and terminal processes behind them were killed on quit
 * (docs/CHECKLIST.md), exactly as for a restored main-window tab. */
export async function restoreSatelliteWindows(
  records: { label: string; tabs: Tab[] }[],
): Promise<void> {
  for (const record of records) {
    pending.set(record.label, buildHandover(record.label, record.tabs));
    try {
      const webview = new WebviewWindow(record.label, {
        url: "index.html",
        title: record.tabs[0]?.title ?? "Maestro",
        width: 900,
        height: 640,
        minWidth: 480,
        minHeight: 360,
        decorations: false,
      });
      await new Promise<void>((resolve, reject) => {
        void webview.once("tauri://created", () => resolve());
        void webview.once("tauri://error", (event) => reject(new Error(String(event.payload))));
      });
      useSatelliteStore.getState().track(record.label, record.tabs);
    } catch {
      // A window that won't reopen shouldn't strand its tabs — they come
      // back into the main window instead, which is strictly better than
      // silently dropping them.
      pending.delete(record.label);
      useSatelliteStore.getState().forget(record.label);
      useTabsStore.getState().adoptTabs(record.tabs);
    }
  }
}

/** Main-window side of the protocol. Mounted once by `AppShell`. */
export function listenForSatellites(): () => void {
  const unlistenPromises = [
    listen<{ label: string }>(READY_EVENT, (event) => {
      const handover = pending.get(event.payload.label);
      if (!handover) return;
      pending.delete(event.payload.label);
      void emit(HANDOVER_EVENT, handover);
    }),

    listen<DockRequest>(DOCK_EVENT, (event) => {
      const { label, tabs } = event.payload;
      if (tabs.length > 0) useTabsStore.getState().adoptTabs(tabs);
      useSatelliteStore.getState().forget(label);
      void getCurrentWindow().setFocus();
    }),
  ];

  return () => {
    for (const promise of unlistenPromises) void promise.then((unlisten) => unlisten());
  };
}

/** Satellite side: announce readiness and take delivery of the tabs this
 * window was opened for. Resolves once they've arrived (or immediately,
 * for a window restored from a previous session that already has them). */
export function requestHandover(onReceive: (handover: SatelliteHandover) => void): () => void {
  const label = getCurrentWindow().label;
  const unlistenPromise = listen<SatelliteHandover>(HANDOVER_EVENT, (event) => {
    if (event.payload.label !== label) return;
    for (const [terminalId, base64] of Object.entries(event.payload.terminalReplays ?? {})) {
      seedTerminalBuffer(terminalId, base64ToBytes(base64));
    }
    for (const [runId, state] of Object.entries(event.payload.agentRuns ?? {})) {
      useAgentSessionStore.getState().adoptRun(runId, state);
    }
    onReceive(event.payload);
  });
  void emit(READY_EVENT, { label });
  return () => void unlistenPromise.then((unlisten) => unlisten());
}

/** Satellite side: hand every tab back to the main window and close. Used
 * by the dock button, the command palette action, and the window's own
 * close button — closing a detached window returns its tabs rather than
 * stranding their processes with no visible tab. */
export async function dockAllToMainWindow(): Promise<void> {
  const window = getCurrentWindow();
  const tabs = useTabsStore.getState().tabs;
  await emit(DOCK_EVENT, { label: window.label, tabs } satisfies DockRequest);
  // Released before closing so a tab can't be adopted twice if the close
  // is somehow cancelled downstream.
  useTabsStore.getState().releaseTabs(tabs.map((tab) => tab.id));
  await window.destroy();
}
