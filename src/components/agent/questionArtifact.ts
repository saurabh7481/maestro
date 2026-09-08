/** The multiple-choice form Cursor Agent's `askQuestionToolCall` carries.
 *
 * Print mode has nobody to show a form to, so the CLI answers the call
 * itself with "Questions skipped by the user…" and carries on with
 * whatever it already knew — see `agents/cursor_agent.rs`. The questions
 * survive in the call's arguments, which is what lets Maestro ask them
 * for real and send the answers back as the next message. */
export interface QuestionOption {
  id: string;
  label: string;
}

export interface AgentQuestion {
  id: string;
  prompt: string;
  options: QuestionOption[];
  /** Checkboxes rather than a single choice. */
  allowMultiple: boolean;
}

export interface QuestionArtifact {
  title: string | null;
  questions: AgentQuestion[];
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function readOptions(value: unknown): QuestionOption[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((option, index) => {
      if (typeof option === "string") return { id: option, label: option };
      if (!option || typeof option !== "object") return null;
      const record = option as Record<string, unknown>;
      const label = nonEmptyString(record.label) ?? nonEmptyString(record.text);
      if (!label) return null;
      return { id: nonEmptyString(record.id) ?? `option-${index}`, label };
    })
    .filter((option): option is QuestionOption => !!option);
}

/** Pulls the form out of the provider-specific tool input. Tolerant by
 * design: a build that renames a field should cost the options, not the
 * whole card. */
export function readQuestionArtifact(input: unknown): QuestionArtifact {
  if (!input || typeof input !== "object") return { title: null, questions: [] };
  const record = input as Record<string, unknown>;
  const raw = Array.isArray(record.questions) ? record.questions : [];
  const questions = raw
    .map((question, index) => {
      if (!question || typeof question !== "object") return null;
      const value = question as Record<string, unknown>;
      const prompt = nonEmptyString(value.prompt) ?? nonEmptyString(value.question);
      if (!prompt) return null;
      return {
        id: nonEmptyString(value.id) ?? `question-${index}`,
        prompt,
        options: readOptions(value.options),
        allowMultiple: value.allowMultiple === true,
      };
    })
    .filter((question): question is AgentQuestion => !!question);
  return { title: nonEmptyString(record.title), questions };
}

/** Recognizes the payload even where the tool name doesn't say so —
 * transcripts recorded before Maestro knew `askQuestionToolCall` stored
 * it as a generic `Tool`, and repairing those on sight beats only fixing
 * conversations started after an app restart (the same allowance
 * `readPlanArtifact`'s caller makes). */
export function looksLikeQuestions(input: unknown): boolean {
  return readQuestionArtifact(input).questions.length > 0;
}

/** The message sent back to the agent. Prose rather than JSON: it is
 * being read by a model as the user's next turn, and the CLI has no
 * channel to deliver a structured answer to the call it already
 * closed. */
export function formatQuestionAnswers(
  artifact: QuestionArtifact,
  /** Selected option ids per question id. */
  selections: Record<string, string[]>,
  note: string,
): string {
  const lines = artifact.questions.map((question) => {
    const picked = (selections[question.id] ?? [])
      .map((id) => question.options.find((option) => option.id === id)?.label ?? id)
      .filter(Boolean);
    // An unanswered question is answered *deliberately* — saying so keeps
    // the agent from asking it again on the next turn.
    const answer = picked.length ? picked.join("; ") : "no preference, you decide";
    return `- ${question.prompt}\n  ${answer}`;
  });
  const trimmedNote = note.trim();
  return [
    "Answers to your questions:",
    "",
    lines.join("\n"),
    ...(trimmedNote ? ["", trimmedNote] : []),
  ].join("\n");
}
