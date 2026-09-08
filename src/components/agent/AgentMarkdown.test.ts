import { createElement } from "react";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { TooltipProvider } from "../primitives";
import { AgentMarkdown } from "./AgentMarkdown";
import { completedFencedCodeBodies } from "./fencedCodeBlocks";

describe("completedFencedCodeBodies", () => {
  it("returns closed blocks while ignoring the fence still being streamed", () => {
    const markdown = [
      "Before",
      "```ts",
      "const ready = true;",
      "```",
      "Between",
      "~~~sh",
      "echo still-streaming",
    ].join("\n");

    expect(completedFencedCodeBodies(markdown)).toEqual(["const ready = true;"]);
  });

  it("requires a closing marker at least as long as the opener", () => {
    const markdown = ["````js", "const value = 1;", "```", "still code", "````"].join("\n");
    expect(completedFencedCodeBodies(markdown)).toEqual(["const value = 1;\n```\nstill code"]);
  });
});

describe("AgentMarkdown code controls", () => {
  it("shows copy for a completed fence while later prose is still streaming", async () => {
    render(
      createElement(
        TooltipProvider,
        null,
        createElement(AgentMarkdown, {
          text: "```ts\nconst ready = true;\n```\nThe explanation is still arriving",
          streaming: true,
          showCopyButton: false,
        }),
      ),
    );

    expect(await screen.findByRole("button", { name: "Copy code" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Copy markdown" })).not.toBeInTheDocument();
  });
});
