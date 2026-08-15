import React from "react";
import ReactDOM from "react-dom/client";
import { error as logError } from "@tauri-apps/plugin-log";
import "./styles/fonts";
import "./styles/global.css";
import App from "./App";

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
  void logError(`unhandled rejection: ${String(e.reason?.stack ?? e.reason)}`);
});

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
