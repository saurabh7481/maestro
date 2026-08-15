import React from "react";
import ReactDOM from "react-dom/client";
import { error as logError } from "@tauri-apps/plugin-log";
import { prefetchMarkdownRenderer } from "./design/renderMarkdown";
import "./styles/fonts.css";
import "./styles/global.css";

// The OS webview's native right-click menu (Back/Forward/Reload/Inspect
// Element in WebKitGTK) has no place in a desktop app UI — every
// intentional right-click affordance already renders its own menu via
// `@radix-ui/react-context-menu` (`ExplorerContextMenu`, `ScmContextMenu`,
// `TabContextMenu`), which calls `preventDefault()` on its own trigger
// already; this is the catch-all for everywhere else.
window.addEventListener("contextmenu", (e) => e.preventDefault());

// Render-time exceptions are caught and shown by `ErrorBoundary`; these
// two cover what it can't — errors from event handlers and rejected
// promises that never touch React's render cycle. Both just land in the
// same local, no-remote-telemetry log file as everything else
// (`tauri-plugin-log`'s `app.log_dir()`), rather than a visible overlay —
// most of these are benign (Monaco's internal cancellation-token
// rejections, in particular) and don't warrant interrupting the UI.
window.addEventListener("error", (e) => {
  void logError(`window error: ${e.message}\n${e.error?.stack ?? ""}`);
});
window.addEventListener("unhandledrejection", (e) => {
  const reason = e.reason as { name?: string; message?: string; stack?: string } | undefined;
  const stack = String(reason?.stack ?? reason ?? "");
  // Monaco's WebKit clipboard workaround deliberately rejects its previous
  // pending clipboard promise on every new click/key press. That is control
  // flow, not an application failure; logging it twice per interaction can
  // become its own performance problem in a desktop WebView.
  if (
    reason?.name === "CancellationError" ||
    reason?.name === "Canceled" ||
    stack.includes("BrowserClipboardService") ||
    (/cancel@/.test(stack) && stack.includes("node_modules/.vite/deps/"))
  ) {
    e.preventDefault();
    return;
  }
  void logError(`unhandled rejection: ${stack}`);
});

/** The app is imported *after* the handlers above are installed, and
 * dynamically, so it isn't hoisted back ahead of them.
 *
 * Static `import App from "./App"` is hoisted above every statement in
 * this file, which means anything the app's module graph does at
 * evaluation time — a top-level call into a Tauri global, a bad import —
 * throws before a single handler exists. The window goes blank and
 * nothing reaches the log file, which is the worst possible failure to
 * debug in a release build launched from a desktop entry. Loading it here
 * costs one microtask and turns that class of failure into a logged
 * error and a visible message. */
void import("./App")
  .then(({ default: App }) => {
    ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
      <React.StrictMode>
        <App />
      </React.StrictMode>,
    );
  })
  .catch((startupError: unknown) => {
    const detail = String(
      (startupError as { stack?: string })?.stack ?? startupError ?? "unknown error",
    );
    void logError(`failed to start: ${detail}`);
    const root = document.getElementById("root");
    if (root) {
      root.textContent = `Maestro failed to start — ${detail}`;
      root.setAttribute(
        "style",
        "padding:24px;font-family:monospace;white-space:pre-wrap;color:#e6e6e6;background:#0d1016;height:100%",
      );
    }
  });

// `marked`/`dompurify` are split out of the entry bundle (see
// `design/renderMarkdown.ts`) because nothing on the app shell's first
// paint needs them. Warming that chunk once the main thread goes idle
// keeps the split from costing anything the first time an agent replies
// or a markdown preview opens — by then it's already in memory.
const warmMarkdown = () => void prefetchMarkdownRenderer();
// `requestIdleCallback` is unavailable in WebKitGTK/WKWebView; the timeout
// fallback is the one that actually runs on macOS and Linux.
const idle = (window as Window & typeof globalThis).requestIdleCallback;
if (typeof idle === "function") {
  idle.call(window, warmMarkdown, { timeout: 3000 });
} else {
  window.setTimeout(warmMarkdown, 1500);
}
