import { memo, useEffect, useMemo, useRef, useState } from "react";
import { Check, Copy } from "@phosphor-icons/react";
import { plainTextFallbackHtml, useMarkdownHtml } from "../../design/renderMarkdown";
import { Tooltip } from "../primitives";
import styles from "./AgentMarkdown.module.css";

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

  return (
    <div className={styles.wrap} data-streaming={streaming || undefined}>
      <div className={styles.body} dangerouslySetInnerHTML={{ __html: html }} />
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
