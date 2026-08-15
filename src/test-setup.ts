import "@testing-library/jest-dom/vitest";
import { afterEach, vi } from "vitest";
import { cleanup } from "@testing-library/react";

// Testing Library only auto-cleans when Vitest runs with `globals: true`,
// which this project doesn't — without this, a second `render()` in the
// same file leaves the first one's DOM in `document.body` and every
// `getAllBy*` count is silently wrong.
afterEach(cleanup);

// Components call Tauri APIs directly (window controls, persisted prefs).
// jsdom has no Tauri runtime, so stub the surface area used by the UI —
// every phase from here on touches more of it, so this stays a living list
// rather than something to special-case per test file.
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    // The label decides which shell a window renders (`App.tsx`) — the
    // main one under test, rather than a detached tab window.
    label: "main",
    minimize: vi.fn().mockResolvedValue(undefined),
    setFocus: vi.fn().mockResolvedValue(undefined),
    toggleMaximize: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    destroy: vi.fn().mockResolvedValue(undefined),
    onCloseRequested: vi.fn().mockResolvedValue(() => {}),
  }),
}));

// Cross-window messaging (detached tab windows) — no-ops under jsdom,
// where there is exactly one window and no Tauri event bus.
vi.mock("@tauri-apps/api/event", () => ({
  emit: vi.fn().mockResolvedValue(undefined),
  listen: vi.fn().mockResolvedValue(() => {}),
}));

vi.mock("@tauri-apps/plugin-store", () => ({
  load: vi.fn().mockResolvedValue({
    get: vi.fn().mockResolvedValue(undefined),
    set: vi.fn().mockResolvedValue(undefined),
  }),
}));

// jsdom doesn't implement the (deprecated but still-checked) execCommand
// clipboard APIs Monaco probes at module-load time — polyfill so importing
// anything that pulls in `monaco-editor` doesn't throw before a single test
// even runs.
if (typeof document.queryCommandSupported !== "function") {
  document.queryCommandSupported = () => false;
}

// Monaco observes OS contrast/theme media queries. jsdom omits matchMedia,
// which otherwise surfaces as delayed unhandled errors after model creation.
if (typeof window.matchMedia !== "function") {
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn().mockReturnValue(false),
  }));
}
