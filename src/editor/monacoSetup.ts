// Manual Monaco worker wiring via Vite's `?worker` import syntax — chosen
// over `@monaco-editor/react` (its loader is CDN-first by default, a CSP
// conflict under Tauri's `script-src 'self'`) and over a Vite-plugin
// dependency (this is a few dozen lines, full control over which workers
// ship). Bundles only the workers this app's own dev loop actually needs:
// editor (baseline). Language intelligence is provided by Maestro's LSP
// sessions; syntax grammars are registered separately without loading
// Monaco's duplicate JSON/CSS/TypeScript language-service workers.
import EditorWorker from "monaco-editor/editor/editor.worker?worker";

let configured = false;

export function ensureMonacoEnvironment() {
  if (configured) return;
  configured = true;

  self.MonacoEnvironment = {
    getWorker() {
      return new EditorWorker();
    },
  };
}
