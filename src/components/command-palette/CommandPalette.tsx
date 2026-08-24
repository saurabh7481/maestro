import { useEffect, useMemo, useRef, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { MagnifyingGlass } from "@phosphor-icons/react";
import { useUiStore } from "../../state/uiStore";
import { useTabsStore, fileTabId, classifyFileTabType } from "../../state/tabsStore";
import { useActiveWorktree } from "../../state/workspaceStore";
import { useKeybindingsStore } from "../../state/keybindingsStore";
import { searchApi } from "../../api/search";
import { applyTheme } from "../../design/themes";
import type { ThemeId } from "../../design/themes";
import { fuzzyMatch, fuzzyScore } from "../../design/fuzzy";
import { comboMatchesEvent } from "../../design/keymap";
import { useScrollActiveIntoView } from "../../design/useScrollActiveIntoView";
import { loadCommandRecency, recordCommandRun } from "../../design/persistence";
import { iconForFile } from "../explorer/fileIcons";
import { ICON_SIZE } from "../../design/iconSize";
import { useCommands, type Command } from "./commands";
import styles from "./CommandPalette.module.css";

const QUICK_OPEN_MAX_RESULTS = 50;

/** Recently-run command ids, newest first, loaded once and kept in memory
 * so re-opening the palette doesn't wait on a disk read — commands run
 * often enough (and this is small enough) that an in-memory cache never
 * meaningfully drifts from what's on disk within one app session. */
function useCommandRecency(): { recentIds: string[]; record: (id: string) => void } {
  const [recentIds, setRecentIds] = useState<string[]>([]);
  useEffect(() => {
    void loadCommandRecency().then(setRecentIds);
  }, []);
  function record(id: string) {
    setRecentIds((prev) => [id, ...prev.filter((existing) => existing !== id)].slice(0, 10));
    void recordCommandRun(id);
  }
  return { recentIds, record };
}

/** Recent commands first (most-recent first), everything else after in
 * whatever order it was already in — only applied to the empty-query
 * "browse" list; a real search query ranks by match quality instead. */
function withRecencyOrder(commands: Command[], recentIds: string[]): Command[] {
  if (recentIds.length === 0) return commands;
  const byId = new Map(commands.map((c) => [c.id, c]));
  const recent = recentIds.map((id) => byId.get(id)).filter((c): c is Command => !!c);
  const recentIdSet = new Set(recent.map((c) => c.id));
  return [...recent, ...commands.filter((c) => !recentIdSet.has(c.id))];
}

function splitPath(path: string): { name: string; dir: string } {
  const idx = path.lastIndexOf("/");
  return idx === -1
    ? { name: path, dir: "" }
    : { name: path.slice(idx + 1), dir: path.slice(0, idx) };
}

/** Fetches the active worktree's file list once per (worktree, mode-open)
 * — refetching on every quick-open is cheap enough (`git ls-files`) that
 * no cross-session cache is worth the complexity; see `search.rs`. */
function useWorktreeFiles(worktreeRoot: string | undefined, enabled: boolean): string[] {
  const [files, setFiles] = useState<string[]>([]);
  useEffect(() => {
    if (!enabled || !worktreeRoot) return;
    let cancelled = false;
    void searchApi.listFiles(worktreeRoot).then((list) => {
      if (!cancelled) setFiles(list);
    });
    return () => {
      cancelled = true;
    };
  }, [enabled, worktreeRoot]);
  return files;
}

/** Mounted only while the palette is open (see below), so `query` and
 * `highlighted` start fresh on every open without an effect. Doubles as
 * both the ⌘K command palette and the ⌘P quick-open file jump — they
 * share one dialog shell/keyboard-nav and differ only in result source. */
function PaletteBody({
  commands,
  mode,
  worktreeRoot,
  recentIds,
  currentTheme,
  onRunCommand,
  onOpenFile,
}: {
  commands: Command[];
  mode: "commands" | "quickOpen";
  worktreeRoot: string | undefined;
  recentIds: string[];
  currentTheme: ThemeId;
  onRunCommand: (c: Command) => void;
  onOpenFile: (path: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [highlighted, setHighlighted] = useState(0);
  const [prevQuery, setPrevQuery] = useState(query);
  const inputRef = useRef<HTMLInputElement>(null);
  const files = useWorktreeFiles(worktreeRoot, mode === "quickOpen");

  const commandResults = useMemo(() => {
    if (mode !== "commands") return [];
    if (query === "") return withRecencyOrder(commands, recentIds);
    return commands.filter((c) => fuzzyMatch(query, c.label));
  }, [mode, commands, query, recentIds]);

  // Live-previews the highlighted `theme.*` command directly on the DOM
  // (not through `setTheme`, which would write the whole prefs blob to
  // disk on every arrow-key move) — reverted on close in `CommandPalette`
  // below unless the user actually commits to it via Enter/click.
  useEffect(() => {
    if (mode !== "commands") return;
    const highlightedCommand = commandResults[highlighted];
    applyTheme(document.documentElement, highlightedCommand?.previewTheme ?? currentTheme);
  }, [mode, commandResults, highlighted, currentTheme]);

  const fileResults = useMemo(() => {
    if (mode !== "quickOpen") return [];
    return files
      .map((path) => ({ path, score: fuzzyScore(query, path) }))
      .filter((r): r is { path: string; score: number } => r.score !== null)
      .sort((a, b) => b.score - a.score)
      .slice(0, QUICK_OPEN_MAX_RESULTS)
      .map((r) => r.path);
  }, [mode, files, query]);

  const resultCount = mode === "commands" ? commandResults.length : fileResults.length;
  const activeItemRef = useScrollActiveIntoView<HTMLDivElement>(highlighted, mode);

  // Adjust derived state during render instead of in an effect — React's
  // documented pattern for "reset state when an input changes".
  if (query !== prevQuery) {
    setPrevQuery(query);
    setHighlighted(0);
  }

  function onKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setHighlighted((i) => Math.min(i + 1, resultCount - 1));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setHighlighted((i) => Math.max(i - 1, 0));
    } else if (event.key === "Enter") {
      event.preventDefault();
      if (mode === "commands") {
        const command = commandResults[highlighted];
        if (command) onRunCommand(command);
      } else {
        const path = fileResults[highlighted];
        if (path) onOpenFile(path);
      }
    }
  }

  return (
    <Dialog.Content
      className={`${styles.content} mo-glass`}
      aria-describedby={undefined}
      onOpenAutoFocus={(event) => {
        event.preventDefault();
        inputRef.current?.focus();
      }}
    >
      <Dialog.Title className="mo-visually-hidden">
        {mode === "commands" ? "Command palette" : "Quick open"}
      </Dialog.Title>
      <div className={styles.inputRow}>
        <MagnifyingGlass size={16} color="var(--text-mute)" />
        <input
          ref={inputRef}
          className={styles.input}
          placeholder={mode === "commands" ? "Type a command…" : "Go to file…"}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={onKeyDown}
        />
      </div>
      <div className={styles.list}>
        {resultCount === 0 && (
          <div className={styles.empty}>
            {mode === "commands" ? "No matching commands" : "No matching files"}
          </div>
        )}
        {mode === "commands" &&
          commandResults.map((command, index) => (
            <div
              key={command.id}
              ref={index === highlighted ? activeItemRef : undefined}
              className={styles.item}
              data-active={index === highlighted}
              onMouseEnter={() => setHighlighted(index)}
              onClick={() => onRunCommand(command)}
            >
              <span className={styles.itemLabel}>{command.label}</span>
              <span className={styles.itemGroup}>{command.group}</span>
            </div>
          ))}
        {mode === "quickOpen" &&
          fileResults.map((path, index) => {
            const { name, dir } = splitPath(path);
            const { icon: Icon, color } = iconForFile(name);
            return (
              <div
                key={path}
                ref={index === highlighted ? activeItemRef : undefined}
                className={styles.item}
                data-active={index === highlighted}
                onMouseEnter={() => setHighlighted(index)}
                onClick={() => onOpenFile(path)}
              >
                <span className={styles.itemIcon}>
                  <Icon size={ICON_SIZE.sm} color={color} />
                </span>
                <span className={styles.itemLabel}>{name}</span>
                {dir && <span className={styles.itemGroup}>{dir}</span>}
              </div>
            );
          })}
      </div>
    </Dialog.Content>
  );
}

export function CommandPalette() {
  const open = useUiStore((s) => s.commandPaletteOpen);
  const quickOpenMode = useUiStore((s) => s.quickOpenMode);
  const setOpen = useUiStore((s) => s.setCommandPaletteOpen);
  const openQuickOpen = useUiStore((s) => s.openQuickOpen);
  const theme = useUiStore((s) => s.theme);
  const commands = useCommands();
  const activeWorktree = useActiveWorktree();
  const ensureTab = useTabsStore((s) => s.ensureTab);
  const { recentIds, record } = useCommandRecency();

  // Whatever got previewed while the palette was open (see `PaletteBody`)
  // is only real once committed via `runCommand` below — closing any other
  // way (Escape, outside click, a non-theme command) snaps the DOM back to
  // the actually-persisted theme.
  useEffect(() => {
    if (!open) applyTheme(document.documentElement, theme);
  }, [open, theme]);

  useEffect(() => {
    function onGlobalKeyDown(event: KeyboardEvent): void {
      const comboFor = useKeybindingsStore.getState().comboFor;
      // Command palette open and its alternate binding (VS Code binds
      // ⌘⇧P to this; ⌘K is kept as the primary since the Titlebar search
      // bar already advertises it) both just toggle the command list.
      // Quick-open is kept as a distinct action — file jump by name,
      // rather than one shortcut trying to search both.
      if (
        comboMatchesEvent(comboFor("commandPalette.open"), event) ||
        comboMatchesEvent(comboFor("commandPalette.openAlt"), event)
      ) {
        event.preventDefault();
        const state = useUiStore.getState();
        if (state.commandPaletteOpen && !state.quickOpenMode) {
          setOpen(false);
        } else {
          setOpen(true);
        }
      } else if (comboMatchesEvent(comboFor("quickOpen.open"), event)) {
        event.preventDefault();
        const state = useUiStore.getState();
        if (state.commandPaletteOpen && state.quickOpenMode) {
          setOpen(false);
        } else {
          openQuickOpen();
        }
      }
    }
    window.addEventListener("keydown", onGlobalKeyDown);
    return () => window.removeEventListener("keydown", onGlobalKeyDown);
  }, [setOpen, openQuickOpen]);

  function runCommand(command: Command) {
    command.run();
    record(command.id);
    setOpen(false);
  }

  function openFile(relPath: string) {
    if (activeWorktree) {
      ensureTab({
        id: fileTabId(activeWorktree.id, relPath),
        type: classifyFileTabType(relPath),
        title: relPath.split("/").pop() ?? relPath,
        filePath: relPath,
        worktreeRoot: activeWorktree.path,
        worktreeId: activeWorktree.id,
      });
    }
    setOpen(false);
  }

  const mode = quickOpenMode ? "quickOpen" : "commands";

  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Portal>
        <Dialog.Overlay className={styles.overlay}>
          {open && (
            <PaletteBody
              commands={commands}
              mode={mode}
              worktreeRoot={activeWorktree?.path}
              recentIds={recentIds}
              currentTheme={theme}
              onRunCommand={runCommand}
              onOpenFile={openFile}
            />
          )}
        </Dialog.Overlay>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
