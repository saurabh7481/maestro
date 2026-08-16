import { describe, expect, it, vi } from "vitest";
import { resizeComposerTextarea } from "./composerSizing";

describe("resizeComposerTextarea", () => {
  it("grows to content and enables scrolling only at the cap", () => {
    const textarea = document.createElement("textarea");
    vi.spyOn(window, "getComputedStyle").mockReturnValue({
      maxHeight: "120px",
    } as CSSStyleDeclaration);
    Object.defineProperty(textarea, "scrollHeight", { configurable: true, value: 80 });
    resizeComposerTextarea(textarea);
    expect(textarea.style.height).toBe("80px");
    expect(textarea.style.overflowY).toBe("hidden");

    Object.defineProperty(textarea, "scrollHeight", { configurable: true, value: 220 });
    resizeComposerTextarea(textarea);
    expect(textarea.style.height).toBe("120px");
    expect(textarea.style.overflowY).toBe("auto");
  });
});
