import { useEffect, useRef, useState } from "react";
import { PaperPlaneRight } from "@phosphor-icons/react";
import { AgentTranscript } from "../components/AgentTranscript";
import { AddContextSheet } from "../components/agent/AddContextSheet";
import { ComposerToolbar } from "../components/agent/ComposerToolbar";
import { LoadingState } from "../components/EmptyState";
import { useAgentCapabilities, useAgentModels } from "../state/agentCatalog";
import { useAgentConfigStore, DEFAULT_AGENT_CONFIG } from "../state/agentConfigStore";
import { useAgentStore } from "../state/agentStore";
import { useAuthStore } from "../state/authStore";
import { useTabsStore } from "../state/tabsStore";

/** How often a visible agent screen re-pulls the run's actual
 * configuration from the relay, so a change made from the desktop (or
 * another device) while this screen is open shows up here too. */
const CONFIG_POLL_INTERVAL_MS = 4000;

export function AgentScreen({ runId }: { runId: string }) {
  const open = useAgentStore((s) => s.open);
  const close = useAgentStore((s) => s.close);
  const run = useAgentStore((s) => s.byRunId[runId]);
  const sendMessage = useAgentStore((s) => s.sendMessage);
  const canWrite = useAuthStore((s) => s.accessLevel === "write");
  const session = useTabsStore((s) => s.sessions.find((sess) => sess.id === runId));
  const agentKind = session?.agentKind ?? null;
  const worktreeId = session?.worktreeId ?? null;
  const capabilities = useAgentCapabilities(agentKind);
  const models = useAgentModels(agentKind);
  const config = useAgentConfigStore((s) => s.byRunId[runId]) ?? DEFAULT_AGENT_CONFIG;
  const setModel = useAgentConfigStore((s) => s.setModel);
  const setEffort = useAgentConfigStore((s) => s.setEffort);
  const setFast = useAgentConfigStore((s) => s.setFast);
  const setPermissionMode = useAgentConfigStore((s) => s.setPermissionMode);
  const hydrateConfig = useAgentConfigStore((s) => s.hydrate);

  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [showAddContext, setShowAddContext] = useState(false);
  const bodyRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    open(runId);
    return () => close(runId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runId]);

  useEffect(() => {
    if (!agentKind) return;
    void hydrateConfig(runId, models);
    const interval = setInterval(() => void hydrateConfig(runId, models), CONFIG_POLL_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [runId, agentKind, models, hydrateConfig]);

  useEffect(() => {
    const el = bodyRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [run?.items.length]);

  const working = run?.status === "working" || run?.status === "settling";
  const canSend = canWrite && !working && draft.trim().length > 0 && !sending;

  function insertMention(path: string) {
    const el = textareaRef.current;
    const pos = el?.selectionStart ?? draft.length;
    const end = el?.selectionEnd ?? pos;
    const token = `@${path} `;
    const next = `${draft.slice(0, pos)}${token}${draft.slice(end)}`;
    setDraft(next);
    const caret = pos + token.length;
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(caret, caret);
    });
  }

  async function submit() {
    if (!canSend) return;
    const text = draft.trim();
    setDraft("");
    setSending(true);
    try {
      await sendMessage(runId, text);
    } catch {
      setDraft(text);
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="screen">
      {!canWrite && (
        <div className="readonly-banner">
          Read-only — you can watch this session but not send messages
        </div>
      )}
      <div className="screen-body" ref={bodyRef}>
        {!run && <LoadingState />}
        {run && (
          <AgentTranscript
            items={run.items}
            runId={runId}
            working={!!working}
            turnStartedAtMs={run.turnStartedAtMs}
            totalCostUsd={run.lastResult?.totalCostUsd ?? null}
          />
        )}
        {run?.errorMessage && <div className="error-banner">{run.errorMessage}</div>}
      </div>
      {canWrite && (
        <div className="composer">
          {agentKind && (
            <ComposerToolbar
              kind={agentKind}
              config={config}
              onAddContext={() => setShowAddContext(true)}
              onSetModel={(modelOptions, modelId) =>
                setModel(
                  {
                    runId,
                    options: modelOptions,
                    separateOptionFlags: capabilities.separateOptionFlags,
                    live: true,
                  },
                  modelId,
                )
              }
              onSetEffort={(effort) =>
                setEffort(
                  {
                    runId,
                    options: models,
                    separateOptionFlags: capabilities.separateOptionFlags,
                    live: true,
                  },
                  effort,
                )
              }
              onSetFast={(fast) =>
                setFast(
                  {
                    runId,
                    options: models,
                    separateOptionFlags: capabilities.separateOptionFlags,
                    live: true,
                  },
                  fast,
                )
              }
              onSetPermissionMode={(mode) => setPermissionMode(runId, mode, true)}
            />
          )}
          <div className="composer-input-row">
            <textarea
              ref={textareaRef}
              className="composer-input"
              rows={1}
              placeholder={working ? "Agent is working…" : "Message…"}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  void submit();
                }
              }}
            />
            <button
              type="button"
              className="composer-send"
              disabled={!canSend}
              onClick={() => void submit()}
            >
              <PaperPlaneRight size={17} weight="fill" />
            </button>
          </div>
        </div>
      )}
      {showAddContext && worktreeId && (
        <AddContextSheet
          worktreeId={worktreeId}
          onSelect={(path) => {
            insertMention(path);
            setShowAddContext(false);
          }}
          onClose={() => setShowAddContext(false)}
        />
      )}
    </div>
  );
}
