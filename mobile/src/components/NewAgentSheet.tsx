import { useRef, useState } from "react";
import { relayClient } from "../api/client";
import {
  AGENT_DISPLAY_NAME,
  AGENT_KINDS,
  type AgentEffort,
  type AgentKind,
  type PermissionMode,
} from "../api/types";
import { DEFAULT_AGENT_CONFIG, resolveForSend, type AgentConfig } from "../state/agentConfigStore";
import { useAgentCapabilities, useAgentModels } from "../state/agentCatalog";
import { AddContextSheet } from "./agent/AddContextSheet";
import { ComposerToolbar } from "./agent/ComposerToolbar";

export function NewAgentSheet({
  worktreeId,
  onClose,
  onCreated,
}: {
  worktreeId: string;
  onClose: () => void;
  onCreated: (runId: string) => void;
}) {
  const [kind, setKind] = useState<AgentKind>("claudeCode");
  const [message, setMessage] = useState("");
  const [config, setConfig] = useState<AgentConfig>(DEFAULT_AGENT_CONFIG);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showAddContext, setShowAddContext] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const models = useAgentModels(kind);
  const capabilities = useAgentCapabilities(kind);

  function selectKind(next: AgentKind) {
    setKind(next);
    setConfig(DEFAULT_AGENT_CONFIG);
  }

  function insertMention(path: string) {
    const el = textareaRef.current;
    const pos = el?.selectionStart ?? message.length;
    const end = el?.selectionEnd ?? pos;
    const token = `@${path} `;
    const next = `${message.slice(0, pos)}${token}${message.slice(end)}`;
    setMessage(next);
    const caret = pos + token.length;
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(caret, caret);
    });
  }

  async function submit() {
    if (!message.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      const selectedModel = models.find((m) => m.id === config.model);
      const resolved = resolveForSend(
        selectedModel,
        config.effort,
        config.fast,
        capabilities.separateOptionFlags,
      );
      const { runId } = await relayClient.createAgentSession(worktreeId, {
        kind,
        firstMessage: message.trim(),
        model: resolved.model ?? undefined,
        effort: resolved.effort ?? undefined,
        fast: resolved.fast,
        permissionMode: config.permissionMode,
      });
      onCreated(runId);
    } catch (e) {
      setError(String(e));
      setBusy(false);
    }
  }

  return (
    <div className="sheet-overlay" onClick={onClose}>
      <div className="sheet" onClick={(e) => e.stopPropagation()}>
        <div className="sheet-handle" />
        <div className="sheet-title">New agent</div>

        <span className="field-label">Agent</span>
        <div className="kind-grid">
          {AGENT_KINDS.map((k) => (
            <button
              key={k}
              type="button"
              className="kind-option"
              data-selected={k === kind}
              onClick={() => selectKind(k)}
            >
              {AGENT_DISPLAY_NAME[k]}
            </button>
          ))}
        </div>

        <span className="field-label">First message</span>
        <textarea
          ref={textareaRef}
          className="text-input"
          rows={4}
          placeholder="What should it do?"
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          autoFocus
        />

        <ComposerToolbar
          kind={kind}
          config={config}
          onAddContext={() => setShowAddContext(true)}
          onSetModel={(modelOptions, modelId) => {
            const option = modelOptions.find((m) => m.id === modelId);
            const effort = option?.supportedEfforts.includes(config.effort)
              ? config.effort
              : (option?.supportedEfforts[0] ?? config.effort);
            setConfig({ ...config, model: modelId, effort, fast: false });
          }}
          onSetEffort={(effort: AgentEffort) => setConfig({ ...config, effort })}
          onSetFast={(fast: boolean) => setConfig({ ...config, fast })}
          onSetPermissionMode={(mode: PermissionMode) =>
            setConfig({ ...config, permissionMode: mode })
          }
        />

        {error && <p className="error-banner">{error}</p>}

        <button
          type="button"
          className="btn btn-primary btn-block"
          disabled={!message.trim() || busy}
          onClick={() => void submit()}
        >
          {busy ? "Starting…" : "Start agent"}
        </button>
      </div>

      {showAddContext && (
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
