import { useEffect, useRef, useState } from "react";
import {
  CaretDown,
  CaretUp,
  MagnifyingGlass,
  TerminalWindow,
  WarningCircle,
  X,
} from "@phosphor-icons/react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon, type ISearchOptions } from "@xterm/addon-search";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { ClipboardAddon, type IClipboardProvider } from "@xterm/addon-clipboard";
import { openUrl } from "@tauri-apps/plugin-opener";
import "@xterm/xterm/css/xterm.css";
import { terminalApi } from "../../api/terminal";
import { replayTerminalBuffer, useTerminalSessionStore } from "../../state/terminalSessionStore";
import type { Tab } from "../../state/tabsStore";
import { useActiveWorktree } from "../../state/workspaceStore";
import { isMac } from "../../design/platform";
import styles from "./TerminalTab.module.css";

// `ClipboardAddon` wires up OSC 52, the escape sequence a *program running
// in the shell* (tmux, neovim's `+`/`*` register sync, …) emits to read or
// write the system clipboard directly, independent of the Ctrl/Cmd+C/V
// keybindings below — those only fire on an actual keypress from the user.
// The read half (`\x1b]52;c;?\x07`) lets a program's *output* — `cat`-ing an
// untrusted file, or text relayed from a compromised remote host over SSH —
// silently ask the terminal to hand back whatever's on the clipboard, which
// would turn "something printed to this terminal" into a clipboard-
// exfiltration channel. Matching WezTerm's and kitty's default posture,
// reads are refused; only the write half (a program *setting* the
// clipboard) is wired up.
const clipboardProvider: IClipboardProvider = {
  readText: () => "",
  writeText: (_selection, text) => navigator.clipboard.writeText(text),
};

const SEARCH_DECORATIONS: NonNullable<ISearchOptions["decorations"]> = {
  matchBackground: "#2d3348",
  matchBorder: "#4b5578",
  matchOverviewRuler: "#4b5578",
  activeMatchBackground: "#40456b",
  activeMatchBorder: "#7c8cff",
  activeMatchColorOverviewRuler: "#7c8cff",
};

// Mirrors the "maestro" theme's tokens (`design/themes.ts`) rather than
// reading them live — xterm.js's `theme` option is a one-time snapshot
// passed to the `Terminal` constructor below, not a reactive binding, so
// there's nothing gained by importing the theme module for values that
// would go stale the moment the user switches themes anyway.
const THEME = {
  background: "#08090d",
  foreground: "#d5dae2",
  cursor: "#7c8cff",
  cursorAccent: "#08090d",
  selectionBackground: "rgba(124,140,255,.3)",
  black: "#1a1f28",
  red: "#e06c75",
  green: "#98c379",
  yellow: "#e5c07b",
  blue: "#61afef",
  magenta: "#c678dd",
  cyan: "#56b6c2",
  white: "#aab4c6",
  brightBlack: "#7d8898",
  brightRed: "#ff7b86",
  brightGreen: "#a8d389",
  brightYellow: "#f5d08b",
  brightBlue: "#7ec2ff",
  brightMagenta: "#d68eea",
  brightCyan: "#67c6d2",
  brightWhite: "#e7ebf2",
};

// A concrete font stack, not `var(--font-mono)` — xterm.js measures glyphs
// and sets the canvas 2D context's `font` property directly with this
// string, which (unlike a stylesheet) never resolves CSS custom
// properties. Passing the CSS var literally left the terminal silently
// falling back to the browser/OS's generic monospace font instead of the
// JetBrains Mono the rest of the app renders with — the single biggest
// reason it read as visually inconsistent. Mirrors MonacoHost.tsx's
// `MONACO_FONT_FAMILY`, which sidesteps the same canvas-rendering gap.
const TERMINAL_FONT_FAMILY =
  "'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";

/** xterm.js's own scrollback, in lines. Each retained line costs roughly
 * `columns × 4` bytes in its cell buffer, so the old 8000 was on the order
 * of 6 MB per open terminal at a typical width — and terminals now stay
 * mounted for as long as they're open (`TabHost.tsx`), so that is resident
 * RAM per tab, not per visible tab. 2000 lines is still well past what
 * anyone scrolls back through by hand and cuts that by ~75%.
 * See docs/PERFORMANCE_AUDIT.md §1.1. */
const SCROLLBACK_LINES = 2000;

/** Real PTY terminal tab (docs/ROADMAP.md Phase 7) — the backend process
 * lives in `AppState.terminals`, independent of this component's mount
 * state, so a rebuilt tab reconnects to the same running shell rather than
 * spawning a new one; `terminalSessionStore` replays buffered output into
 * the freshly created xterm.js instance so recent scrollback isn't lost
 * either.
 *
 * `active` is false while the tab is open but not focused — `TabHost`
 * keeps it mounted and hides it with `display: none` rather than
 * unmounting (docs/PERFORMANCE_AUDIT.md §1.2), which means this component
 * has to cope with having zero layout size for stretches at a time. */
export function TerminalTab({ tab, active }: { tab: Tab; active: boolean }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const activeWorktree = useActiveWorktree();
  const worktreeRoot = tab.worktreeRoot;
  const [spawnError, setSpawnError] = useState<string | null>(null);
  const refitRef = useRef<(() => void) | null>(null);

  const termRef = useRef<Terminal | null>(null);
  const searchAddonRef = useRef<SearchAddon | null>(null);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [matchInfo, setMatchInfo] = useState<{ index: number; count: number } | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container || !worktreeRoot) return;

    const term = new Terminal({
      fontFamily: TERMINAL_FONT_FAMILY,
      fontSize: 13,
      fontWeight: "500",
      fontWeightBold: "700",
      lineHeight: 1.35,
      letterSpacing: 0,
      theme: THEME,
      cursorBlink: true,
      cursorStyle: "block",
      scrollback: SCROLLBACK_LINES,
      allowProposedApi: true,
    });
    termRef.current = term;

    // xterm.js ships no clipboard or find-in-scrollback handling of its
    // own, and Ctrl+C is already the shell's interrupt signal — so it
    // can't also be a blanket "copy" shortcut the way it is in most GUI
    // apps. This matches convention instead: Ctrl+Shift+C/V (the
    // traditional Linux/Windows terminal-emulator bindings, since plain
    // Ctrl+V is `vim`'s visual-block-mode shortcut inside a shell and
    // would conflict), Cmd+C/Cmd+V on macOS where Cmd never collides with
    // Ctrl, and bare Ctrl+C still copies when there's a selection —
    // mirroring Windows Terminal/gnome-terminal's "copy if selected, else
    // interrupt" — falling through untouched (`return true`) to send
    // SIGINT otherwise. Ctrl/Cmd+F opens the search bar below instead of
    // reaching the shell.
    term.attachCustomKeyEventHandler((event) => {
      if (event.type !== "keydown") return true;
      const mac = isMac();
      const key = event.key.toLowerCase();

      if (key === "f") {
        const findChord = mac
          ? event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey
          : event.ctrlKey && !event.altKey && !event.metaKey && !event.shiftKey;
        if (findChord) {
          setSearchOpen(true);
          return false;
        }
      }

      if (key === "c") {
        const explicitCopy = mac
          ? event.metaKey && !event.ctrlKey && !event.altKey
          : event.ctrlKey && event.shiftKey && !event.altKey && !event.metaKey;
        const bareCtrlC =
          !mac && event.ctrlKey && !event.shiftKey && !event.altKey && !event.metaKey;
        if (explicitCopy || bareCtrlC) {
          const selection = term.getSelection();
          if (selection) {
            void navigator.clipboard.writeText(selection);
            return false;
          }
          // No selection: an explicit copy chord has nothing to copy and
          // no other meaning to xterm either, so just swallow it; bare
          // Ctrl+C falls through unchanged to send SIGINT as usual.
          return bareCtrlC;
        }
      }

      if (key === "v") {
        const pasteChord = mac
          ? event.metaKey && !event.ctrlKey && !event.altKey
          : event.ctrlKey && event.shiftKey && !event.altKey && !event.metaKey;
        if (pasteChord) {
          void navigator.clipboard.readText().then((text) => {
            if (text) void terminalApi.write(tab.id, text);
          });
          return false;
        }
      }

      return true;
    });

    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);

    const searchAddon = new SearchAddon();
    searchAddonRef.current = searchAddon;
    term.loadAddon(searchAddon);
    const onSearchResults = searchAddon.onDidChangeResults(({ resultIndex, resultCount }) => {
      setMatchInfo(resultCount > 0 ? { index: resultIndex, count: resultCount } : null);
    });

    // Opens in the user's OS browser via Tauri's opener plugin rather than
    // the default `window.open` — inside a Tauri webview that would try to
    // spawn another app window rather than a real browser tab.
    term.loadAddon(new WebLinksAddon((_event, uri) => void openUrl(uri)));

    const unicode11Addon = new Unicode11Addon();
    term.loadAddon(unicode11Addon);
    term.unicode.activeVersion = "11";

    term.loadAddon(new ClipboardAddon(undefined, clipboardProvider));

    term.open(container);
    fitAddon.fit();

    const existing = useTerminalSessionStore.getState().byTerminalId[tab.id];
    replayTerminalBuffer(tab.id, (bytes) => term.write(bytes));

    useTerminalSessionStore.getState().openTerminal(
      tab.id,
      (bytes) => term.write(bytes),
      (code) => {
        term.write(
          `\r\n\x1b[2m[process exited${code !== null ? ` with code ${code}` : ""}]\x1b[0m\r\n`,
        );
      },
    );

    if (!existing?.started) {
      useTerminalSessionStore.getState().markStarted(tab.id);
      terminalApi
        .spawn(tab.id, worktreeRoot, term.rows, term.cols)
        .then(() => {
          // Only on a genuinely new shell — a tab being re-mounted after a
          // pane switch has `started` set and must not re-run the command.
          if (!tab.initialCommand) return;
          return terminalApi.write(tab.id, `${tab.initialCommand}\n`);
        })
        .catch((err: unknown) => setSpawnError(String(err)));
    }

    const onData = term.onData((data) => {
      void terminalApi.write(tab.id, data);
    });

    // `fit()` forces a reflow and re-measures glyphs, and the PTY resize is
    // an IPC round-trip — so both are coalesced to one per animation frame
    // and the IPC call is skipped when the geometry didn't actually change.
    // Without this, dragging a sidebar resize handle fires both on every
    // single observer callback. A zero-size container means the tab is
    // hidden (`display: none`); fitting against that would compute
    // nonsense dimensions and resize the real shell to them.
    let frame: number | null = null;
    let lastRows = term.rows;
    let lastCols = term.cols;
    const refit = () => {
      frame = null;
      if (container.clientWidth === 0 || container.clientHeight === 0) return;
      fitAddon.fit();
      if (term.rows === lastRows && term.cols === lastCols) return;
      lastRows = term.rows;
      lastCols = term.cols;
      void terminalApi.resize(tab.id, term.rows, term.cols);
    };
    const scheduleRefit = () => {
      if (frame == null) frame = requestAnimationFrame(refit);
    };
    refitRef.current = scheduleRefit;

    const resizeObserver = new ResizeObserver(scheduleRefit);
    resizeObserver.observe(container);

    return () => {
      refitRef.current = null;
      if (frame != null) cancelAnimationFrame(frame);
      onData.dispose();
      onSearchResults.dispose();
      resizeObserver.disconnect();
      term.dispose();
      termRef.current = null;
      searchAddonRef.current = null;
      setSearchOpen(false);
      setSearchQuery("");
      setMatchInfo(null);
    };
    // `initialCommand` is fixed for a tab's lifetime, so it never actually
    // retriggers this — and the `started` guard above would stop a re-run
    // from spawning a second shell or replaying the command anyway.
  }, [tab.id, worktreeRoot, tab.initialCommand]);

  // Coming back from `display: none` restores a non-zero size, which the
  // ResizeObserver above does report — but the window may also have been
  // resized while this tab was hidden, in which case the observer already
  // fired (and was correctly ignored) at zero size. Refit explicitly so the
  // shell's geometry is right the moment the tab is visible again.
  useEffect(() => {
    if (active) refitRef.current?.();
  }, [active]);

  useEffect(() => {
    if (searchOpen) searchInputRef.current?.focus();
  }, [searchOpen]);

  const closeSearch = () => {
    searchAddonRef.current?.clearDecorations();
    setSearchOpen(false);
    setSearchQuery("");
    setMatchInfo(null);
    termRef.current?.focus();
  };

  const runSearch = (query: string, direction: "next" | "previous") => {
    const addon = searchAddonRef.current;
    if (!addon || !query) return;
    const options: ISearchOptions = { decorations: SEARCH_DECORATIONS };
    if (direction === "next") addon.findNext(query, options);
    else addon.findPrevious(query, options);
  };

  return (
    <div className={styles.tab}>
      <div className={styles.header}>
        <TerminalWindow size={15} color="var(--green)" />
        <span className={styles.title} title={tab.title}>
          {tab.title}
        </span>
        <span className={styles.dim}>·</span>
        <span className={styles.branch} title={activeWorktree?.branch ?? tab.title}>
          {activeWorktree?.branch ?? tab.title}
        </span>
        <span className={styles.path} title={tab.worktreeRoot}>
          {tab.worktreeRoot}
        </span>
      </div>
      {spawnError && (
        <div className={styles.errorBanner}>
          <WarningCircle size={14} />
          <span>Couldn't start a shell: {spawnError}</span>
        </div>
      )}
      <div className={styles.body}>
        <div className={styles.terminalMount} ref={containerRef} />
        {searchOpen && (
          <div className={styles.searchBar}>
            <MagnifyingGlass size={13} color="var(--text-mute)" />
            <input
              ref={searchInputRef}
              className={styles.searchInput}
              placeholder="Find in terminal"
              value={searchQuery}
              onChange={(event) => {
                const query = event.target.value;
                setSearchQuery(query);
                if (query) {
                  runSearch(query, "next");
                } else {
                  searchAddonRef.current?.clearDecorations();
                  setMatchInfo(null);
                }
              }}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  event.preventDefault();
                  closeSearch();
                } else if (event.key === "Enter") {
                  event.preventDefault();
                  runSearch(searchQuery, event.shiftKey ? "previous" : "next");
                }
              }}
            />
            <span className={styles.searchCount}>
              {matchInfo ? `${matchInfo.index + 1}/${matchInfo.count}` : searchQuery ? "0/0" : ""}
            </span>
            <button
              type="button"
              className={styles.searchButton}
              title="Previous match (Shift+Enter)"
              onClick={() => runSearch(searchQuery, "previous")}
            >
              <CaretUp size={13} />
            </button>
            <button
              type="button"
              className={styles.searchButton}
              title="Next match (Enter)"
              onClick={() => runSearch(searchQuery, "next")}
            >
              <CaretDown size={13} />
            </button>
            <button
              type="button"
              className={styles.searchButton}
              title="Close (Esc)"
              onClick={closeSearch}
            >
              <X size={13} />
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
