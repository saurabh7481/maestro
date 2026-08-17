import { beforeEach, describe, expect, it } from "vitest";
import { useUiStore } from "./uiStore";

/** The activity rail's icons are the only way into most of these views, so
 * their open/collapse semantics are worth pinning down: every icon has to
 * do something on every click, whatever the panel's current state. */
describe("uiStore sidebar views", () => {
  beforeEach(() => {
    useUiStore.setState({ sidebarView: "explorer", rightSidebarOpen: true, settingsOpen: false });
  });

  it("reveals the panel when a view is shown while it is collapsed", () => {
    useUiStore.setState({ rightSidebarOpen: false });
    useUiStore.getState().setSidebarView("scm");
    expect(useUiStore.getState()).toMatchObject({ sidebarView: "scm", rightSidebarOpen: true });
  });

  it("switches to another view and reveals the panel", () => {
    useUiStore.setState({ rightSidebarOpen: false });
    useUiStore.getState().toggleSidebarView("search");
    expect(useUiStore.getState()).toMatchObject({ sidebarView: "search", rightSidebarOpen: true });
  });

  it("collapses the panel when the view already showing is picked again", () => {
    useUiStore.getState().toggleSidebarView("explorer");
    expect(useUiStore.getState()).toMatchObject({
      sidebarView: "explorer",
      rightSidebarOpen: false,
    });
  });

  it("re-opens on the same view rather than staying collapsed", () => {
    useUiStore.getState().toggleSidebarView("explorer");
    useUiStore.getState().toggleSidebarView("explorer");
    expect(useUiStore.getState().rightSidebarOpen).toBe(true);
  });

  it("leaves the panel open when moving between views", () => {
    useUiStore.getState().toggleSidebarView("scm");
    useUiStore.getState().toggleSidebarView("history");
    expect(useUiStore.getState()).toMatchObject({ sidebarView: "history", rightSidebarOpen: true });
  });

  it("closes settings, which renders over the panel", () => {
    useUiStore.setState({ settingsOpen: true });
    useUiStore.getState().toggleSidebarView("problems");
    expect(useUiStore.getState().settingsOpen).toBe(false);
  });
});
