import { useEffect, useMemo, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";

/** Shared markdown → sanitized HTML conversion, used anywhere Maestro
 * shows markdown-formatted text: file previews (`MarkdownPane.tsx`) and
 * agent transcript messages (`AgentMarkdown.tsx`) — model output is always
 * markdown, so rendering it as raw text would show literal `**`/`` ` ``
 * characters instead of formatting.
 *
 * `marked` + `dompurify` are ~70 KB minified between them and are needed
 * only once an agent tab or a markdown preview is actually on screen —
 * neither is reachable from the app shell's first paint. They're loaded
 * through a dynamic `import()` so they land in their own chunk instead of
 * the eager entry bundle (see docs/PERFORMANCE_AUDIT.md §1.4), with
 * `prefetchMarkdownRenderer()` warming that chunk during idle time so the
 * first agent message doesn't visibly wait on it. */

type RenderFn = (content: string) => string;

let renderer: RenderFn | null = null;
let loadPromise: Promise<RenderFn> | null = null;
const subscribers = new Set<() => void>();

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

async function loadRenderer(): Promise<RenderFn> {
  const [{ marked }, { default: DOMPurify }] = await Promise.all([
    import("marked"),
    import("dompurify"),
  ]);

  /* `marked.parse` can throw on pathological input (malformed tables,
   * degenerate nested emphasis, etc.) — since this runs synchronously
   * inside a render, an uncaught throw here takes the whole component
   * tree down with it. Falling back to the escaped raw text keeps a
   * preview-toggle on a single "bad" file from crashing the app. */
  return (content: string) => {
    try {
      return DOMPurify.sanitize(marked.parse(content, { async: false, breaks: true }) as string);
    } catch (error) {
      console.error("Markdown render failed, falling back to plain text:", error);
      return DOMPurify.sanitize(`<pre>${escapeHtml(content)}</pre>`);
    }
  };
}

/** Kicks off (or joins) the renderer chunk load. Idempotent. */
export function prefetchMarkdownRenderer(): Promise<RenderFn> {
  loadPromise ??= loadRenderer().then((fn) => {
    renderer = fn;
    for (const notify of subscribers) notify();
    return fn;
  });
  return loadPromise;
}

/** Synchronous render once the chunk is in memory, `null` before that.
 * Callers that can't re-render (non-React code) should `await
 * prefetchMarkdownRenderer()` first. */
export function renderMarkdownToHtml(content: string): string | null {
  if (!renderer) {
    void prefetchMarkdownRenderer();
    return null;
  }
  return renderer(content);
}

/** Renders `content` to sanitized HTML, re-rendering the calling component
 * once the renderer chunk resolves. Returns `null` only on the very first
 * markdown in a session, for the duration of one local chunk load —
 * callers fall back to escaped plain text so nothing flashes empty. */
export function useMarkdownHtml(content: string | null | undefined): string | null {
  const [, forceRerender] = useState(0);
  const ready = renderer !== null;

  useEffect(() => {
    if (ready) return;
    const notify = () => forceRerender((n) => n + 1);
    subscribers.add(notify);
    void prefetchMarkdownRenderer();
    return () => {
      subscribers.delete(notify);
    };
  }, [ready]);

  // Parsing + sanitizing is the expensive part and runs during render, so
  // it stays memoized per text. `ready` is a dependency so the very first
  // markdown in a session re-parses exactly once, when the chunk lands.
  return useMemo(() => {
    if (content == null) return "";
    // `ready` is read here rather than only in the dependency list so this
    // re-parses exactly once, on the render after the chunk lands.
    if (!ready || !renderer) return null;
    return renderer(content);
  }, [content, ready]);
}

/** The escaped-plain-text stand-in shown while the renderer chunk loads —
 * same text, unformatted, so the layout doesn't collapse to zero height
 * and then reflow. */
export function plainTextFallbackHtml(content: string): string {
  return `<p>${escapeHtml(content).replace(/\n/g, "<br>")}</p>`;
}

/** Installed once, globally, by `main.tsx` — not per-component — the same
 * "catch-all for everywhere else" shape as that file's `contextmenu`
 * interceptor. A markdown link is a plain `<a href>` inside
 * `dangerouslySetInnerHTML` HTML (`AgentMarkdown.tsx`, `MarkdownPane.tsx`
 * today, and this app has no router and no other `<a>` source at all — see
 * that file's comment), with no click handling of its own, so without this
 * a click follows it exactly like a normal web page would. A Tauri webview
 * has no separate browser tab to open a new one in, so that navigates the
 * app's own window away to the target URL — replacing the entire UI, with
 * no back button to recover it (live-reported: an agent's response linked
 * out and the click "replaced the app with that link"). Opens through the
 * OS's real browser instead, via the same `plugin-opener` every other
 * external link in this app already uses. */
export function interceptMarkdownLinkClicks(event: MouseEvent): void {
  if (!(event.target instanceof HTMLElement)) return;
  const anchor = event.target.closest("a");
  const href = anchor?.getAttribute("href");
  if (!href) return;
  event.preventDefault();
  void openUrl(href);
}
