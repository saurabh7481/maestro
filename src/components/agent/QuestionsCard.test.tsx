import { createElement } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "../primitives";
import { QuestionsCard } from "./QuestionsCard";
import { formatQuestionAnswers, readQuestionArtifact } from "./questionArtifact";
import { buildResponseBlocks } from "./processingBlocks";
import type { ToolCallItem } from "./processingBlocks";
import type { TranscriptItem } from "../../state/agentSessionStore";

/** The shape captured live from cursor-agent 2026.09.02-c22c1a3 (see
 * `src-tauri/tests/fixtures/cursor/06_ask_question.jsonl`). */
const input = {
  title: "Payments feature scope",
  questions: [
    {
      id: "scope",
      prompt: "What should the first version support?",
      options: [
        { id: "checkout", label: "One-time checkout payments (Recommended)" },
        { id: "subscriptions", label: "Recurring subscriptions" },
      ],
      allowMultiple: false,
    },
    {
      id: "methods",
      prompt: "Which payment methods are required initially?",
      options: [
        { id: "cards", label: "Cards" },
        { id: "upi", label: "UPI" },
      ],
      allowMultiple: true,
    },
  ],
  runAsync: false,
  asyncOriginalToolCallId: "",
};

const item: ToolCallItem = {
  id: "ask",
  kind: "toolCall",
  toolCallId: "ask-1",
  name: "AskQuestion",
  input,
};

describe("readQuestionArtifact", () => {
  it("reads Cursor's question form", () => {
    const artifact = readQuestionArtifact(input);
    expect(artifact.title).toBe("Payments feature scope");
    expect(artifact.questions).toHaveLength(2);
    expect(artifact.questions[1].allowMultiple).toBe(true);
    expect(artifact.questions[0].options[0].label).toBe("One-time checkout payments (Recommended)");
  });

  it("ignores payloads that aren't a question form", () => {
    expect(readQuestionArtifact({ command: "ls" }).questions).toEqual([]);
    expect(readQuestionArtifact("ls").questions).toEqual([]);
  });

  it("sends an untouched question as an explicit non-answer", () => {
    const text = formatQuestionAnswers(readQuestionArtifact(input), { scope: ["checkout"] }, "");
    expect(text).toContain("One-time checkout payments (Recommended)");
    expect(text).toContain("no preference, you decide");
  });
});

describe("buildResponseBlocks", () => {
  it("promotes a skipped question form out of the activity card", () => {
    const items: TranscriptItem[] = [item];
    expect(buildResponseBlocks(items, false)).toEqual([{ kind: "questions", item }]);
  });

  it("recognizes transcripts recorded before the tool had a name", () => {
    const legacy: TranscriptItem = { ...item, name: "Tool" };
    expect(buildResponseBlocks([legacy], false)).toEqual([{ kind: "questions", item: legacy }]);
  });
});

describe("QuestionsCard", () => {
  it("sends the picked answers as the next message", () => {
    const onSubmit = vi.fn();
    render(
      createElement(
        TooltipProvider,
        null,
        createElement(QuestionsCard, { item, onSubmit, canSubmit: true }),
      ),
    );

    // Nothing picked yet: sending would say nothing the agent didn't
    // already assume.
    expect(screen.getByRole("button", { name: "Send answers" })).toBeDisabled();

    fireEvent.click(screen.getByText("Recurring subscriptions"));
    fireEvent.click(screen.getByText("Cards"));
    fireEvent.click(screen.getByText("UPI"));
    fireEvent.click(screen.getByRole("button", { name: "Send answers" }));

    expect(onSubmit).toHaveBeenCalledTimes(1);
    const text = onSubmit.mock.calls[0][0] as string;
    expect(text).toContain("What should the first version support?");
    expect(text).toContain("Recurring subscriptions");
    expect(text).toContain("Cards; UPI");
    // One answer per question, so the card can't be sent twice.
    expect(screen.getByRole("button", { name: "Send answers" })).toBeDisabled();
  });

  it("cannot be answered while the turn that asked is still running", () => {
    render(
      createElement(
        TooltipProvider,
        null,
        createElement(QuestionsCard, { item, onSubmit: () => {}, canSubmit: false }),
      ),
    );
    fireEvent.click(screen.getByText("Cards"));
    expect(screen.getByRole("button", { name: "Send answers" })).toBeDisabled();
  });
});
