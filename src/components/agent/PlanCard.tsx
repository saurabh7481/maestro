import { memo } from "react";
import { CheckCircle, Compass } from "@phosphor-icons/react";
import { AgentMarkdown } from "./AgentMarkdown";
import type { ToolCallItem } from "./processingBlocks";
import styles from "./PlanCard.module.css";

/** Pulls the plan text out of whatever shape the provider's plan-exit tool
 * uses. `plan` is Claude's field; the fallbacks mean a new provider whose
 * tool names the field differently still shows something rather than an
 * empty card. */
function planText(input: unknown): string | null {
  if (typeof input === "string") return input;
  if (!input || typeof input !== "object") return null;
  const record = input as Record<string, unknown>;
  for (const key of ["plan", "text", "content", "message"]) {
    if (typeof record[key] === "string" && record[key]) return record[key] as string;
  }
  return null;
}

/** The hand-off at the end of Plan mode, rendered as the decision it is.
 *
 * Plan mode's whole point is to stop and let you read a proposal before
 * anything runs, but the CLI signals that with an ordinary tool call — so
 * it used to land inside the collapsed activity card, three clicks from
 * view, with no way to say "go ahead" other than typing it. Which tool
 * counts as this signal is declared per provider
 * (`capabilities.planExitTool`), so a new CLI gets this card by naming its
 * own tool rather than by any change here. */
export const PlanCard = memo(function PlanCard({
  item,
  onApprove,
  canApprove,
}: {
  item: ToolCallItem;
  /** Leaves Plan mode and tells the agent to carry the plan out. */
  onApprove: () => void;
  /** False while a turn is still running — approving would collide with it. */
  canApprove: boolean;
}) {
  const text = planText(item.input);
  return (
    <section className={styles.card}>
      <header className={styles.header}>
        <span className={styles.icon}>
          <Compass size={14} />
        </span>
        <span className={styles.title}>Plan ready</span>
        <button
          type="button"
          className={styles.approve}
          onClick={onApprove}
          disabled={!canApprove}
          title={
            canApprove
              ? "Switch out of Plan mode and start work"
              : "Wait for the current turn to finish"
          }
        >
          <CheckCircle size={13} />
          Approve &amp; start
        </button>
      </header>
      {text ? (
        <div className={styles.body}>
          <AgentMarkdown text={text} />
        </div>
      ) : (
        <div className={styles.empty}>
          The agent proposed a plan but didn’t include its text — read the steps above.
        </div>
      )}
    </section>
  );
});
