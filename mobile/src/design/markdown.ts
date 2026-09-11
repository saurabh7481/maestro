import DOMPurify from "dompurify";
import { marked } from "marked";

// Every markdown link opens in a real new tab rather than navigating the
// one page this whole app runs in away from itself — there's no back
// button to recover a session mid-transcript otherwise.
DOMPurify.addHook("afterSanitizeAttributes", (node) => {
  if (node.tagName === "A") {
    node.setAttribute("target", "_blank");
    node.setAttribute("rel", "noopener noreferrer");
  }
});

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Agent output is always markdown; rendering it as raw text would show
 * literal `**`/`` ` `` characters. `marked.parse` can throw on pathological
 * input, so a render failure falls back to escaped plain text rather than
 * crashing the transcript. */
export function renderMarkdown(content: string): string {
  try {
    return DOMPurify.sanitize(marked.parse(content, { async: false, breaks: true }) as string);
  } catch {
    return DOMPurify.sanitize(`<pre>${escapeHtml(content)}</pre>`);
  }
}
