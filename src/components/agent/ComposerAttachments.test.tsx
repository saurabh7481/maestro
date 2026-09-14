import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const agentsApi = { readAttachmentPreview: vi.fn() };
vi.mock("../../api/agents", () => ({ agentsApi }));

const { ComposerAttachments, isImagePath, attachmentName } = await import("./ComposerAttachments");

const PNG = "data:image/png;base64,iVBORw0KGgo=";

const image = { relPath: ".maestro/attachments/shot.png", name: "shot.png", isImage: true };
const doc = { relPath: ".maestro/attachments/report.pdf", name: "report.pdf", isImage: false };

function renderStrip(attachments: (typeof image)[], onRemove = vi.fn()) {
  render(
    <ComposerAttachments attachments={attachments} worktreeRoot="/repo" onRemove={onRemove} />,
  );
  return onRemove;
}

describe("ComposerAttachments", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    agentsApi.readAttachmentPreview.mockResolvedValue(PNG);
  });

  it("renders nothing when there is nothing staged", () => {
    const { container } = render(
      <ComposerAttachments attachments={[]} worktreeRoot="/repo" onRemove={vi.fn()} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("shows a pasted image as a thumbnail, not its path", async () => {
    renderStrip([image]);

    const thumb = await screen.findByAltText("shot.png");
    expect(thumb.getAttribute("src")).toBe(PNG);
    expect(screen.queryByText(image.relPath)).toBeNull();
  });

  it("shows a document by name instead of trying to preview it", async () => {
    renderStrip([doc]);

    expect(screen.getByText("report.pdf")).toBeTruthy();
    // Non-images are never asked for a preview.
    expect(agentsApi.readAttachmentPreview).not.toHaveBeenCalled();
  });

  it("falls back to a named card when the preview can't be read", async () => {
    agentsApi.readAttachmentPreview.mockRejectedValue(new Error("gone"));
    renderStrip([image]);

    await waitFor(() => expect(agentsApi.readAttachmentPreview).toHaveBeenCalled());
    expect(screen.getByText("shot.png")).toBeTruthy();
    expect(screen.queryByAltText("shot.png")).toBeNull();
  });

  it("removes the attachment the cross belongs to", async () => {
    const onRemove = renderStrip([image, doc]);

    fireEvent.click(screen.getByLabelText("Remove report.pdf"));
    expect(onRemove).toHaveBeenCalledWith(doc.relPath);
  });

  it("expands an image on click and dismisses it on a click outside", async () => {
    renderStrip([image]);
    await screen.findByAltText("shot.png");

    fireEvent.click(screen.getByLabelText("Expand shot.png"));
    const dialog = screen.getByRole("dialog");
    expect(dialog).toBeTruthy();

    // Clicking the image itself must not dismiss it.
    fireEvent.click(screen.getAllByAltText("shot.png")[1]);
    expect(screen.queryByRole("dialog")).toBeTruthy();

    fireEvent.click(dialog);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("dismisses the expanded image on Escape", async () => {
    renderStrip([image]);
    await screen.findByAltText("shot.png");

    fireEvent.click(screen.getByLabelText("Expand shot.png"));
    expect(screen.getByRole("dialog")).toBeTruthy();

    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

describe("attachment path helpers", () => {
  it("recognises the image extensions the backend previews", () => {
    for (const path of ["a/b.png", "x.JPEG", "s.webp", "i.svg", "p.avif"]) {
      expect(isImagePath(path)).toBe(true);
    }
    for (const path of ["notes.pdf", "data.csv", "README", "a.png.txt"]) {
      expect(isImagePath(path)).toBe(false);
    }
  });

  it("names an attachment by its basename", () => {
    expect(attachmentName(".maestro/attachments/pasted-image-3.png")).toBe("pasted-image-3.png");
    expect(attachmentName("bare.txt")).toBe("bare.txt");
  });
});
