import { useState } from "react";
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
import type { TranscriptItem } from "../../state/transcript";
import { PermissionCard } from "../PermissionCard";

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

function diffColoredLines(content: string): { sign: "-" | "+" | null; text: string }[] {
  return content.split("\n").map((line) => {
    if (line.startsWith("+")) return { sign: "+" as const, text: line };
    if (line.startsWith("-")) return { sign: "-" as const, text: line };
    return { sign: null, text: line };
  });
}

/** Ported from the desktop's `ToolCallCard.tsx` — same tool-icon-by-name,
 * inline summary, diff-colored body, and pending-permission gating. */
export function MobileToolCallCard({
  runId,
  item,
  nested = false,
  running = true,
}: {
  runId: string;
  item: ToolCallItem;
  nested?: boolean;
  running?: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const visual = TOOL_ICON[item.name] ?? { icon: Wrench, color: "var(--text-dim)" };
  const ToolIcon = visual.icon;
  const summary = summaryFor(item.name, item.input);
  const isEditLike = item.name === "Edit" || item.name === "Write";
  const unfinished = !item.result && !item.permission;
  const pending = unfinished && running;
  const permission = item.permission?.status;
  const denied = permission === "pending" || permission === "denied" || permission === "blocked";
  const badge =
    permission === "pending" ? "needs permission" : permission === "blocked" ? "blocked" : null;

  const hasBody = !!item.result?.content;
  const outputTooLong = (item.result?.content.length ?? 0) > 800;
  const bodyText = outputTooLong
    ? `${item.result!.content.slice(0, 800)}\n…`
    : (item.result?.content ?? "");

  return (
    <div className="tool-card" data-nested={nested || undefined}>
      <div
        className="tool-card-header"
        onClick={() => hasBody && setExpanded((v) => !v)}
        role={hasBody ? "button" : undefined}
        tabIndex={hasBody ? 0 : undefined}
      >
        {pending ? (
          <SpinnerGap size={15} color="var(--accent)" className="spin" />
        ) : (
          <ToolIcon size={15} color={visual.color} />
        )}
        <span className="tool-card-name">{item.name}</span>
        <span className="tool-card-summary">{summary}</span>
        <span className="tool-card-meta">
          {isEditLike &&
            item.result &&
            (item.result.diffAdded !== null || item.result.diffRemoved !== null) && (
              <>
                <span style={{ color: "var(--green)" }}>+{item.result.diffAdded ?? 0}</span>
                <span style={{ color: "var(--red)" }}>−{item.result.diffRemoved ?? 0}</span>
              </>
            )}
          {badge && <span style={{ color: "var(--red)" }}>{badge}</span>}
          {unfinished && !running && !denied && (
            <span style={{ fontStyle: "italic" }}>didn't finish</span>
          )}
          {hasBody && (expanded ? <CaretDown size={11} /> : <CaretRight size={11} />)}
        </span>
      </div>

      {expanded && hasBody && (
        <div className="tool-card-body">
          {isEditLike ? (
            <div className="tool-card-diff">
              {diffColoredLines(bodyText).map((line, i) => (
                <div key={i} className="tool-card-diff-line" data-sign={line.sign ?? undefined}>
                  {line.text}
                </div>
              ))}
            </div>
          ) : (
            <div className="tool-card-output" data-error={item.result!.isError}>
              {bodyText}
            </div>
          )}
        </div>
      )}

      {item.permission && (
        <div style={{ padding: "0 var(--space-6) var(--space-5)" }}>
          <PermissionCard
            runId={runId}
            toolCallId={item.toolCallId}
            toolName={item.name}
            permission={item.permission}
          />
        </div>
      )}
    </div>
  );
}
