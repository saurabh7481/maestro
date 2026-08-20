import { describe, expect, it } from "vitest";
import { renderMermaidToSvg } from "./renderMermaid";

// Only the error-handling contract is unit-testable here — jsdom has no
// real layout engine (no real text metrics, no real SVG geometry), so
// mermaid's actual rendering (dagre graph layout, edge-path routing) can't
// run under it even with `getBBox` stubbed (`test-setup.ts`); it needs a
// real browser, which is why mermaid's own test suite doesn't unit-test
// full rendering under jsdom either. `CodeBlockControls`' render path is
// exercised manually against the real app instead.
describe("renderMermaidToSvg", () => {
  it("rejects malformed mermaid source instead of hanging", async () => {
    await expect(renderMermaidToSvg("flowchart TD\n  [[[not valid")).rejects.toBeDefined();
  });
});
