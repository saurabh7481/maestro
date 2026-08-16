import { useEffect, useRef, useState } from "react";
import { TerminalWindow, WarningCircle } from "@phosphor-icons/react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { terminalApi } from "../../api/terminal";
import { replayTerminalBuffer, useTerminalSessionStore } from "../../state/terminalSessionStore";
import type { Tab } from "../../state/tabsStore";
import { useActiveWorktree } from "../../state/workspaceStore";
import styles from "./TerminalTab.module.css";

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
    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
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
      resizeObserver.disconnect();
      term.dispose();
    };
  }, [tab.id, worktreeRoot]);

  // Coming back from `display: none` restores a non-zero size, which the
  // ResizeObserver above does report — but the window may also have been
  // resized while this tab was hidden, in which case the observer already
  // fired (and was correctly ignored) at zero size. Refit explicitly so the
  // shell's geometry is right the moment the tab is visible again.
  useEffect(() => {
    if (active) refitRef.current?.();
  }, [active]);

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
      <div className={styles.body} ref={containerRef} />
    </div>
  );
}
