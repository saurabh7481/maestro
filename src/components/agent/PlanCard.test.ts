import { createElement } from "react";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { TooltipProvider } from "../primitives";
import { PlanCard } from "./PlanCard";
import { readPlanArtifact } from "./planArtifact";
import type { ToolCallItem } from "./processingBlocks";

describe("readPlanArtifact", () => {
  it("reads Cursor's named plan artifact", () => {
    expect(
      readPlanArtifact({
        name: "Payment rollout",
        overview: "Ship recurring payments safely.",
        plan: "# Payment rollout\n1. Add durable models.",
        todos: [],
      }),
    ).toEqual({
      title: "Payment rollout",
      overview: "Ship recurring payments safely.",
      text: "# Payment rollout\n1. Add durable models.",
    });
  });

  it("falls back to Cursor's structured todos when plan Markdown is absent", () => {
    expect(
      readPlanArtifact({
        name: "Fallback plan",
        todos: [
          { content: "Inspect the code", status: "TODO_STATUS_COMPLETED" },
          { content: "Implement the fix", status: "TODO_STATUS_PENDING" },
        ],
      }).text,
    ).toBe("- [x] Inspect the code\n- [ ] Implement the fix");
  });

  it("keeps the string input used by existing providers", () => {
    expect(readPlanArtifact("Do the thing.").text).toBe("Do the thing.");
  });

  it("renders Cursor's artifact title, overview, Markdown, and approval action", () => {
    const item: ToolCallItem = {
      id: "plan",
      kind: "toolCall",
      toolCallId: "plan-1",
      name: "CreatePlan",
      input: {
        name: "Payment rollout",
        overview: "Ship recurring payments safely.",
        plan: "1. Add durable models.\n2. Verify webhooks.",
      },
    };

    render(
      createElement(
        TooltipProvider,
        null,
        createElement(PlanCard, { item, onApprove: () => {}, canApprove: true }),
      ),
    );

    expect(screen.getByText("Payment rollout")).toBeInTheDocument();
    expect(screen.getByText("Ship recurring payments safely.")).toBeInTheDocument();
    expect(screen.getByText(/Verify webhooks\./)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Approve & start" })).toBeEnabled();
  });
});
