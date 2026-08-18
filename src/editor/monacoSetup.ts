// Manual Monaco worker wiring via Vite's `?worker` import syntax — chosen
// over `@monaco-editor/react` (its loader is CDN-first by default, a CSP
// conflict under Tauri's `script-src 'self'`) and over a Vite-plugin
// dependency (this is a few dozen lines, full control over which workers
// ship). Bundles only the workers this app's own dev loop actually needs:
// editor (baseline). Language intelligence is provided by Maestro's LSP
// sessions; syntax grammars are registered separately without loading
// Monaco's duplicate JSON/CSS/TypeScript language-service workers.
import EditorWorker from "monaco-editor/editor/editor.worker?worker";

// `monaco-editor/editor/editor.api` (imported wherever this app touches
// `monaco`) only wires the bare editor surface — typing, selection, core
// commands. Every *feature* (Ctrl/Cmd+F find, folding, multi-cursor,
// rename, go-to-definition, the autocomplete/hover/parameter-hint popups
// that `lsp/providers.ts` registers providers for, etc.) lives in an
// opt-in "contrib" module that Monaco's own full bundle
// (`editor.main.js`) pulls in automatically but this app's slimmer entry
// point does not. Importing that full bundle isn't an option — it also
// drags in Monaco's *built-in* TypeScript/JSON/CSS/HTML language
// services, which would compete with `lsp/providers.ts`'s own providers
// and immediately break on the workers this app never configures for
// them (see the note above). So: the individual feature contributions,
// side-effect-imported directly, and nothing under `languages/*`.
import "monaco-editor/editor/contrib/find/browser/findController.js";
import "monaco-editor/editor/contrib/folding/browser/folding.js";
import "monaco-editor/editor/contrib/multicursor/browser/multicursor.js";
import "monaco-editor/editor/contrib/comment/browser/comment.js";
import "monaco-editor/editor/contrib/bracketMatching/browser/bracketMatching.js";
import "monaco-editor/editor/contrib/wordHighlighter/browser/wordHighlighter.js";
import "monaco-editor/editor/contrib/wordOperations/browser/wordOperations.js";
import "monaco-editor/editor/contrib/linesOperations/browser/linesOperations.js";
import "monaco-editor/editor/contrib/clipboard/browser/clipboard.js";
import "monaco-editor/editor/contrib/contextmenu/browser/contextmenu.js";
import "monaco-editor/editor/contrib/snippet/browser/snippetController2.js";
import "monaco-editor/editor/contrib/links/browser/links.js";
import "monaco-editor/editor/contrib/indentation/browser/indentation.js";
// The UI layer for `lsp/providers.ts`'s registered providers — without
// these, `registerHoverProvider`/`registerCompletionItemProvider`/etc.
// have nothing wired up to ever call them.
import "monaco-editor/editor/contrib/hover/browser/hoverContribution.js";
import "monaco-editor/editor/contrib/suggest/browser/suggestController.js";
import "monaco-editor/editor/contrib/parameterHints/browser/parameterHints.js";
import "monaco-editor/editor/contrib/gotoSymbol/browser/goToCommands.js";
import "monaco-editor/editor/contrib/gotoSymbol/browser/link/goToDefinitionAtPosition.js";
import "monaco-editor/editor/contrib/gotoError/browser/gotoError.js";
import "monaco-editor/editor/contrib/rename/browser/rename.js";
import "monaco-editor/editor/contrib/format/browser/formatActions.js";
import "monaco-editor/editor/contrib/codeAction/browser/codeActionContributions.js";
import "monaco-editor/editor/contrib/documentSymbols/browser/documentSymbols.js";
import "monaco-editor/editor/standalone/browser/quickAccess/standaloneGotoLineQuickAccess.js";
import "monaco-editor/editor/standalone/browser/quickAccess/standaloneGotoSymbolQuickAccess.js";
import "monaco-editor/editor/standalone/browser/quickAccess/standaloneCommandsQuickAccess.js";

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
