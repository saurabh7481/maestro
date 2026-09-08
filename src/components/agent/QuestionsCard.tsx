import { memo, useState } from "react";
import { PaperPlaneTilt, Question } from "@phosphor-icons/react";
import { formatQuestionAnswers, readQuestionArtifact } from "./questionArtifact";
import type { ToolCallItem } from "./processingBlocks";
import styles from "./QuestionsCard.module.css";

/** The clarifying questions Cursor Agent asked and never got to show.
 *
 * In print mode the CLI answers its own question tool with "Questions
 * skipped by the user, continue with the information you already have"
 * and keeps going on assumptions — so the questions used to surface as a
 * *blocked* tool call, which read like a Maestro failure and left the
 * user with nothing to click. The form lives in the call's arguments, so
 * this card asks the questions for real; the answers go back as the next
 * message, which is the only channel a finished turn leaves open. */
export const QuestionsCard = memo(function QuestionsCard({
  item,
  onSubmit,
  canSubmit,
}: {
  item: ToolCallItem;
  /** Sends the composed answers as the next message. */
  onSubmit: (text: string) => void;
  /** False where answering isn't wired up — a transcript being read
   * back rather than a live run. A turn still in flight is *not* a
   * reason to disable it: the answers queue (see
   * `AgentTab.handleAnswerQuestions`). */
  canSubmit: boolean;
}) {
  const artifact = readQuestionArtifact(item.input);
  const [selections, setSelections] = useState<Record<string, string[]>>({});
  const [note, setNote] = useState("");
  const [sent, setSent] = useState(false);

  function toggle(questionId: string, optionId: string, allowMultiple: boolean) {
    setSelections((current) => {
      const picked = current[questionId] ?? [];
      if (!allowMultiple) {
        // Second click on the chosen answer clears it, which is the only
        // way back to "no preference" once a radio group has been touched.
        return { ...current, [questionId]: picked[0] === optionId ? [] : [optionId] };
      }
      return {
        ...current,
        [questionId]: picked.includes(optionId)
          ? picked.filter((id) => id !== optionId)
          : [...picked, optionId],
      };
    });
  }

  if (!artifact.questions.length) return null;

  const answered = artifact.questions.some((question) => selections[question.id]?.length);
  const ready = answered || !!note.trim();

  return (
    <section className={styles.card}>
      <header className={styles.header}>
        <span className={styles.icon}>
          <Question size={14} />
        </span>
        <span className={styles.heading}>
          <span className={styles.title}>{artifact.title ?? "The agent needs your input"}</span>
          <span className={styles.status}>
            {sent ? "Answers sent" : "Answer here — the agent continued on assumptions"}
          </span>
        </span>
      </header>
      <div className={styles.body}>
        {artifact.questions.map((question) => (
          <fieldset className={styles.question} key={question.id} disabled={sent}>
            <legend className={styles.prompt}>{question.prompt}</legend>
            <div className={styles.options}>
              {question.options.map((option) => {
                const picked = (selections[question.id] ?? []).includes(option.id);
                return (
                  <label
                    className={styles.option}
                    key={option.id}
                    data-picked={picked || undefined}
                  >
                    <input
                      className={styles.control}
                      type={question.allowMultiple ? "checkbox" : "radio"}
                      name={`${item.id}-${question.id}`}
                      checked={picked}
                      onChange={() => toggle(question.id, option.id, question.allowMultiple)}
                    />
                    {option.label}
                  </label>
                );
              })}
            </div>
          </fieldset>
        ))}
        <textarea
          className={styles.note}
          value={note}
          disabled={sent}
          onChange={(event) => setNote(event.target.value)}
          placeholder="Anything else the agent should know (optional)"
          rows={2}
        />
      </div>
      <footer className={styles.footer}>
        <span className={styles.hint}>
          {/* Unanswered questions are sent as "you decide" rather than
              omitted, so the agent doesn't ask them again. */}
          Unanswered questions are sent as “no preference”.
        </span>
        <button
          type="button"
          className={styles.send}
          disabled={!canSubmit || !ready || sent}
          title="Send these answers as your next message"
          onClick={() => {
            setSent(true);
            onSubmit(formatQuestionAnswers(artifact, selections, note));
          }}
        >
          <PaperPlaneTilt size={13} />
          Send answers
        </button>
      </footer>
    </section>
  );
});
