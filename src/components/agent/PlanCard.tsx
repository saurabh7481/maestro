import { memo } from "react";
import { CheckCircle, Compass } from "@phosphor-icons/react";
import { AgentMarkdown } from "./AgentMarkdown";
import { readPlanArtifact } from "./planArtifact";
import type { ToolCallItem } from "./processingBlocks";
import styles from "./PlanCard.module.css";

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
  const artifact = readPlanArtifact(item.input);
  return (
    <section className={styles.card}>
      <header className={styles.header}>
        <span className={styles.icon}>
          <Compass size={14} />
        </span>
        <span className={styles.heading}>
          <span className={styles.title}>{artifact.title ?? "Implementation plan"}</span>
          <span className={styles.status}>Ready to review</span>
        </span>
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
      {artifact.text ? (
        <div className={styles.body}>
          {artifact.overview && !artifact.text.includes(artifact.overview) && (
            <p className={styles.overview}>{artifact.overview}</p>
          )}
          <AgentMarkdown text={artifact.text} />
        </div>
      ) : (
        <div className={styles.empty}>
          The agent proposed a plan but didn’t include its text — read the steps above.
        </div>
      )}
    </section>
  );
});
