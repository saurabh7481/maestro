import { useEffect, useMemo, useRef, useState } from "react";
import type { ClipboardEvent, KeyboardEvent, ReactNode } from "react";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import {
  ArrowUp,
  At,
  CaretDown,
  Check,
  Compass,
  Lightning,
  Paperclip,
  ShieldCheck,
  Sparkle,
  X,
} from "@phosphor-icons/react";
import type { Icon } from "@phosphor-icons/react";
import { readImage } from "@tauri-apps/plugin-clipboard-manager";
import { EMPTY_ATTACHMENTS, useAgentSessionStore } from "../../state/agentSessionStore";
import { agentsApi } from "../../api/agents";
import { fsApi } from "../../api/fs";
import { searchApi } from "../../api/search";
import { fuzzyScore } from "../../design/fuzzy";
import { useScrollActiveIntoView } from "../../design/useScrollActiveIntoView";
import { AGENT_DISPLAY_NAME } from "../../types/agent";
import type { AgentKind, ModelOption, PermissionMode, SlashCommandOption } from "../../types/agent";
import styles from "./AgentComposer.module.css";

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
  locked,
}: {
  modelOptions: ModelOption[];
  model: string | null;
  setModel: (id: string) => void;
  locked: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const selectedLabel = modelOptions.find((m) => m.id === model)?.label ?? "Default";

  if (locked) {
    return (
      <div className={styles.picker} data-locked>
        <Sparkle size={13} color="var(--accent)" />
        {selectedLabel}
      </div>
    );
  }

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

function PermissionModePicker({
  mode,
  onChange,
}: {
  mode: PermissionMode;
  onChange: (mode: PermissionMode) => void;
}) {
  const meta = PERMISSION_MODE_META[mode];
  const ModeIcon = meta.icon;
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
          {PERMISSION_MODE_ORDER.map((id) => {
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
}: {
  worktreeFiles: string[];
  onAttach: (path: string) => void;
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
      emptyLabel="No matching files"
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
}: {
  runId: string;
  kind: AgentKind;
  worktreeRoot: string;
  /** Working — can't send right now. */
  disabled: boolean;
  /** Session already started — model can't change mid-session. */
  locked: boolean;
  permissionMode: PermissionMode;
  onPermissionModeChange: (mode: PermissionMode) => void;
  onSend: (text: string, model: string | null) => void;
}) {
  const draft = useAgentSessionStore((s) => s.draftByRunId[runId] ?? "");
  const setDraft = useAgentSessionStore((s) => s.setDraft);
  const attachedPaths = useAgentSessionStore((s) => s.attachedByRunId[runId] ?? EMPTY_ATTACHMENTS);
  const addAttachment = useAgentSessionStore((s) => s.addAttachment);
  const removeAttachment = useAgentSessionStore((s) => s.removeAttachment);
  const clearAttachments = useAgentSessionStore((s) => s.clearAttachments);
  const modelOptions = useAgentModels(kind);
  const slashOptions = useSlashCommands(kind, worktreeRoot);
  const [model, setModel] = useState<string | null>(null);
  const [attaching, setAttaching] = useState(false);
  const [attachError, setAttachError] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  // Cursor position is tracked via state (updated from event handlers),
  // not read from `textareaRef.current` during render — reading a ref's
  // value at render time is unsafe (react-hooks/refs).
  const [cursorPos, setCursorPos] = useState(0);

  const worktreeFiles = useWorktreeFileList(worktreeRoot);

  // A "/word" only means anything as the very first token of the whole
  // message (matching how every one of these CLIs' own interactive
  // slash commands work) — checked first so "/foo@bar" doesn't also
  // register as an @-mention of "@bar".
  const slashMatch = /^\/(\S*)$/.exec(draft.slice(0, cursorPos));
  const mentionMatch = slashMatch ? null : /@([\w./-]*)$/.exec(draft.slice(0, cursorPos));

  const slashCandidates = useSlashCandidates(slashOptions, slashMatch ? slashMatch[1] : null);
  const mentionCandidates = useMentionCandidates(worktreeFiles, mentionMatch ? mentionMatch[1] : null);

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
  const menuMatch = activeMenu === "slash" ? slashMatch : activeMenu === "mention" ? mentionMatch : null;
  const menuLength = activeMenu === "slash" ? slashCandidates.length : mentionCandidates.length;

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

  async function stageAndAttach(base64: string, fileName: string) {
    if (!worktreeRoot) return;
    const relPath = await fsApi.savePastedAttachment(worktreeRoot, fileName, base64);
    addAttachment(runId, relPath);
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
          await stageAndAttach(base64, "pasted-image.png");
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
      for (const file of files) {
        const base64 = await readBlobAsBase64(file);
        await stageAndAttach(base64, file.name || "pasted-file");
      }
      for (const path of fileUris) {
        const relPath = await fsApi.copyFileIntoAttachments(worktreeRoot, path);
        addAttachment(runId, relPath);
      }
    } catch (err) {
      setAttachError(String(err));
    } finally {
      setAttaching(false);
    }
  }

  function submit() {
    const text = draft.trim();
    if (!text || disabled) return;
    // Attached-via-button files become the same `@path` mentions typing
    // them inline would — reuses the one proven attachment mechanism
    // instead of a separate, unverified protocol. Prepended so they read
    // as context set up before the message, not part of its wording.
    const attachmentPrefix = attachedPaths.map((p) => `@${p}`).join(" ");
    const fullText = attachmentPrefix ? `${attachmentPrefix}\n${text}` : text;
    setDraft(runId, "");
    clearAttachments(runId);
    onSend(fullText, model);
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
                  {AGENT_DISPLAY_NAME[kind]} has no discoverable slash commands for Maestro to
                  list — typing one still sends it as a plain message.
                </div>
              ) : (
                <div className={styles.slashEmpty}>
                  No commands match "/{slashMatch?.[1] ?? ""}".
                </div>
              ))}
          </div>
        )}
        <div className={styles.box}>
          {(attachedPaths.length > 0 || attaching) && (
            <div className={styles.chips}>
              {attachedPaths.map((path) => (
                <span key={path} className={styles.chip}>
                  <span className={styles.rowIcon}>
                    <At size={11} color="var(--text-mute)" />
                  </span>
                  {path}
                  <button
                    type="button"
                    className={styles.chipRemove}
                    aria-label={`Remove ${path}`}
                    onClick={() => removeAttachment(runId, path)}
                  >
                    <X size={11} />
                  </button>
                </span>
              ))}
              {attaching && <span className={styles.chip}>Attaching…</span>}
            </div>
          )}
          {attachError && (
            <div className={styles.attachError} onClick={() => setAttachError(null)}>
              Couldn't attach that: {attachError}
            </div>
          )}
          <textarea
            ref={textareaRef}
            className={styles.textarea}
            rows={1}
            placeholder={
              disabled
                ? "Working…"
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
          />
          <div className={styles.toolbar}>
            <AttachFileButton
              worktreeFiles={worktreeFiles}
              onAttach={(path) => addAttachment(runId, path)}
            />
            {modelOptions.length > 0 && (
              <ModelPicker
                modelOptions={modelOptions}
                model={model}
                setModel={setModel}
                locked={locked}
              />
            )}
            <PermissionModePicker mode={permissionMode} onChange={onPermissionModeChange} />
            <div style={{ flex: 1 }} />
            <button
              type="button"
              className={styles.send}
              disabled={disabled || draft.trim().length === 0}
              onClick={submit}
              aria-label="Send"
            >
              <ArrowUp size={16} />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
