import "@testing-library/jest-dom/vitest";
import { vi } from "vitest";

// Components call Tauri APIs directly (window controls, persisted prefs).
// jsdom has no Tauri runtime, so stub the surface area used by the UI —
// every phase from here on touches more of it, so this stays a living list
// rather than something to special-case per test file.
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    minimize: vi.fn().mockResolvedValue(undefined),
    toggleMaximize: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
  }),
}));

vi.mock("@tauri-apps/plugin-store", () => ({
  load: vi.fn().mockResolvedValue({
    get: vi.fn().mockResolvedValue(undefined),
    set: vi.fn().mockResolvedValue(undefined),
  }),
}));
