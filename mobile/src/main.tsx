import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { applyTheme } from "../../src/design/themes";
import "../../src/styles/fonts.css";
import "../../src/styles/tokens.css";
import "./styles/app.css";
import App from "./App";

// Always the desktop's default theme — no theme switcher in v1; this is
// the one-time root-level CSS custom property application `themes.ts`
// exports, with zero React/Tauri coupling (see `mobile/vite.config.ts`'s
// module doc).
applyTheme(document.documentElement, "maestro");

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
