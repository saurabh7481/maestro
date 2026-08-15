import { memo, useState } from "react";
import {
  CaretDown,
  CaretRight,
  FileMagnifyingGlass,
  MagnifyingGlass,
  PencilSimpleLine,
  SpinnerGap,
  Terminal,
  Wrench,
} from "@phosphor-icons/react";
import type { Icon } from "@phosphor-icons/react";
import type { TranscriptItem } from "../../state/agentSessionStore";
import { PermissionPrompt } from "./PermissionPrompt";
import styles from "./ToolCallCard.module.css";

type ToolCallItem = Extract<TranscriptItem, { kind: "toolCall" }>;

const TOOL_ICON: Record<string, { icon: Icon; color: string }> = {
  Read: { icon: FileMagnifyingGlass, color: "var(--accent-2)" },
  Grep: { icon: MagnifyingGlass, color: "var(--cyan)" },
  Glob: { icon: MagnifyingGlass, color: "var(--cyan)" },
  Edit: { icon: PencilSimpleLine, color: "var(--yellow)" },
  Write: { icon: PencilSimpleLine, color: "var(--yellow)" },
  Bash: { icon: Terminal, color: "var(--green)" },
};

function asRecord(input: unknown): Record<string, unknown> {
  return input && typeof input === "object" ? (input as Record<string, unknown>) : {};
}

function summaryFor(name: string, input: unknown): string {
  const rec = asRecord(input);
  const str = (key: string) => (typeof rec[key] === "string" ? (rec[key] as string) : undefined);
  switch (name) {
    case "Read":
    case "Write":
      return str("file_path") ?? str("path") ?? "";
    case "Edit":
      return str("file_path") ?? str("path") ?? "";
    case "Grep":
      return str("pattern") ? `"${str("pattern")}"` : "";
    case "Glob":
      return str("pattern") ?? "";
    case "Bash":
      return str("command") ?? "";
    default:
      return Object.keys(rec).length ? JSON.stringify(rec).slice(0, 120) : "";
  }
}

/** Adapters normalize edit/write results into diff-ish text server-side
 * (a synthesized `- old`/`+ new` block for Claude, a real unified
 * `diffString` for Cursor — see `agents/claude.rs`/`cursor_agent.rs`),
 * so the frontend never needs to know which CLI produced it: just color
 * whatever lines look like diff lines. */
function diffColoredLines(content: string): { sign: "-" | "+" | null; text: string }[] {
  return content.split("\n").map((line) => {
    if (line.startsWith("+")) return { sign: "+" as const, text: line };
    if (line.startsWith("-")) return { sign: "-" as const, text: line };
    return { sign: null, text: line };
  });
}

/** `memo`'d because the agent transcript re-renders as a turn streams:
 * without it, a tool result arriving reconciled every card in the
 * conversation, each of which re-splits and re-maps its output body
 * (docs/PERFORMANCE_AUDIT.md §1.3). Transcript items are replaced rather
 * than mutated in `agentSessionStore`, so a shallow prop comparison
 * correctly catches a card whose result just landed. */
export const ToolCallCard = memo(function ToolCallCard({
  runId,
  item,
}: {
  runId: string;
  item: ToolCallItem;
}) {
  const [expanded, setExpanded] = useState(false);
  const visual = TOOL_ICON[item.name] ?? { icon: Wrench, color: "var(--text-dim)" };
  const ToolIcon = visual.icon;
  const summary = summaryFor(item.name, item.input);
  const isEditLike = item.name === "Edit" || item.name === "Write";
  const pending = !item.result && !item.permission;
  const denied = item.permission?.status === "pending" || item.permission?.status === "denied";

  const hasBody = !!item.result?.content;
  const outputTooLong = (item.result?.content.length ?? 0) > 800;
  const bodyText = outputTooLong
    ? `${item.result!.content.slice(0, 800)}\n…`
    : (item.result?.content ?? "");

  return (
    <div className={styles.card}>
      <div
        className={styles.header}
        onClick={() => hasBody && setExpanded((v) => !v)}
        role={hasBody ? "button" : undefined}
      >
        {pending ? (
          <SpinnerGap size={15} color="var(--accent)" className="mo-spin" />
        ) : (
          <ToolIcon size={15} color={visual.color} />
        )}
        <span className={styles.name}>{item.name}</span>
        <span className={styles.summary}>{summary}</span>
        <span className={styles.meta}>
          {isEditLike &&
            item.result &&
            (item.result.diffAdded !== null || item.result.diffRemoved !== null) && (
              <>
                <span className={styles.added}>+{item.result.diffAdded ?? 0}</span>
                <span className={styles.removed}>−{item.result.diffRemoved ?? 0}</span>
              </>
            )}
          {denied && <span className={styles.needsPermission}>needs permission</span>}
          {hasBody && (expanded ? <CaretDown size={11} /> : <CaretRight size={11} />)}
        </span>
      </div>

      {expanded && hasBody && (
        <div className={styles.body}>
          {isEditLike ? (
            <div className={styles.diff}>
              {diffColoredLines(bodyText).map((line, i) => (
                <div key={i} className={styles.diffLine} data-sign={line.sign ?? undefined}>
                  {line.text}
                </div>
              ))}
            </div>
          ) : (
            <div className={styles.output} data-error={item.result!.isError}>
              {bodyText}
            </div>
          )}
        </div>
      )}

      {item.permission && (
        <PermissionPrompt
          runId={runId}
          toolCallId={item.toolCallId}
          toolName={item.name}
          permission={item.permission}
        />
      )}
    </div>
  );
});
