// Manual Monaco worker wiring via Vite's `?worker` import syntax — chosen
// over `@monaco-editor/react` (its loader is CDN-first by default, a CSP
// conflict under Tauri's `script-src 'self'`) and over a Vite-plugin
// dependency (this is a few dozen lines, full control over which workers
// ship). Bundles only the workers this app's own dev loop actually needs:
// editor (baseline), json, css, ts (covers TS/JS/JSON/CSS). Rust/Markdown
// get Monarch syntax highlighting only, no dedicated language service.
import EditorWorker from "monaco-editor/editor/editor.worker?worker";
import JsonWorker from "monaco-editor/language/json/json.worker?worker";
import CssWorker from "monaco-editor/language/css/css.worker?worker";
import TsWorker from "monaco-editor/language/typescript/ts.worker?worker";

let configured = false;

export function ensureMonacoEnvironment() {
  if (configured) return;
  configured = true;

  self.MonacoEnvironment = {
    getWorker(_workerId: string, label: string) {
      switch (label) {
        case "json":
          return new JsonWorker();
        case "css":
        case "scss":
        case "less":
          return new CssWorker();
        case "typescript":
        case "javascript":
          return new TsWorker();
        default:
          return new EditorWorker();
      }
    },
  };
}
