import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fsApi = { readFile: vi.fn() };
vi.mock("../../api/fs", () => ({ fsApi }));
vi.mock("../../editor/modelBridge", () => ({ getEditorModel: () => undefined }));
vi.mock("../../design/renderMarkdown", () => ({
  useMarkdownHtml: (content: string | null | undefined) =>
    content == null ? "" : `<p>${content}</p>`,
}));

const { MarkdownPane } = await import("./MarkdownPane");
const { useOpenFilesStore } = await import("../../state/openFilesStore");

const tab = {
  id: "wt1:notes.md",
  type: "markdown" as const,
  title: "notes.md",
  filePath: "notes.md",
  worktreeRoot: "/repo",
};

/** jsdom does no layout, so a scroller reports every metric as 0 and the
 * restore below would decide the content is too short to hold the offset.
 * Stand in for the one thing it needs: a document taller than its box. */
function giveEveryElementHeight(scrollHeight: number, clientHeight: number) {
  const descriptors = {
    scrollHeight: Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollHeight"),
    clientHeight: Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientHeight"),
  };
  Object.defineProperty(HTMLElement.prototype, "scrollHeight", {
    configurable: true,
    get: () => scrollHeight,
  });
  Object.defineProperty(HTMLElement.prototype, "clientHeight", {
    configurable: true,
    get: () => clientHeight,
  });
  return () => {
    for (const [name, descriptor] of Object.entries(descriptors)) {
      if (descriptor) Object.defineProperty(HTMLElement.prototype, name, descriptor);
      else delete (HTMLElement.prototype as unknown as Record<string, unknown>)[name];
    }
  };
}

describe("MarkdownPane preview scrolling", () => {
  let restoreHeights: () => void;

  beforeEach(() => {
    vi.clearAllMocks();
    fsApi.readFile.mockResolvedValue({ kind: "text", content: "a long document" });
    useOpenFilesStore.getState().forget(tab.id);
    restoreHeights = giveEveryElementHeight(4000, 600);
    // jsdom has no ResizeObserver; the restore uses one to catch height
    // changes that a render doesn't announce. Observing nothing is fine
    // here — the content in this test is there by the time it mounts.
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
  });

  afterEach(() => {
    restoreHeights();
    vi.unstubAllGlobals();
  });

  async function renderPreview() {
    const view = render(<MarkdownPane tab={tab} />);
    await waitFor(() => expect(screen.getByText("a long document")).toBeTruthy());
    const scroller = view.container.querySelector("div[class*='previewScroller']");
    if (!(scroller instanceof HTMLElement)) throw new Error("no preview scroller");
    return { view, scroller };
  }

  it("comes back to where the reader left off after a tab switch", async () => {
    const first = await renderPreview();
    fireEvent.scroll(first.scroller, { target: { scrollTop: 1200 } });
    // A tab switch unmounts the pane outright — `PaneView` renders only the
    // active tab's body.
    first.view.unmount();

    const second = await renderPreview();
    expect(second.scroller.scrollTop).toBe(1200);
  });

  it("opens at the top when the reader never scrolled", async () => {
    const first = await renderPreview();
    first.view.unmount();

    const second = await renderPreview();
    expect(second.scroller.scrollTop).toBe(0);
  });

  it("forgets the offset once the tab is closed", async () => {
    const first = await renderPreview();
    fireEvent.scroll(first.scroller, { target: { scrollTop: 1200 } });
    first.view.unmount();
    useOpenFilesStore.getState().forget(tab.id);

    const second = await renderPreview();
    expect(second.scroller.scrollTop).toBe(0);
  });
});
