import { useMemo } from "react";
import { Warning } from "@phosphor-icons/react";
import { renderMarkdown } from "../design/markdown";
import type { TranscriptItem } from "../state/transcript";
import {
  buildResponseBlocks,
  groupItems,
  turnCompletion,
  type Group,
} from "../state/transcriptGroups";
import { ProcessingCard } from "./agent/ProcessingCard";
import { TurnFooter } from "./agent/TurnFooter";

function AssistantBubble({ text, streaming }: { text: string; streaming?: boolean }) {
  const html = useMemo(() => renderMarkdown(text + (streaming ? " ▋" : "")), [text, streaming]);
  return (
    <div className="bubble" data-role="assistant" dangerouslySetInnerHTML={{ __html: html }} />
  );
}

function AssistantGroup({
  group,
  runId,
  active,
  turnStartedAtMs,
  totalCostUsd,
}: {
  group: Extract<Group, { role: "assistant" }>;
  runId: string;
  active: boolean;
  turnStartedAtMs: number | null;
  totalCostUsd: number | null;
}) {
  const blocks = buildResponseBlocks(group.items, active);
  const completion = turnCompletion(group.items);
  return (
    <div className="chat-item" data-role="assistant">
      <div className="assistant-group">
        {blocks.map((block) => {
          if (block.kind === "text") {
            return (
              <AssistantBubble
                key={block.item.id}
                text={block.item.text}
                streaming={block.item.streaming}
              />
            );
          }
          if (block.kind === "error") {
            return (
              <div className="card" style={{ borderColor: "var(--red)" }} key={block.item.id}>
                <div className="card-header" data-error="true">
                  <Warning size={14} />
                  {block.item.message}
                </div>
              </div>
            );
          }
          return (
            <ProcessingCard
              key={block.key}
              runId={runId}
              items={block.items}
              active={block.active}
              turnStartedAtMs={turnStartedAtMs}
            />
          );
        })}
        {completion && <TurnFooter completion={completion} totalCostUsd={totalCostUsd} />}
      </div>
    </div>
  );
}

export function AgentTranscript({
  items,
  runId,
  working,
  turnStartedAtMs,
  totalCostUsd,
}: {
  items: TranscriptItem[];
  runId: string;
  working: boolean;
  turnStartedAtMs: number | null;
  totalCostUsd: number | null;
}) {
  const groups = useMemo(() => groupItems(items), [items]);
  const lastIndex = groups.length - 1;

  return (
    <div className="chat-body">
      {groups.map((group, index) =>
        group.role === "user" ? (
          <div className="chat-item" data-role="user" key={group.key}>
            <div className="bubble" data-role="user">
              {group.text}
            </div>
          </div>
        ) : (
          <AssistantGroup
            key={group.key}
            group={group}
            runId={runId}
            active={working && index === lastIndex}
            turnStartedAtMs={turnStartedAtMs}
            totalCostUsd={totalCostUsd}
          />
        ),
      )}
      {working && groups[lastIndex]?.role === "user" && (
        <div className="chat-item" data-role="assistant">
          <div className="assistant-group">
            <ProcessingCard runId={runId} items={[]} active turnStartedAtMs={turnStartedAtMs} />
          </div>
        </div>
      )}
    </div>
  );
}
