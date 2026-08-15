import DOMPurify from "dompurify";
import { marked } from "marked";

/** Shared markdown → sanitized HTML conversion, used anywhere Maestro
 * shows markdown-formatted text: file previews (`MarkdownPane.tsx`) and
 * agent transcript messages (`AgentTab.tsx`) — model output is always
 * markdown, so rendering it as raw text would show literal `**`/`` ` ``
 * characters instead of formatting.
 *
 * `marked.parse` can throw on pathological input (malformed tables,
 * degenerate nested emphasis, etc.) — since this runs synchronously
 * inside a render (`useMemo` in `MarkdownPane`), an uncaught throw here
 * takes the whole component tree down with it. Falling back to the
 * escaped raw text keeps a preview-toggle on a single "bad" file from
 * crashing the app. */
export function renderMarkdownToHtml(content: string): string {
  try {
    return DOMPurify.sanitize(marked.parse(content, { async: false, breaks: true }) as string);
  } catch (error) {
    console.error("Markdown render failed, falling back to plain text:", error);
    return DOMPurify.sanitize(`<pre>${escapeHtml(content)}</pre>`);
  }
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
