import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ClipboardEvent, DragEvent, KeyboardEvent, ReactNode } from "react";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import {
  ArrowUp,
  At,
  CaretDown,
  Check,
  Compass,
  FolderOpen,
  Lightning,
  Paperclip,
  ShieldCheck,
  Sparkle,
  X,
} from "@phosphor-icons/react";
import type { Icon } from "@phosphor-icons/react";
import { readImage } from "@tauri-apps/plugin-clipboard-manager";
import { EMPTY_QUEUE, useAgentSessionStore } from "../../state/agentSessionStore";
import { useAgentCapabilities } from "../../state/agentAvailabilityStore";
import { agentsApi } from "../../api/agents";
import { fsApi } from "../../api/fs";
import { searchApi } from "../../api/search";
import { fuzzyScore } from "../../design/fuzzy";
import { useScrollActiveIntoView } from "../../design/useScrollActiveIntoView";
import { loadAgentModelPrefs, saveAgentModelPref } from "../../design/persistence";
import { AGENT_DISPLAY_NAME } from "../../types/agent";
import type {
  AgentCapabilities,
  AgentEffort,
  AgentKind,
  ModelOption,
  PermissionMode,
  SlashCommandOption,
} from "../../types/agent";
import styles from "./AgentComposer.module.css";
import { resizeComposerTextarea } from "./composerSizing";

const PERMISSION_MODE_META: Record<
  PermissionMode,
  { label: string; icon: Icon; description: string }
> = {
  manual: {
    label: "Manual",
    icon: ShieldCheck,
    description: "Ask before file edits and shell commands.",
  },
  auto: {
    label: "Auto",
    icon: Lightning,
    description: "Run every tool call without asking — only in a sandbox you trust.",
  },
  plan: {
    label: "Plan",
    icon: Compass,
    description: "Read-only: analyze and propose, no edits or commands.",
  },
};

const PERMISSION_MODE_ORDER: PermissionMode[] = ["manual", "auto", "plan"];

/** Fetched from the CLI itself, not a static guess (docs/V1_SCOPE.md §6
 * "no fake dropdowns") — see `commands/agents.rs::list_agent_models`.
 * Empty for a CLI with no confirmed model-selection flag (Codex), in
 * which case the picker just doesn't render. */
function useAgentModels(kind: AgentKind): ModelOption[] {
  const [models, setModels] = useState<ModelOption[]>([]);
  useEffect(() => {
    // `kind` is fixed for an agent tab's lifetime (set once at tab
    // creation), so this effect only ever runs once per mount in
    // practice — no need to reset `models` to `[]` first.
    let cancelled = false;
    void agentsApi.listAgentModels(kind).then((options) => {
      if (!cancelled) setModels(options);
    });
    return () => {
      cancelled = true;
    };
  }, [kind]);
  return models;
}

/** Same "real, discoverable items only" stance as `useAgentModels` — see
 * `agents/slash_commands.rs`'s module doc. Empty for Cursor Agent/Codex,
 * which have no confirmed non-interactive way to enumerate either
 * skills or custom commands. */
function useSlashCommands(kind: AgentKind, worktreeRoot: string): SlashCommandOption[] {
  const [commands, setCommands] = useState<SlashCommandOption[]>([]);
  useEffect(() => {
    if (!worktreeRoot) return;
    let cancelled = false;
    void agentsApi.listSlashCommands(kind, worktreeRoot).then((list) => {
      if (!cancelled) setCommands(list);
    });
    return () => {
      cancelled = true;
    };
  }, [kind, worktreeRoot]);
  return commands;
}

const MENU_MAX_RESULTS = 8;

/** A complete `@path` token — `@` plus path-ish characters, only where
 * followed by whitespace or the end of the string. That trailing boundary
 * is what separates a *finished* mention (pill-worthy) from the one the
 * user is still typing/autocompleting, without needing a second parallel
 * "is this a real file" check — every mention this composer ever inserts
 * (typed, dropped, attached, pasted) already goes in as `@path ` with a
 * trailing space, so this matches all of them the same way. */
const MENTION_TOKEN_RE = /@[\w./-]+(?=\s|$)/g;

const IMAGE_EXT_RE = /\.(png|jpe?g|gif|webp|bmp|svg|avif)$/i;

/** Renders `text` as plain strings interleaved with pill `<span>`s around
 * each complete `@mention` token — the highlight layer under the (text-
 * transparent) textarea in `TextareaStack`. `exclude` is the current
 * in-progress mention match (if the `@`-menu is open), rendered as plain
 * text instead of a pill since it isn't a finished token yet. */
function renderHighlightedDraft(
  text: string,
  exclude: { start: number; end: number } | null,
): ReactNode[] {
  const nodes: ReactNode[] = [];
  let cursor = 0;
  let key = 0;
  MENTION_TOKEN_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = MENTION_TOKEN_RE.exec(text))) {
    const start = match.index;
    const end = start + match[0].length;
    if (exclude && start < exclude.end && end > exclude.start) continue;
    if (start > cursor) nodes.push(text.slice(cursor, start));
    const path = match[0].slice(1);
    nodes.push(
      <span
        key={key++}
        className={styles.pill}
        data-kind={IMAGE_EXT_RE.test(path) ? "image" : "file"}
      >
        {match[0]}
      </span>,
    );
    cursor = end;
  }
  if (cursor < text.length) nodes.push(text.slice(cursor));
  return nodes;
}

/** The full worktree file list (same `git ls-files`-backed source
 * quick-open uses — `CommandPalette.tsx`'s `useWorktreeFiles`), fetched
 * once the composer mounts. Previously @-mention flattened whatever
 * directories the file-tree sidebar happened to have lazily expanded so
 * far (`explorerStore.childrenByDir`) — files the user hadn't clicked
 * into in the tree simply weren't there to match against, which is why
 * it only ever surfaced a handful of files. */
function useWorktreeFileList(worktreeRoot: string): string[] {
  const [files, setFiles] = useState<string[]>([]);
  useEffect(() => {
    if (!worktreeRoot) return;
    let cancelled = false;
    void searchApi
      .listFiles(worktreeRoot)
      .then((list) => {
        if (!cancelled) setFiles(list);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [worktreeRoot]);
  return files;
}

function useMentionCandidates(allFiles: string[], query: string | null): string[] {
  return useMemo(() => {
    if (query === null) return [];
    return allFiles
      .map((path) => ({ path, score: fuzzyScore(query, path) }))
      .filter((r): r is { path: string; score: number } => r.score !== null)
      .sort((a, b) => b.score - a.score)
      .slice(0, MENU_MAX_RESULTS)
      .map((r) => r.path);
  }, [allFiles, query]);
}

function useSlashCandidates(
  options: SlashCommandOption[],
  query: string | null,
): SlashCommandOption[] {
  return useMemo(() => {
    if (query === null) return [];
    return options
      .map((option) => ({ option, score: fuzzyScore(query, option.slug) }))
      .filter((r): r is { option: SlashCommandOption; score: number } => r.score !== null)
      .sort((a, b) => b.score - a.score)
      .slice(0, MENU_MAX_RESULTS)
      .map((r) => r.option);
  }, [options, query]);
}

/** A dropdown with its own search box at the top — the shared shape
 * behind both the model picker and the "Add context" file attach
 * button. Radix's default behavior (auto-focus the first menu item on
 * open) would steal keyboard focus from the search input, so open-auto-
 * focus is suppressed and the input is focused by hand instead. */
function SearchableMenu<T>({
  trigger,
  items,
  query,
  onQueryChange,
  getKey,
  renderItem,
  onSelect,
  open,
  onOpenChange,
  placeholder,
  emptyLabel,
  align = "start",
  leadingAction,
}: {
  trigger: ReactNode;
  items: T[];
  query: string;
  onQueryChange: (q: string) => void;
  getKey: (item: T) => string;
  renderItem: (item: T) => ReactNode;
  onSelect: (item: T) => void;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  placeholder: string;
  emptyLabel: string;
  align?: "start" | "end";
  /** A pinned item above the results, outside `items` so the search box
   * can't filter it away — the way out of the list is worth keeping
   * reachable precisely when the list has nothing in it. */
  leadingAction?: { label: ReactNode; onSelect: () => void };
}) {
  const inputRef = useRef<HTMLInputElement>(null);

  // Radix focuses the first menu item on open by default — steal focus
  // back to the search input right after (there's no public prop on
  // `DropdownMenu.Content` to suppress that first focus outright, unlike
  // `Dialog`/`Popover`'s `onOpenAutoFocus`).
  useEffect(() => {
    if (open) requestAnimationFrame(() => inputRef.current?.focus());
  }, [open]);

  return (
    <DropdownMenu.Root open={open} onOpenChange={onOpenChange}>
      <DropdownMenu.Trigger asChild>{trigger}</DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          className={`${styles.searchMenu} mo-glass`}
          side="top"
          align={align}
          sideOffset={8}
        >
          <input
            ref={inputRef}
            className={styles.searchInput}
            placeholder={placeholder}
            value={query}
            onChange={(e) => onQueryChange(e.target.value)}
            onKeyDown={(e) => {
              // Let Radix's own roving-focus keys (arrows/Enter/Escape)
              // reach the menu items — only stop propagation for keys
              // that would otherwise be swallowed as text input.
              if (e.key !== "ArrowDown" && e.key !== "ArrowUp" && e.key !== "Escape") {
                e.stopPropagation();
              }
            }}
          />
          {leadingAction && (
            <>
              <DropdownMenu.Item
                className={`${styles.mentionItem} ${styles.menuAction}`}
                onSelect={leadingAction.onSelect}
              >
                {leadingAction.label}
              </DropdownMenu.Item>
              <div className={styles.menuSeparator} />
            </>
          )}
          {items.length === 0 ? (
            <div className={styles.searchEmpty}>{emptyLabel}</div>
          ) : (
            items.map((item) => (
              <DropdownMenu.Item
                key={getKey(item)}
                className={styles.mentionItem}
                onSelect={() => onSelect(item)}
              >
                {renderItem(item)}
              </DropdownMenu.Item>
            ))
          )}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

function ModelPicker({
  modelOptions,
  model,
  setModel,
}: {
  modelOptions: ModelOption[];
  model: string | null;
  setModel: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const selectedLabel = modelOptions.find((m) => m.id === model)?.label ?? "Default";

  const filtered = query
    ? modelOptions
        .map((o) => ({ o, score: fuzzyScore(query, o.label) }))
        .filter((r): r is { o: ModelOption; score: number } => r.score !== null)
        .sort((a, b) => b.score - a.score)
        .map((r) => r.o)
    : modelOptions;

  return (
    <SearchableMenu
      trigger={
        <div className={styles.picker}>
          <Sparkle size={13} color="var(--accent)" />
          {selectedLabel}
          <CaretDown size={10} color="var(--text-mute)" />
        </div>
      }
      items={filtered}
      query={query}
      onQueryChange={setQuery}
      getKey={(o) => o.id}
      renderItem={(o) => o.label}
      onSelect={(o) => {
        setModel(o.id);
        setOpen(false);
        setQuery("");
      }}
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setQuery("");
      }}
      placeholder="Search models… (e.g. grok 4.6 high fast)"
      emptyLabel="No matching models"
    />
  );
}

const EFFORT_LABEL: Record<AgentEffort, string> = {
  none: "None",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra high",
  max: "Max",
  ultra: "Ultra",
};

function EffortPicker({
  values,
  value,
  onChange,
  label,
}: {
  values: AgentEffort[];
  value: AgentEffort;
  onChange: (value: AgentEffort) => void;
  /** The provider's own name for this dial (`capabilities.effortLabel`). */
  label: string;
}) {
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <div className={styles.picker}>
          <Lightning size={13} color="var(--accent)" />
          {label}: {EFFORT_LABEL[value]}
          <CaretDown size={10} color="var(--text-mute)" />
        </div>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content className={`${styles.modeMenu} mo-glass`} side="top" sideOffset={8}>
          {values.map((effort) => (
            <DropdownMenu.Item
              key={effort}
              className={styles.modeItem}
              data-active={effort === value}
              onSelect={() => onChange(effort)}
            >
              <span className={styles.modeItemLabel}>{EFFORT_LABEL[effort]}</span>
              {effort === value && <Check size={13} color="var(--accent)" />}
            </DropdownMenu.Item>
          ))}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

function OptionToggle({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <button
      type="button"
      className={styles.picker}
      data-active={checked}
      aria-pressed={checked}
      onClick={() => onChange(!checked)}
    >
      <Lightning size={13} color="var(--accent)" />
      {label}
    </button>
  );
}

function PermissionModePicker({
  mode,
  onChange,
  capabilities,
}: {
  mode: PermissionMode;
  onChange: (mode: PermissionMode) => void;
  capabilities: AgentCapabilities;
}) {
  const meta = PERMISSION_MODE_META[mode];
  const ModeIcon = meta.icon;
  // Per-mode small print, straight from the provider's own declaration —
  // a new CLI describes itself in `capabilities.rs` and this picker stops
  // overstating what its modes do, with no edit here.
  const caveats: Partial<Record<PermissionMode, string>> = {
    manual:
      capabilities.manualGate === "prompt"
        ? undefined
        : (capabilities.manualGateDetail ?? undefined),
    plan: capabilities.planMode
      ? undefined
      : "This CLI has no confirmed read-only mode, so Plan behaves like Manual.",
  };
  // `externalConfig` means the CLI has no per-invocation approval hook at
  // all (confirmed live for Cursor Agent and Aider — see
  // `manualGateDetail`) — Maestro runs these fully headless, with no
  // stdin to answer an approval through, so "Manual" can't actually ask
  // anything and just runs identically to Auto while implying otherwise.
  // Offering it as a real, distinct option misleads more than omitting it.
  const visibleModes = PERMISSION_MODE_ORDER.filter(
    (id) => id !== "manual" || capabilities.manualGate !== "externalConfig",
  );
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <div className={styles.picker}>
          <ModeIcon size={13} color="var(--accent)" />
          {meta.label}
          <CaretDown size={10} color="var(--text-mute)" />
        </div>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          className={`${styles.modeMenu} mo-glass`}
          side="top"
          align="start"
          sideOffset={8}
        >
          {visibleModes.map((id) => {
            const optionMeta = PERMISSION_MODE_META[id];
            const OptionIcon = optionMeta.icon;
            return (
              <DropdownMenu.Item
                key={id}
                className={styles.modeItem}
                data-active={id === mode}
                onSelect={() => onChange(id)}
              >
                <OptionIcon size={14} color="var(--text-dim)" />
                <div className={styles.modeItemText}>
                  <div className={styles.modeItemLabel}>{optionMeta.label}</div>
                  <div className={styles.modeItemDescription}>{optionMeta.description}</div>
                  {caveats[id] && <div className={styles.modeItemCaveat}>{caveats[id]}</div>}
                </div>
                {id === mode && <Check size={13} color="var(--accent)" />}
              </DropdownMenu.Item>
            );
          })}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

function AttachFileButton({
  worktreeFiles,
  onAttach,
  onBrowse,
}: {
  worktreeFiles: string[];
  onAttach: (path: string) => void;
  /** Opens the OS file picker, for context that isn't in the worktree at
   * all — a spec PDF, an exported CSV, a screenshot. */
  onBrowse: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const filtered = useMemo(() => {
    const scored = worktreeFiles
      .map((path) => ({ path, score: fuzzyScore(query, path) }))
      .filter((r): r is { path: string; score: number } => r.score !== null)
      .sort((a, b) => b.score - a.score);
    return (query ? scored : scored.slice(0, 50)).slice(0, 50).map((r) => r.path);
  }, [worktreeFiles, query]);

  return (
    <SearchableMenu
      trigger={
        <div className={styles.addContext}>
          <Paperclip size={13} />
          Add context
        </div>
      }
      items={filtered}
      query={query}
      onQueryChange={setQuery}
      getKey={(p) => p}
      renderItem={(p) => p}
      onSelect={(p) => {
        onAttach(p);
        setOpen(false);
        setQuery("");
      }}
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setQuery("");
      }}
      placeholder="Search files to attach…"
      emptyLabel="No matching files in this worktree"
      leadingAction={{
        label: (
          <>
            <FolderOpen size={13} color="var(--text-dim)" />
            Browse files…
          </>
        ),
        onSelect: () => {
          setOpen(false);
          setQuery("");
          onBrowse();
        },
      }}
    />
  );
}

export function AgentComposer({
  runId,
  kind,
  worktreeRoot,
  disabled,
  locked,
  permissionMode,
  onPermissionModeChange,
  onSend,
  onReplace,
}: {
  runId: string;
  kind: AgentKind;
  worktreeRoot: string;
  /** Working — can't send right now. */
  disabled: boolean;
  /** Session already started — configuration changes update the next turn. */
  locked: boolean;
  permissionMode: PermissionMode;
  onPermissionModeChange: (mode: PermissionMode) => void;
  onSend: (text: string, model: string | null, effort: string | null, fast: boolean) => void;
  /** Re-runs the conversation from an earlier message, replacing it. */
  onReplace: (
    itemId: string,
    text: string,
    model: string | null,
    effort: string | null,
    fast: boolean,
  ) => void;
}) {
  const draft = useAgentSessionStore((s) => s.draftByRunId[runId] ?? "");
  const setDraft = useAgentSessionStore((s) => s.setDraft);
  const queueMessage = useAgentSessionStore((s) => s.queueMessage);
  const unqueueMessage = useAgentSessionStore((s) => s.unqueueMessage);
  const queued = useAgentSessionStore((s) => s.byRunId[runId]?.queued ?? EMPTY_QUEUE);
  const editingId = useAgentSessionStore((s) => s.editingByRunId[runId] ?? null);
  const cancelEditing = useAgentSessionStore((s) => s.cancelEditing);
  const modelOptions = useAgentModels(kind);
  const slashOptions = useSlashCommands(kind, worktreeRoot);
  // Read here rather than passed down: the composer is the only consumer,
  // and going through the store keeps `AgentTab` from having to thread a
  // prop that every future provider-aware control would also need.
  const capabilities = useAgentCapabilities(kind);
  const [model, setModel] = useState<string | null>(null);
  const [effort, setEffort] = useState<AgentEffort>("high");
  const [thinking, setThinking] = useState(false);
  const [fast, setFast] = useState(false);
  const [attaching, setAttaching] = useState(false);
  const [attachError, setAttachError] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  // Cursor position is tracked via state (updated from event handlers),
  // not read from `textareaRef.current` during render — reading a ref's
  // value at render time is unsafe (react-hooks/refs).
  const [cursorPos, setCursorPos] = useState(0);

  useLayoutEffect(() => {
    const element = textareaRef.current;
    if (element) resizeComposerTextarea(element);
    // The highlight overlay sits behind the (text-transparent) textarea and
    // needs to stay pixel-aligned with it, including scroll position — a
    // resize can change how much of a long draft is scrolled out of view.
    if (overlayRef.current && element) overlayRef.current.scrollTop = element.scrollTop;
  }, [draft]);

  // A run only ever needs to pick up the last-used model once, right after
  // mount — and only once real options are known, so a stale/removed model
  // id from a previous session can't be applied blind (`resolvedModel`
  // below would send it straight to the CLI with no validation otherwise).
  // Guarded by a ref rather than `model !== null` because `null` is also
  // the legitimate "explicitly use the provider's own default" state once
  // a user has picked it — nothing here should stomp back over that.
  const appliedModelPrefRef = useRef(false);
  useEffect(() => {
    if (appliedModelPrefRef.current || modelOptions.length === 0) return;
    appliedModelPrefRef.current = true;
    void loadAgentModelPrefs().then((prefs) => {
      const preferred = prefs[kind];
      if (preferred && modelOptions.some((option) => option.id === preferred)) {
        setModel(preferred);
      }
    });
  }, [kind, modelOptions]);

  const worktreeFiles = useWorktreeFileList(worktreeRoot);
  const selectedModel = modelOptions.find((option) => option.id === model) ?? null;
  const effortValues = selectedModel?.supportedEfforts ?? [];
  const resolvedVariant = selectedModel?.variants.find(
    (variant) =>
      variant.effort === (effortValues.length > 0 ? effort : null) &&
      variant.thinking === thinking &&
      variant.fast === fast,
  );
  const resolvedModel = selectedModel?.variants.length
    ? (resolvedVariant?.id ?? selectedModel.variants[0]?.id ?? null)
    : model;
  // A CLI that encodes these in the model id has already had them applied
  // by `resolvedModel` above; sending them again as flags would duplicate
  // (or invalidate) the arguments. Declared per provider rather than
  // special-cased by name here — see `capabilities.rs`.
  const sendsOptionFlags = capabilities.separateOptionFlags;
  const cliEffort = !sendsOptionFlags || effortValues.length === 0 ? null : effort;
  const cliFast = sendsOptionFlags ? fast : false;

  function updateConfiguration(next: {
    model?: string | null;
    effort?: AgentEffort;
    thinking?: boolean;
    fast?: boolean;
  }) {
    const nextModel = next.model === undefined ? model : next.model;
    const nextEffort = next.effort ?? effort;
    const nextThinking = next.thinking ?? thinking;
    const nextFast = next.fast ?? fast;
    setModel(nextModel);
    setEffort(nextEffort);
    setThinking(nextThinking);
    setFast(nextFast);
    // Only an actual model switch (not an effort/thinking/fast-only call)
    // updates the remembered preference — and only per `kind`, so picking
    // a model in a Claude Code tab never overwrites what's remembered for
    // Cursor/Codex/Aider.
    if (next.model !== undefined && next.model !== null && next.model !== model) {
      void saveAgentModelPref(kind, next.model);
    }
    if (locked) {
      const option = modelOptions.find((candidate) => candidate.id === nextModel) ?? null;
      const variant = option?.variants.find(
        (candidate) =>
          candidate.effort === (option.supportedEfforts.length ? nextEffort : null) &&
          candidate.thinking === nextThinking &&
          candidate.fast === nextFast,
      );
      const nextResolved = option?.variants.length
        ? (variant?.id ?? option.variants[0]?.id ?? null)
        : nextModel;
      void agentsApi.setAgentConfiguration(
        runId,
        nextResolved,
        !sendsOptionFlags || !option?.supportedEfforts.length ? null : nextEffort,
        sendsOptionFlags ? nextFast : false,
      );
    }
  }

  // A "/word" only means anything as the very first token of the whole
  // message (matching how every one of these CLIs' own interactive
  // slash commands work) — checked first so "/foo@bar" doesn't also
  // register as an @-mention of "@bar".
  const slashMatch = /^\/(\S*)$/.exec(draft.slice(0, cursorPos));
  const mentionMatch = slashMatch ? null : /@([\w./-]*)$/.exec(draft.slice(0, cursorPos));

  const slashCandidates = useSlashCandidates(slashOptions, slashMatch ? slashMatch[1] : null);
  const mentionCandidates = useMentionCandidates(
    worktreeFiles,
    mentionMatch ? mentionMatch[1] : null,
  );

  // The slash menu stays open even with zero candidates — unlike
  // @-mention, "no matches" here can mean three different things the
  // user shouldn't have to guess between: this agent has no slash
  // commands at all (Cursor/Codex — confirmed live: unlike Claude
  // Code's `--print`, which genuinely intercepts built-ins locally at
  // zero API cost, Cursor's just gets forwarded to the model as plain
  // text, which role-plays a response instead of taking any real
  // action), this project/CLI genuinely has none configured, or the
  // typed query just doesn't match anything real. See below for which
  // message renders for which case.
  const activeMenu: "slash" | "mention" | null = slashMatch
    ? "slash"
    : mentionMatch && mentionCandidates.length > 0
      ? "mention"
      : null;
  const menuMatch =
    activeMenu === "slash" ? slashMatch : activeMenu === "mention" ? mentionMatch : null;
  const menuLength = activeMenu === "slash" ? slashCandidates.length : mentionCandidates.length;
  // The in-progress `@partial` the mention menu is currently matching
  // against — excluded from pill rendering below since it isn't a
  // finished token yet (see `renderHighlightedDraft`'s doc comment).
  const mentionExclude =
    activeMenu === "mention" && mentionMatch
      ? { start: mentionMatch.index, end: cursorPos }
      : null;

  const [menuIndexRaw, setMenuIndex] = useState(0);
  // Clamped rather than reset-on-change: the candidate list can shrink
  // out from under a stale index as the user keeps typing (each
  // keystroke re-filters), and indexing past the end would hand
  // `insertToken` an `undefined` value.
  const menuIndex = Math.min(menuIndexRaw, Math.max(menuLength - 1, 0));
  const activeItemRef = useScrollActiveIntoView<HTMLDivElement>(menuIndex, activeMenu);

  function syncCursor(el: HTMLTextAreaElement) {
    setCursorPos(el.selectionStart ?? draft.length);
  }

  /** Replaces the active `@`/`/` trigger (and whatever the user typed
   * after it) with the chosen token, trailed by a space. Shared by both
   * menus — they only differ in the prefix character and where the
   * value string comes from. */
  function insertToken(prefix: "@" | "/", value: string) {
    const el = textareaRef.current;
    if (!el || !menuMatch) return;
    const cursor = el.selectionStart;
    const start = cursor - menuMatch[0].length;
    const next = `${draft.slice(0, start)}${prefix}${value} ${draft.slice(cursor)}`;
    setDraft(runId, next);
    const pos = start + value.length + 2;
    setCursorPos(pos);
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(pos, pos);
    });
  }

  /** Splices one or more `@path` tokens in at the current cursor position
   * (or the end, if the textarea isn't mounted yet) as a single edit —
   * the shared landing point for every non-typed way context enters the
   * draft: file-tree drag/drop, the "Add context" picker, browsed files,
   * and pasted files/images. Batching multiple paths into one call (rather
   * than one `insertMention` call per path) matters for the multi-file
   * cases: each call reads `draft`/`selectionStart` fresh, so looping
   * single-path insertions in the same tick would each compute their
   * splice against the same stale `draft` and only the last one would
   * stick. */
  function insertMentionTokens(paths: string[]) {
    if (paths.length === 0) return;
    const token = `${paths.map((p) => `@${p}`).join(" ")} `;
    const el = textareaRef.current;
    const start = el?.selectionStart ?? draft.length;
    const end = el?.selectionEnd ?? start;
    const next = `${draft.slice(0, start)}${token}${draft.slice(end)}`;
    setDraft(runId, next);
    const pos = start + token.length;
    setCursorPos(pos);
    if (el) {
      requestAnimationFrame(() => {
        el.focus();
        el.setSelectionRange(pos, pos);
      });
    }
  }

  function insertMention(path: string) {
    insertMentionTokens([path]);
  }

  /** Only reacts to drags carrying the file tree's own custom MIME type
   * (set in `FileTreeRow.tsx`) — checked before `preventDefault` so an
   * unrelated drag (a text selection, something from outside the app)
   * passes through instead of being silently swallowed here. */
  function handleDragOver(event: DragEvent<HTMLDivElement>) {
    if (!event.dataTransfer.types.includes("application/x-maestro-file-path")) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    setDragOver(true);
  }

  function handleDrop(event: DragEvent<HTMLDivElement>) {
    const path = event.dataTransfer.getData("application/x-maestro-file-path");
    if (!path) return;
    event.preventDefault();
    setDragOver(false);
    insertMention(path);
  }

  /** Files come off the clipboard one of two ways depending on how they
   * got there: `clipboardData.files` holds real bytes (a screenshot, or
   * an image copied directly), while a file manager's "Copy" instead
   * puts a `text/uri-list` (the freedesktop.org standard MIME type GTK
   * apps use — Nautilus, Dolphin, etc.) or occasionally a bare
   * `file://…` string under `text/plain`. Both paths converge on the
   * same staging mechanism (`commands/attachments.rs`) so either way
   * ends up as a normal `@mention`. */
  function parseFileUris(uriList: string): string[] {
    return uriList
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#") && line.startsWith("file://"))
      .map((uri) => decodeURIComponent(uri.replace(/^file:\/\//, "")));
  }

  function readBlobAsBase64(blob: Blob): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const result = reader.result as string; // "data:<mime>;base64,<data>"
        const comma = result.indexOf(",");
        resolve(comma === -1 ? result : result.slice(comma + 1));
      };
      reader.onerror = () => reject(reader.error ?? new Error("failed to read pasted file"));
      reader.readAsDataURL(blob);
    });
  }

  async function stagePastedContent(base64: string, fileName: string): Promise<string | null> {
    if (!worktreeRoot) return null;
    return fsApi.savePastedAttachment(worktreeRoot, fileName, base64);
  }

  /** "Browse files…" in the Add context menu. The worktree list above it
   * can only ever offer what's already in the repo, so a PDF in Downloads
   * or a CSV exported from a dashboard had no way in short of copying it
   * into the tree by hand. Picked files take the identical route a file
   * pasted from a file manager already does — staged into
   * `.maestro/attachments/` and mentioned as `@path` — rather than a
   * second, separate attachment protocol. */
  async function browseForAttachments() {
    if (!worktreeRoot) return;
    setAttachError(null);
    let paths: string[];
    try {
      paths = await fsApi.pickAttachmentFiles();
    } catch (err) {
      setAttachError(String(err));
      return;
    }
    // Cancelling the dialog is not an error and shouldn't flash a spinner.
    if (paths.length === 0) return;
    setAttaching(true);
    try {
      const relPaths: string[] = [];
      for (const path of paths) {
        relPaths.push(await fsApi.copyFileIntoAttachments(worktreeRoot, path));
      }
      insertMentionTokens(relPaths);
    } catch (err) {
      setAttachError(String(err));
    } finally {
      setAttaching(false);
    }
  }

  /** WebKitGTK doesn't reliably put an actual clipboard image (a
   * screenshot, or an image copied via "Copy Image") into a `paste`
   * event's `clipboardData.files` the way Chromium does — confirmed by
   * this app's own font/icon rendering gaps against the same engine
   * (see `design/iconSize.ts`, `ExplorerSidebar.module.css`'s `.fileIcon`
   * comment). Reading the OS clipboard directly through Tauri's
   * clipboard-manager plugin sidesteps that gap entirely: `readImage()`
   * hands back raw RGBA bytes + dimensions, encoded to a PNG here via a
   * throwaway `<canvas>` (the browser's own, always-available image
   * encoder — no new backend image-encoding dependency needed). Returns
   * `null` (not a thrown error) when the clipboard simply doesn't hold
   * an image right now — the normal, expected case for a text paste. */
  async function tryReadClipboardImageAsPng(): Promise<Blob | null> {
    try {
      const image = await readImage();
      const [rgba, size] = await Promise.all([image.rgba(), image.size()]);
      if (size.width <= 0 || size.height <= 0) return null;
      const canvas = document.createElement("canvas");
      canvas.width = size.width;
      canvas.height = size.height;
      const ctx = canvas.getContext("2d");
      if (!ctx) return null;
      ctx.putImageData(new ImageData(new Uint8ClampedArray(rgba), size.width, size.height), 0, 0);
      return await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
    } catch {
      return null;
    }
  }

  /** Replicates the one piece of native paste behavior this handler
   * takes over when it turns out there's no image after all: inserting
   * plain text at the cursor (replacing any selection), same as
   * `insertToken` does for a selected mention/command. */
  function insertPlainText(text: string) {
    const el = textareaRef.current;
    if (!el) return;
    const start = el.selectionStart;
    const end = el.selectionEnd;
    const next = `${draft.slice(0, start)}${text}${draft.slice(end)}`;
    setDraft(runId, next);
    const pos = start + text.length;
    setCursorPos(pos);
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(pos, pos);
    });
  }

  async function handlePaste(event: ClipboardEvent<HTMLTextAreaElement>) {
    const files = Array.from(event.clipboardData.files ?? []);
    const uriList = event.clipboardData.getData("text/uri-list");
    const plainText = event.clipboardData.getData("text/plain");
    const fileUris = uriList
      ? parseFileUris(uriList)
      : plainText.startsWith("file://")
        ? parseFileUris(plainText)
        : [];

    if (files.length === 0 && fileUris.length === 0) {
      // Neither a real file blob nor a file reference showed up in the
      // native clipboard data — before treating this as an ordinary text
      // paste, check whether the OS clipboard actually holds an image
      // WebKitGTK just didn't surface here (see `tryReadClipboardImageAsPng`).
      // `preventDefault` either way: the async image check means the
      // native paste can't be conditionally cancelled after the fact, so
      // if it isn't an image the plain text already captured above is
      // inserted by hand instead, matching what native paste would have
      // done.
      event.preventDefault();
      if (!worktreeRoot) return;
      setAttaching(true);
      setAttachError(null);
      try {
        const imagePng = await tryReadClipboardImageAsPng();
        if (imagePng) {
          const base64 = await readBlobAsBase64(imagePng);
          const relPath = await stagePastedContent(base64, "pasted-image.png");
          if (relPath) insertMention(relPath);
        } else if (plainText) {
          insertPlainText(plainText);
        }
      } catch (err) {
        setAttachError(String(err));
      } finally {
        setAttaching(false);
      }
      return;
    }

    event.preventDefault();
    if (!worktreeRoot) return;
    setAttaching(true);
    setAttachError(null);
    try {
      const relPaths: string[] = [];
      for (const file of files) {
        const base64 = await readBlobAsBase64(file);
        const relPath = await stagePastedContent(base64, file.name || "pasted-file");
        if (relPath) relPaths.push(relPath);
      }
      for (const path of fileUris) {
        relPaths.push(await fsApi.copyFileIntoAttachments(worktreeRoot, path));
      }
      insertMentionTokens(relPaths);
    } catch (err) {
      setAttachError(String(err));
    } finally {
      setAttaching(false);
    }
  }

  function submit() {
    const fullText = draft.trim();
    if (!fullText) return;
    setDraft(runId, "");
    // Each turn is its own CLI process, so there is nothing to hand a
    // mid-turn message to. Hold it until the agent is free rather than
    // dropping it — the composer accepted the keystrokes, so silently
    // discarding them is the one behaviour that isn't defensible.
    if (disabled) {
      queueMessage(runId, fullText);
      return;
    }
    if (editingId) onReplace(editingId, fullText, resolvedModel, cliEffort, cliFast);
    else onSend(fullText, resolvedModel, cliEffort, cliFast);
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    // `menuLength === 0` means the slash menu is showing an informative
    // "nothing to pick" message (see `activeMenu`'s comment) rather than
    // real candidates — nothing to navigate/select, so fall through to
    // this function's own Enter-submits handling below instead.
    if (activeMenu && menuLength > 0) {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setMenuIndex((i) => (i + 1) % menuLength);
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        setMenuIndex((i) => (i - 1 + menuLength) % menuLength);
        return;
      }
      if (event.key === "Tab" || (event.key === "Enter" && !event.shiftKey)) {
        event.preventDefault();
        if (activeMenu === "slash") insertToken("/", slashCandidates[menuIndex].slug);
        else insertToken("@", mentionCandidates[menuIndex]);
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        // Nothing to clear in state — the menu closes itself once the
        // trigger text no longer matches (e.g. a space breaks it). This
        // branch just stops Escape from bubbling to anything else while
        // a menu is open.
        return;
      }
    }
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      submit();
    }
  }

  return (
    <div className={styles.wrap}>
      <div className={styles.inner}>
        {activeMenu === "mention" && (
          <div className={styles.mentionMenu}>
            {mentionCandidates.map((path, i) => (
              <div
                key={path}
                ref={i === menuIndex ? activeItemRef : undefined}
                className={styles.mentionItem}
                data-active={i === menuIndex}
                onMouseDown={(e) => {
                  e.preventDefault();
                  insertToken("@", path);
                }}
              >
                <At size={12} color="var(--text-mute)" />
                {path}
              </div>
            ))}
          </div>
        )}
        {activeMenu === "slash" && (
          <div className={styles.mentionMenu}>
            {slashCandidates.map((option, i) => (
              <div
                key={option.slug}
                ref={i === menuIndex ? activeItemRef : undefined}
                className={styles.slashItem}
                data-active={i === menuIndex}
                onMouseDown={(e) => {
                  e.preventDefault();
                  insertToken("/", option.slug);
                }}
              >
                <span className={styles.slashSlug}>/{option.slug}</span>
                {option.description && (
                  <span className={styles.slashDescription}>{option.description}</span>
                )}
              </div>
            ))}
            {slashCandidates.length === 0 &&
              (slashOptions.length === 0 ? (
                <div className={styles.slashEmpty}>
                  {AGENT_DISPLAY_NAME[kind]} has no discoverable slash commands for Maestro to list
                  — typing one still sends it as a plain message.
                </div>
              ) : (
                <div className={styles.slashEmpty}>
                  No commands match "/{slashMatch?.[1] ?? ""}".
                </div>
              ))}
          </div>
        )}
        <div
          className={styles.box}
          data-drag-over={dragOver}
          onDragOver={handleDragOver}
          onDragLeave={() => setDragOver(false)}
          onDrop={handleDrop}
        >
          {editingId && (
            <div className={styles.editingBanner}>
              <span className={styles.editingLabel}>Editing</span>
              <span className={styles.editingText}>
                {capabilities.forkSession
                  ? "Sending replaces this message and everything after it. The original conversation is kept as its own session."
                  : "Sending replaces this message and everything after it here — but this CLI can’t branch a session, so the agent still remembers the original."}
              </span>
              <button
                type="button"
                className={styles.chipRemove}
                aria-label="Cancel editing"
                onClick={() => cancelEditing(runId)}
              >
                <X size={11} />
              </button>
            </div>
          )}
          {queued.length > 0 && (
            <div className={styles.queue}>
              {queued.map((message, index) => (
                <div className={styles.queuedItem} key={`${index}-${message}`}>
                  <span className={styles.queuedLabel}>Queued</span>
                  <span className={styles.queuedText}>{message}</span>
                  <button
                    type="button"
                    className={styles.chipRemove}
                    aria-label="Remove queued message"
                    onClick={() => unqueueMessage(runId, index)}
                  >
                    <X size={11} />
                  </button>
                </div>
              ))}
            </div>
          )}
          {attaching && (
            <div className={styles.chips}>
              <span className={styles.chip}>Attaching…</span>
            </div>
          )}
          {attachError && (
            <div className={styles.attachError} onClick={() => setAttachError(null)}>
              Couldn't attach that: {attachError}
            </div>
          )}
          <div className={styles.textareaStack}>
            <div ref={overlayRef} className={styles.highlightOverlay} aria-hidden="true">
              {renderHighlightedDraft(draft, mentionExclude)}
            </div>
            <textarea
              ref={textareaRef}
              className={styles.textarea}
              rows={1}
              placeholder={
                disabled
                  ? "Working… type to queue a follow-up"
                  : "Reply, or ask a follow-up… (@ file, / command, paste to attach)"
              }
              value={draft}
              onChange={(e) => {
                setDraft(runId, e.target.value);
                setMenuIndex(0);
                syncCursor(e.target);
              }}
              onKeyDown={handleKeyDown}
              onKeyUp={(e) => syncCursor(e.currentTarget)}
              onClick={(e) => syncCursor(e.currentTarget)}
              onPaste={(e) => void handlePaste(e)}
              onScroll={(e) => {
                if (overlayRef.current) overlayRef.current.scrollTop = e.currentTarget.scrollTop;
              }}
            />
          </div>
          <div className={styles.toolbar}>
            <AttachFileButton
              worktreeFiles={worktreeFiles}
              onAttach={(path) => insertMention(path)}
              onBrowse={() => void browseForAttachments()}
            />
            {modelOptions.length > 0 && (
              <ModelPicker
                modelOptions={modelOptions}
                model={model}
                setModel={(id) => {
                  const option = modelOptions.find((candidate) => candidate.id === id);
                  const defaultEffort = option?.supportedEfforts.includes(effort)
                    ? effort
                    : (option?.supportedEfforts[0] ?? effort);
                  updateConfiguration({
                    model: id,
                    effort: defaultEffort,
                    thinking: false,
                    fast: false,
                  });
                }}
              />
            )}
            {selectedModel && effortValues.length > 0 && (
              <EffortPicker
                values={effortValues}
                value={effortValues.includes(effort) ? effort : effortValues[0]}
                onChange={(value) => updateConfiguration({ effort: value })}
                label={capabilities.effortLabel}
              />
            )}
            {selectedModel?.supportsThinking && (
              <OptionToggle
                label="Thinking"
                checked={thinking}
                onChange={(value) => updateConfiguration({ thinking: value })}
              />
            )}
            {selectedModel?.supportsFast && (
              <OptionToggle
                label="Fast"
                checked={fast}
                onChange={(value) => updateConfiguration({ fast: value })}
              />
            )}
            <PermissionModePicker
              mode={permissionMode}
              onChange={onPermissionModeChange}
              capabilities={capabilities}
            />
            <div style={{ flex: 1 }} />
            <button
              type="button"
              className={styles.send}
              disabled={draft.trim().length === 0}
              onClick={submit}
              aria-label={disabled ? "Queue message" : "Send"}
              title={
                disabled ? "The agent is busy — this will be sent when it finishes" : undefined
              }
            >
              <ArrowUp size={16} />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
