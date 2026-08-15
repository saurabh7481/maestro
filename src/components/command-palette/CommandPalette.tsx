import { useEffect, useMemo, useRef, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { MagnifyingGlass } from "@phosphor-icons/react";
import { useUiStore } from "../../state/uiStore";
import { useTabsStore, fileTabId } from "../../state/tabsStore";
import { useActiveWorktree } from "../../state/workspaceStore";
import { useKeybindingsStore } from "../../state/keybindingsStore";
import { useScmStore } from "../../state/scmStore";
import { useReadyAgentKinds } from "../../state/agentAvailabilityStore";
import { AGENT_DISPLAY_NAME } from "../../types/agent";
import { searchApi } from "../../api/search";
import { clampZoom, ZOOM_DEFAULT, ZOOM_STEP } from "../../design/zoom";
import { fuzzyMatch, fuzzyScore } from "../../design/fuzzy";
import { comboMatchesEvent } from "../../design/keymap";
import { useScrollActiveIntoView } from "../../design/useScrollActiveIntoView";
import { iconForFile } from "../explorer/fileIcons";
import { ICON_SIZE } from "../../design/iconSize";
import styles from "./CommandPalette.module.css";

const QUICK_OPEN_MAX_RESULTS = 50;

function isMarkdownPath(path: string): boolean {
  return /\.mdx?$/i.test(path);
}

interface Command {
  id: string;
  label: string;
  group: string;
  run: () => void;
}

function useCommands(): Command[] {
  const setTheme = useUiStore((s) => s.setTheme);
  const setZoom = useUiStore((s) => s.setZoom);
  const zoom = useUiStore((s) => s.zoom);
  const toggleLeftSidebar = useUiStore((s) => s.toggleLeftSidebar);
  const toggleRightSidebar = useUiStore((s) => s.toggleRightSidebar);
  const setSidebarView = useUiStore((s) => s.setSidebarView);
  const openSettings = useUiStore((s) => s.openSettings);
  const openQuickOpen = useUiStore((s) => s.openQuickOpen);
  const openTab = useTabsStore((s) => s.openTab);
  const activeWorktree = useActiveWorktree();
  const fetchRemote = useScmStore((s) => s.fetch);
  const pull = useScmStore((s) => s.pull);
  const push = useScmStore((s) => s.push);
  const readyAgentKinds = useReadyAgentKinds();

  return useMemo(() => {
    const commands: Command[] = [
      {
        id: "view.explorer",
        label: "Show Explorer",
        group: "view",
        run: () => setSidebarView("explorer"),
      },
      {
        id: "view.scm",
        label: "Show Source Control",
        group: "view",
        run: () => setSidebarView("scm"),
      },
      {
        id: "view.history",
        label: "Show History",
        group: "view",
        run: () => setSidebarView("history"),
      },
      {
        id: "view.search",
        label: "Show Search",
        group: "view",
        run: () => setSidebarView("search"),
      },
      { id: "view.left", label: "Toggle Workspace Sidebar", group: "view", run: toggleLeftSidebar },
      { id: "view.right", label: "Toggle Right Panel", group: "view", run: toggleRightSidebar },
      {
        id: "nav.quickOpen",
        label: "Go to File…",
        group: "navigate",
        run: openQuickOpen,
      },
      {
        id: "theme.maestro",
        label: "Theme: Maestro Dark",
        group: "theme",
        run: () => setTheme("maestro"),
      },
      {
        id: "theme.darkplus",
        label: "Theme: VS Code Dark+",
        group: "theme",
        run: () => setTheme("darkplus"),
      },
      {
        id: "theme.onedark",
        label: "Theme: One Dark Pro",
        group: "theme",
        run: () => setTheme("onedark"),
      },
      {
        id: "theme.oled",
        label: "Theme: OLED",
        group: "theme",
        run: () => setTheme("oled"),
      },
      {
        id: "zoom.in",
        label: "Zoom In",
        group: "zoom",
        run: () => setZoom(clampZoom(zoom + ZOOM_STEP)),
      },
      {
        id: "zoom.out",
        label: "Zoom Out",
        group: "zoom",
        run: () => setZoom(clampZoom(zoom - ZOOM_STEP)),
      },
      { id: "zoom.reset", label: "Reset Zoom", group: "zoom", run: () => setZoom(ZOOM_DEFAULT) },
      { id: "settings.open", label: "Open Settings", group: "app", run: openSettings },
    ];

    // Anything that opens a tab bound to "the active worktree" or acts on
    // its git remote has no sensible target without one — omitted rather
    // than shown disabled, same reasoning `NewTabMenu` already applies to
    // its own agent/terminal entries.
    if (activeWorktree) {
      commands.push(
        {
          id: "tab.terminal",
          label: "New Terminal",
          group: "tab",
          run: () =>
            openTab({
              id: crypto.randomUUID(),
              type: "terminal",
              title: `Terminal — ${activeWorktree.branch}`,
              worktreeRoot: activeWorktree.path,
            }),
        },
        { id: "git.fetch", label: "Git: Fetch", group: "git", run: () => void fetchRemote() },
        { id: "git.pull", label: "Git: Pull", group: "git", run: () => void pull() },
        { id: "git.push", label: "Git: Push", group: "git", run: () => void push() },
      );
      for (const kind of readyAgentKinds) {
        commands.push({
          id: `tab.agent.${kind}`,
          label: `New ${AGENT_DISPLAY_NAME[kind]} Session`,
          group: "tab",
          run: () =>
            openTab({
              id: crypto.randomUUID(),
              type: "agent",
              title: AGENT_DISPLAY_NAME[kind],
              agentKind: kind,
              worktreeId: activeWorktree.id,
              worktreeRoot: activeWorktree.path,
            }),
        });
      }
    }

    return commands;
  }, [
    setTheme,
    setZoom,
    zoom,
    toggleLeftSidebar,
    toggleRightSidebar,
    setSidebarView,
    openSettings,
    openQuickOpen,
    openTab,
    activeWorktree,
    fetchRemote,
    pull,
    push,
    readyAgentKinds,
  ]);
}

function splitPath(path: string): { name: string; dir: string } {
  const idx = path.lastIndexOf("/");
  return idx === -1 ? { name: path, dir: "" } : { name: path.slice(idx + 1), dir: path.slice(0, idx) };
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
  onRunCommand,
  onOpenFile,
}: {
  commands: Command[];
  mode: "commands" | "quickOpen";
  worktreeRoot: string | undefined;
  onRunCommand: (c: Command) => void;
  onOpenFile: (path: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [highlighted, setHighlighted] = useState(0);
  const [prevQuery, setPrevQuery] = useState(query);
  const inputRef = useRef<HTMLInputElement>(null);
  const files = useWorktreeFiles(worktreeRoot, mode === "quickOpen");

  const commandResults = useMemo(
    () => (mode === "commands" ? commands.filter((c) => fuzzyMatch(query, c.label)) : []),
    [mode, commands, query],
  );

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
  const commands = useCommands();
  const activeWorktree = useActiveWorktree();
  const ensureTab = useTabsStore((s) => s.ensureTab);

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
    setOpen(false);
  }

  function openFile(relPath: string) {
    if (activeWorktree) {
      ensureTab({
        id: fileTabId(activeWorktree.id, relPath),
        type: isMarkdownPath(relPath) ? "markdown" : "file",
        title: relPath.split("/").pop() ?? relPath,
        filePath: relPath,
        worktreeRoot: activeWorktree.path,
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
              onRunCommand={runCommand}
              onOpenFile={openFile}
            />
          )}
        </Dialog.Overlay>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
