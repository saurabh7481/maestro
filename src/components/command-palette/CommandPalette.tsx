import { useEffect, useMemo, useRef, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { MagnifyingGlass } from "@phosphor-icons/react";
import { useUiStore } from "../../state/uiStore";
import { useTabsStore } from "../../state/tabsStore";
import { clampZoom, ZOOM_DEFAULT, ZOOM_STEP } from "../../design/zoom";
import { fuzzyMatch } from "../../design/fuzzy";
import styles from "./CommandPalette.module.css";

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
  const openTab = useTabsStore((s) => s.openTab);

  return useMemo(
    () => [
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
      { id: "view.left", label: "Toggle Workspace Sidebar", group: "view", run: toggleLeftSidebar },
      { id: "view.right", label: "Toggle Right Panel", group: "view", run: toggleRightSidebar },
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
      {
        id: "tab.terminal",
        label: "New Terminal",
        group: "tab",
        run: () => openTab({ id: crypto.randomUUID(), type: "terminal", title: "New Terminal" }),
      },
    ],
    [
      setTheme,
      setZoom,
      zoom,
      toggleLeftSidebar,
      toggleRightSidebar,
      setSidebarView,
      openSettings,
      openTab,
    ],
  );
}

/** Mounted only while the palette is open (see below), so `query` and
 * `highlighted` start fresh on every open without an effect. */
function PaletteBody({
  commands,
  onRunCommand,
}: {
  commands: Command[];
  onRunCommand: (c: Command) => void;
}) {
  const [query, setQuery] = useState("");
  const [highlighted, setHighlighted] = useState(0);
  const [prevQuery, setPrevQuery] = useState(query);
  const inputRef = useRef<HTMLInputElement>(null);

  const results = useMemo(
    () => commands.filter((c) => fuzzyMatch(query, c.label)),
    [commands, query],
  );

  // Adjust derived state during render instead of in an effect — React's
  // documented pattern for "reset state when an input changes".
  if (query !== prevQuery) {
    setPrevQuery(query);
    setHighlighted(0);
  }

  function onKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setHighlighted((i) => Math.min(i + 1, results.length - 1));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setHighlighted((i) => Math.max(i - 1, 0));
    } else if (event.key === "Enter") {
      event.preventDefault();
      const command = results[highlighted];
      if (command) onRunCommand(command);
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
      <Dialog.Title className="mo-visually-hidden">Command palette</Dialog.Title>
      <div className={styles.inputRow}>
        <MagnifyingGlass size={16} color="var(--text-mute)" />
        <input
          ref={inputRef}
          className={styles.input}
          placeholder="Type a command…"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={onKeyDown}
        />
      </div>
      <div className={styles.list}>
        {results.length === 0 && <div className={styles.empty}>No matching commands</div>}
        {results.map((command, index) => (
          <div
            key={command.id}
            className={styles.item}
            data-active={index === highlighted}
            onMouseEnter={() => setHighlighted(index)}
            onClick={() => onRunCommand(command)}
          >
            <span className={styles.itemLabel}>{command.label}</span>
            <span className={styles.itemGroup}>{command.group}</span>
          </div>
        ))}
      </div>
    </Dialog.Content>
  );
}

export function CommandPalette() {
  const open = useUiStore((s) => s.commandPaletteOpen);
  const setOpen = useUiStore((s) => s.setCommandPaletteOpen);
  const commands = useCommands();

  useEffect(() => {
    function onGlobalKeyDown(event: KeyboardEvent): void {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setOpen(!useUiStore.getState().commandPaletteOpen);
      }
    }
    window.addEventListener("keydown", onGlobalKeyDown);
    return () => window.removeEventListener("keydown", onGlobalKeyDown);
  }, [setOpen]);

  function runCommand(command: Command) {
    command.run();
    setOpen(false);
  }

  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Portal>
        <Dialog.Overlay className={styles.overlay}>
          {open && <PaletteBody commands={commands} onRunCommand={runCommand} />}
        </Dialog.Overlay>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
