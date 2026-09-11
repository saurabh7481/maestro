import { useEffect, useRef } from "react";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { relayClient } from "../api/client";
import { openStream } from "../api/stream";
import { useAuthStore } from "../state/authStore";

// Mirrors the desktop's `TerminalTab.tsx` `THEME` constant for visual
// parity — xterm's `theme` option is a one-time constructor snapshot, not
// worth wiring to the shared theme module for a value that never changes
// at runtime here anyway.
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

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

const KEYS: { label: string; send: string }[] = [
  { label: "Esc", send: "\x1b" },
  { label: "Tab", send: "\t" },
  { label: "^C", send: "\x03" },
  { label: "^D", send: "\x04" },
  { label: "^Z", send: "\x1a" },
  { label: "^L", send: "\x0c" },
  { label: "←", send: "\x1b[D" },
  { label: "↑", send: "\x1b[A" },
  { label: "↓", send: "\x1b[B" },
  { label: "→", send: "\x1b[C" },
];

export function TerminalScreen({ terminalId }: { terminalId: string }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const canWrite = useAuthStore((s) => s.accessLevel === "write");

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const term = new Terminal({
      fontFamily: "var(--font-mono)",
      fontSize: 13,
      lineHeight: 1.35,
      theme: THEME,
      cursorBlink: true,
      scrollback: 5000,
      allowProposedApi: true,
      disableStdin: !canWrite,
    });
    termRef.current = term;
    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(container);
    fitAddon.fit();

    relayClient
      .getTerminalScrollback(terminalId)
      .then(({ text }) => term.write(text))
      .catch(() => {});

    const closeStream = openStream(
      `/api/terminals/${encodeURIComponent(terminalId)}/stream`,
      (raw) => {
        let event: { type: string; base64?: string; code?: number | null };
        try {
          event = JSON.parse(raw);
        } catch {
          return;
        }
        if (event.type === "data" && event.base64) {
          term.write(base64ToBytes(event.base64));
        } else if (event.type === "exit") {
          term.write(
            `\r\n\x1b[2m[process exited${event.code != null ? ` with code ${event.code}` : ""}]\x1b[0m\r\n`,
          );
        }
      },
    );

    const onData = term.onData((data) => {
      if (canWrite) void relayClient.writeTerminal(terminalId, data);
    });

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
      if (canWrite) void relayClient.resizeTerminal(terminalId, term.rows, term.cols);
    };
    const scheduleRefit = () => {
      if (frame == null) frame = requestAnimationFrame(refit);
    };
    const resizeObserver = new ResizeObserver(scheduleRefit);
    resizeObserver.observe(container);
    // Initial resize so the backend PTY matches this viewport rather than
    // whatever it was left at.
    if (canWrite) void relayClient.resizeTerminal(terminalId, term.rows, term.cols);

    return () => {
      if (frame != null) cancelAnimationFrame(frame);
      onData.dispose();
      resizeObserver.disconnect();
      closeStream();
      term.dispose();
      termRef.current = null;
    };
  }, [terminalId, canWrite]);

  function sendKey(bytes: string) {
    if (canWrite) void relayClient.writeTerminal(terminalId, bytes);
  }

  return (
    <div className="terminal-screen">
      <div className="terminal-viewport" ref={containerRef} />
      {canWrite && (
        <div className="terminal-keyrow">
          {KEYS.map((k) => (
            <button
              key={k.label}
              type="button"
              className="terminal-key"
              onClick={() => sendKey(k.send)}
            >
              {k.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
