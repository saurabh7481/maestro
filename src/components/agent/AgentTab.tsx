import { useEffect, useRef, useState } from "react";
import {
  ArrowsClockwise,
  CaretDown,
  CaretRight,
  ClockCounterClockwise,
  GearSix,
  Sparkle,
  Stop,
  WarningCircle,
  Wrench,
} from "@phosphor-icons/react";
import { agentsApi } from "../../api/agents";
import { useAgentAvailabilityStore } from "../../state/agentAvailabilityStore";
import { useAgentSessionStore } from "../../state/agentSessionStore";
import type { TranscriptItem } from "../../state/agentSessionStore";
import type { Tab } from "../../state/tabsStore";
import { AGENT_DISPLAY_NAME, isReady } from "../../types/agent";
import type { AgentKind, PermissionMode, ResumableSession } from "../../types/agent";
import { relativeTime } from "../../design/relativeTime";
import { Switch } from "../primitives";
import { ToolCallCard } from "./ToolCallCard";
import { ThinkingBlock } from "./ThinkingBlock";
import { AgentComposer } from "./AgentComposer";
import { AgentMarkdown } from "./AgentMarkdown";
import styles from "./AgentTab.module.css";

type Group =
  | { role: "user"; text: string; key: string }
  | { role: "assistant"; items: TranscriptItem[]; key: string };

function groupItems(items: TranscriptItem[]): Group[] {
  const groups: Group[] = [];
  for (const item of items) {
    if (item.kind === "user") {
      groups.push({ role: "user", text: item.text, key: item.id });
      continue;
    }
    const last = groups[groups.length - 1];
    if (last?.role === "assistant") {
      last.items.push(item);
    } else {
      groups.push({ role: "assistant", items: [item], key: item.id });
    }
  }
  return groups;
}

/** An event the adapter didn't recognize, forwarded verbatim rather than
 * dropped (docs/CHECKLIST.md's "no silent failure") — expected mainly
 * from `codex.rs`, whose event shapes are best-effort/unverified until
 * it's live-tested against a real install. Collapsed by default so it
 * doesn't dominate the transcript. */
function RawEventCard({ json }: { json: unknown }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div className={styles.rawCard}>
      <div className={styles.rawHeader} onClick={() => setExpanded((v) => !v)}>
        <Wrench size={13} />
        Unrecognized event
        {expanded ? <CaretDown size={11} /> : <CaretRight size={11} />}
      </div>
      {expanded && <pre className={styles.rawBody}>{JSON.stringify(json, null, 2)}</pre>}
    </div>
  );
}

/** Seconds since `active` last became true, ticking once/sec, reset to 0
 * when it goes false. Used to grow the working-indicator from a bare dot
 * bounce into "Working… 12s" on longer waits — a run that just sits at
 * "..." for 30s with no other signal reads as stuck even though the dots
 * are technically animating the whole time. */
function useElapsedSeconds(active: boolean): number {
  const [elapsed, setElapsed] = useState(0);
  const startRef = useRef<number | null>(null);

  useEffect(() => {
    if (!active) {
      startRef.current = null;
      return;
    }
    startRef.current = Date.now();
    const id = window.setInterval(() => {
      const start = startRef.current;
      if (start != null) setElapsed(Math.floor((Date.now() - start) / 1000));
    }, 1000);
    return () => window.clearInterval(id);
  }, [active]);

  return active ? elapsed : 0;
}

function NotReadyCard({ title, detail }: { title: string; detail: string | null | undefined }) {
  return (
    <div className={styles.notReady}>
      <WarningCircle size={32} color="var(--yellow)" />
      <div className={styles.notReadyTitle}>{title}</div>
      {detail && <div className={styles.notReadyDetail}>{detail}</div>}
    </div>
  );
}

/** Lists this tab's agent kind's resumable sessions (Claude Code, Cursor
 * Agent — Codex has no on-disk session layout Maestro can read yet, see
 * `sessions.rs`) and, on pick, both switches the backend run to that
 * session (`resume_agent_session`) and hydrates the visible transcript
 * from its history (`get_session_transcript`) — resuming "for real" the
 * CLI's `--resume` flag already did on its own, not just cosmetically. */
function ResumeSessionPicker({
  runId,
  kind,
  worktreeId,
  worktreeRoot,
  onResumed,
}: {
  runId: string;
  kind: AgentKind;
  worktreeId: string;
  worktreeRoot: string;
  onResumed: () => void;
}) {
  const [sessions, setSessions] = useState<ResumableSession[] | null>(null);
  const [resumingId, setResumingId] = useState<string | null>(null);
  const resumeSession = useAgentSessionStore((s) => s.resumeSession);

  useEffect(() => {
    // `kind`/`worktreeRoot` are stable for a tab's lifetime in practice
    // (fixed props off `tab`), so this effect only ever really runs once
    // per mount — the `null` initial state already covers the loading
    // case, no need to reset it here too.
    let cancelled = false;
    void agentsApi.listResumableSessions(kind, worktreeRoot).then((list) => {
      if (!cancelled) setSessions(list);
    });
    return () => {
      cancelled = true;
    };
  }, [kind, worktreeRoot]);

  async function resume(session: ResumableSession) {
    setResumingId(session.sessionId);
    try {
      await agentsApi.resumeAgentSession(runId, worktreeId, worktreeRoot, kind, session.sessionId);
      const turns = await agentsApi.getSessionTranscript(kind, worktreeRoot, session.sessionId);
      resumeSession(runId, session.sessionId, turns);
      onResumed();
    } finally {
      setResumingId(null);
    }
  }

  return (
    <div className={styles.resumeSection}>
      <div className={styles.resumeLabel}>Resume a session</div>
      {sessions === null && (
        <div className={styles.resumeStatus}>
          <ArrowsClockwise size={12} className="mo-spin" />
          Loading sessions…
        </div>
      )}
      {sessions?.length === 0 &&
        (kind === "codex" ? (
          <div className={styles.resumeStatus}>
            Codex CLI doesn't expose a session list Maestro can read yet.
          </div>
        ) : (
          <div className={styles.resumeStatus}>No resumable sessions found in this worktree.</div>
        ))}
      {sessions?.map((session) => (
        <button
          key={session.sessionId}
          type="button"
          className={styles.resumeRow}
          disabled={resumingId !== null}
          onClick={() => void resume(session)}
        >
          <ClockCounterClockwise size={13} color="var(--text-dim)" />
          <div className={styles.resumeRowText}>
            <div className={styles.resumeRowTitle}>{session.title}</div>
            <div className={styles.resumeRowMeta}>
              {relativeTime(session.lastActiveAt)} · {session.turnCount} turns
            </div>
          </div>
          {resumingId === session.sessionId && <ArrowsClockwise size={12} className="mo-spin" />}
        </button>
      ))}
    </div>
  );
}

export function AgentTab({ tab }: { tab: Tab }) {
  const runId = tab.id;
  const kind = tab.agentKind ?? "claudeCode";
  const status = useAgentAvailabilityStore((s) => s.statusByKind[kind]);
  const loaded = useAgentAvailabilityStore((s) => s.loaded);

  const openRun = useAgentSessionStore((s) => s.openRun);
  const tabState = useAgentSessionStore((s) => s.byRunId[runId]);
  const appendUserMessage = useAgentSessionStore((s) => s.appendUserMessage);
  const markStarted = useAgentSessionStore((s) => s.markStarted);

  const [settingsOpen, setSettingsOpen] = useState(false);
  const [permissionMode, setPermissionModeState] = useState<PermissionMode>("manual");
  const transcriptRef = useRef<HTMLDivElement>(null);
  const working = tabState?.status === "working";
  const elapsedSeconds = useElapsedSeconds(working);

  useEffect(() => {
    openRun(runId);
  }, [runId, openRun]);

  useEffect(() => {
    transcriptRef.current?.scrollTo({
      top: transcriptRef.current.scrollHeight,
      behavior: "smooth",
    });
  }, [tabState?.items.length, tabState?.status]);

  async function handleSend(text: string, model: string | null) {
    appendUserMessage(runId, text);
    if (!tabState?.started) {
      markStarted(runId);
      await agentsApi.startAgentSession({
        runId,
        worktreeId: tab.worktreeId ?? "",
        worktreeRoot: tab.worktreeRoot ?? "",
        kind,
        resumeSessionId: tab.resumeSessionId ?? null,
        forkSession: tab.forkSession ?? false,
        firstMessage: text,
        model,
      });
    } else {
      await agentsApi.sendAgentMessage(runId, text);
    }
  }

  function changePermissionMode(next: PermissionMode) {
    setPermissionModeState(next);
    void agentsApi.setPermissionMode(runId, next);
  }

  if (!loaded || !status) {
    return (
      <div className={styles.tab}>
        <div className={styles.empty}>Checking {AGENT_DISPLAY_NAME[kind]}…</div>
      </div>
    );
  }
  if (!status.installed) {
    return (
      <div className={styles.tab}>
        <NotReadyCard
          title={`${AGENT_DISPLAY_NAME[kind]} isn't installed`}
          detail={
            status.authDetail ??
            `Install ${AGENT_DISPLAY_NAME[kind]} and set its binary path in Settings → Agents & CLI.`
          }
        />
      </div>
    );
  }
  if (!isReady(status)) {
    return (
      <div className={styles.tab}>
        <NotReadyCard
          title={`${AGENT_DISPLAY_NAME[kind]} needs authentication`}
          detail={status.authDetail}
        />
      </div>
    );
  }

  const items = tabState?.items ?? [];
  const groups = groupItems(items);
  const errored = tabState?.status === "error";

  return (
    <div className={styles.tab}>
      <div className={styles.header}>
        <div className={`${styles.avatar} mo-gradient-mark`}>
          <Sparkle size={14} color="#0a0c11" />
        </div>
        <div>
          <div className={styles.title}>{AGENT_DISPLAY_NAME[kind]}</div>
          <div className={styles.subtitle}>
            {tabState?.lastResult?.sessionId.slice(0, 8) ?? "new session"}
          </div>
        </div>
        <div className={styles.statusPill} data-status={errored ? "error" : undefined}>
          {!errored && <span className={styles.statusDot} data-active={working} />}
          {errored ? "error" : working ? "working" : "idle"}
        </div>
        <div className={styles.headerActions}>
          {working && (
            <div className={styles.stopButton} onClick={() => void agentsApi.interruptAgent(runId)}>
              <Stop size={13} />
              Stop
            </div>
          )}
          <div className={styles.stopButton} onClick={() => setSettingsOpen((v) => !v)}>
            <GearSix size={14} />
          </div>
        </div>
      </div>

      {settingsOpen && (
        <div className={styles.settingsPanel}>
          <Switch
            label="Dangerously skip permissions"
            checked={permissionMode === "auto"}
            onCheckedChange={(v) => changePermissionMode(v ? "auto" : "manual")}
          />
          <p className={styles.settingsNote}>
            Off by default. When on, every tool call runs without an approval card — only enable
            this in a sandbox you trust. The composer's mode picker below the message box offers
            the same switch, plus a read-only Plan mode.
          </p>
          {tab.worktreeId && tab.worktreeRoot && (
            <ResumeSessionPicker
              runId={runId}
              kind={kind}
              worktreeId={tab.worktreeId}
              worktreeRoot={tab.worktreeRoot}
              onResumed={() => setSettingsOpen(false)}
            />
          )}
        </div>
      )}

      {errored && tabState?.errorMessage && (
        <div className={styles.errorBanner}>{tabState.errorMessage}</div>
      )}

      <div className={styles.transcript} ref={transcriptRef}>
        {groups.length === 0 ? (
          <div className={styles.empty}>
            <Sparkle size={26} color="var(--accent)" />
            <span>Send a message to start working with {AGENT_DISPLAY_NAME[kind]}.</span>
          </div>
        ) : (
          <div className={styles.transcriptInner}>
            {groups.map((group) =>
              group.role === "user" ? (
                <div className={styles.row} key={group.key}>
                  <div className={styles.userAvatar}>YOU</div>
                  <div className={styles.userText}>{group.text}</div>
                </div>
              ) : (
                <div className={styles.row} key={group.key}>
                  <div className={`${styles.avatar} mo-gradient-mark`}>
                    <Sparkle size={13} color="#0a0c11" />
                  </div>
                  <div className={styles.assistantGroup}>
                    {group.items.map((item) => {
                      if (item.kind === "assistantText") {
                        return <AgentMarkdown key={item.id} text={item.text} />;
                      }
                      if (item.kind === "thinking") {
                        return <ThinkingBlock key={item.id} text={item.text} />;
                      }
                      if (item.kind === "toolCall") {
                        return <ToolCallCard key={item.id} runId={runId} item={item} />;
                      }
                      if (item.kind === "error") {
                        return (
                          <div className={styles.inlineError} key={item.id}>
                            {item.message}
                          </div>
                        );
                      }
                      if (item.kind === "raw") {
                        return <RawEventCard key={item.id} json={item.json} />;
                      }
                      return null;
                    })}
                  </div>
                </div>
              ),
            )}
            {working && (
              <div className={styles.row}>
                <div className={`${styles.avatar} mo-gradient-mark`}>
                  <Sparkle size={13} color="#0a0c11" />
                </div>
                <div className={styles.typing}>
                  <span className={styles.typingDot} style={{ animationDelay: "0s" }} />
                  <span className={styles.typingDot} style={{ animationDelay: "0.2s" }} />
                  <span className={styles.typingDot} style={{ animationDelay: "0.4s" }} />
                  <span className={styles.typingLabel}>
                    {items.length === 0
                      ? "Starting…"
                      : elapsedSeconds > 2
                        ? `Working… ${elapsedSeconds}s`
                        : "Working…"}
                  </span>
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      <AgentComposer
        runId={runId}
        kind={kind}
        worktreeRoot={tab.worktreeRoot ?? ""}
        disabled={working}
        locked={!!tabState?.started}
        permissionMode={permissionMode}
        onPermissionModeChange={changePermissionMode}
        onSend={handleSend}
      />
    </div>
  );
}
