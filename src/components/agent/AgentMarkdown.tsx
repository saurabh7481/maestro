import { useEffect, useMemo, useRef, useState } from "react";
import { Check, Copy } from "@phosphor-icons/react";
import { renderMarkdownToHtml } from "../../design/renderMarkdown";
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
 * fences intact rather than pasting formatted-but-unstyled text. */
export function AgentMarkdown({ text }: { text: string }) {
  const html = useMemo(() => renderMarkdownToHtml(text), [text]);
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
    <div className={styles.wrap}>
      <div className={styles.body} dangerouslySetInnerHTML={{ __html: html }} />
      <Tooltip label={copied ? "Copied!" : "Copy markdown"} side="left">
        <button type="button" className={styles.copyButton} onClick={() => void copy()}>
          {copied ? <Check size={13} color="var(--green)" /> : <Copy size={13} />}
        </button>
      </Tooltip>
    </div>
  );
}
