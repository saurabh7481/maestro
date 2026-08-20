import { memo, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Check, Copy } from "@phosphor-icons/react";
import { plainTextFallbackHtml, useMarkdownHtml } from "../../design/renderMarkdown";
import { Tooltip } from "../primitives";
import { CodeBlockControls } from "./CodeBlockControls";
import styles from "./AgentMarkdown.module.css";

interface CodeBlockMount {
  key: string;
  element: HTMLDivElement;
  codeElement: HTMLElement;
  code: string;
  isMermaid: boolean;
}

/** Renders one assistant text block as real markdown — model output is
 * always markdown (headers, lists, inline/fenced code, bold), and showing
 * it as raw text left literal `**`/`` ` ``/`#` characters on screen
 * instead of formatting, which read as broken rather than just plain.
 *
 * Selectable (drag-to-select copies the visible text) and paired with a
 * hover-revealed copy button that copies the raw markdown `text` prop —
 * not the rendered HTML — so pasting elsewhere keeps `**bold**`/code
 * fences intact rather than pasting formatted-but-unstyled text.
 *
 * `memo`'d because the transcript re-renders on every streamed agent
 * event: without it, one token event reconciles every message block in
 * the whole conversation (docs/PERFORMANCE_AUDIT.md §1.3). `text` is the
 * only prop and transcript items are immutable, so the default shallow
 * comparison is exactly right. */
export const AgentMarkdown = memo(function AgentMarkdown({
  text,
  streaming = false,
}: {
  text: string;
  /** Still being typed out by the model. Adds a caret and holds back the
   * copy button — copying half a sentence is rarely what anyone wants,
   * and the button appearing mid-stream invites exactly that. */
  streaming?: boolean;
}) {
  const rendered = useMarkdownHtml(text);
  // `null` only while the markdown chunk loads on the session's first
  // message — show the same text unformatted rather than an empty block,
  // so the transcript doesn't collapse and reflow a frame later.
  const fallback = useMemo(() => plainTextFallbackHtml(text), [text]);
  const html = rendered ?? fallback;

  const [copied, setCopied] = useState(false);
  const timeoutRef = useRef<number | null>(null);

  useEffect(() => () => window.clearTimeout(timeoutRef.current ?? undefined), []);

  async function copy() {
    await navigator.clipboard.writeText(text);
    setCopied(true);
    window.clearTimeout(timeoutRef.current ?? undefined);
    timeoutRef.current = window.setTimeout(() => setCopied(false), 1500);
  }

  const bodyRef = useRef<HTMLDivElement>(null);
  const [codeBlocks, setCodeBlocks] = useState<CodeBlockMount[]>([]);

  // Finds every fenced code block in the just-rendered HTML and appends a
  // mount point `<div>` to its `<pre>` for `CodeBlockControls`' portal —
  // the raw markdown HTML has no React tree of its own to attach a copy
  // button or mermaid diagram to (`dangerouslySetInnerHTML`), so the mount
  // points are the bridge back into React for that one interactive piece.
  // Gated on `!streaming`: a still-growing ```mermaid``` fence is by
  // definition incomplete/invalid mid-stream, and re-scanning + re-parsing
  // it on every streamed token would be pure waste for a diagram that's
  // about to change again anyway — matches the whole-message copy button's
  // existing `!streaming` gate just below.
  useEffect(() => {
    const container = bodyRef.current;
    if (!container || streaming) {
      setCodeBlocks([]);
      return;
    }
    const blocks: CodeBlockMount[] = [];
    container.querySelectorAll("pre").forEach((pre, index) => {
      const codeElement = pre.querySelector(":scope > code");
      if (!(codeElement instanceof HTMLElement)) return;
      const mount = document.createElement("div");
      pre.appendChild(mount);
      blocks.push({
        key: `code-${index}`,
        element: mount,
        codeElement,
        code: codeElement.textContent ?? "",
        isMermaid: /(?:^|\s)language-mermaid(?:\s|$)/.test(codeElement.className),
      });
    });
    setCodeBlocks(blocks);
    // The mount `<div>`s above are destroyed the moment `html` changes
    // again (`dangerouslySetInnerHTML` replaces the whole subtree) — clear
    // so no portal tries to render into an already-detached node.
    return () => setCodeBlocks([]);
  }, [html, streaming]);

  return (
    <div className={styles.wrap} data-streaming={streaming || undefined}>
      <div className={styles.body} ref={bodyRef} dangerouslySetInnerHTML={{ __html: html }} />
      {codeBlocks.map((block) =>
        createPortal(
          <CodeBlockControls
            key={block.key}
            codeElement={block.codeElement}
            code={block.code}
            isMermaid={block.isMermaid}
          />,
          block.element,
        ),
      )}
      {!streaming && (
        <Tooltip label={copied ? "Copied!" : "Copy markdown"} side="left">
          <button type="button" className={styles.copyButton} onClick={() => void copy()}>
            {copied ? <Check size={13} color="var(--green)" /> : <Copy size={13} />}
          </button>
        </Tooltip>
      )}
    </div>
  );
});
