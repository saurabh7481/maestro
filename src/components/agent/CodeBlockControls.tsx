import { useEffect, useRef, useState } from "react";
import { Check, Copy, FlowArrow } from "@phosphor-icons/react";
import { renderMermaidToSvg } from "../../design/renderMermaid";
import { Tooltip } from "../primitives";
import styles from "./AgentMarkdown.module.css";

/** A plain, non-hook function rather than inline in the effect below: the
 * `<code>` element is raw DOM the markdown renderer produced, not
 * something React's compiler tracks as owned by this component (it's a
 * prop only in the sense of "here's a handle to it"), so mutating its
 * style needs to happen outside the component/hook body the
 * props-immutability check analyzes. */
function setRawCodeHidden(codeElement: HTMLElement, hidden: boolean): void {
  codeElement.style.display = hidden ? "none" : "";
}

/** One code block's hover-revealed toolbar, portaled into a `<div>`
 * appended to the raw `<pre>` markdown output produces (`AgentMarkdown.tsx`
 * owns the scan-and-mount side of this — see its effect). Every block gets
 * a copy button; a ```mermaid``` block additionally gets a diagram, shown
 * by default, with a toggle back to the raw source.
 *
 * `codeElement` is the raw, non-React `<code>` DOM node the markdown
 * renderer produced — toggling its visibility is direct DOM manipulation,
 * not a prop, because React never owned that node in the first place
 * (`dangerouslySetInnerHTML`). */
export function CodeBlockControls({
  codeElement,
  code,
  isMermaid,
}: {
  codeElement: HTMLElement;
  code: string;
  isMermaid: boolean;
}) {
  const [copied, setCopied] = useState(false);
  const [view, setView] = useState<"diagram" | "code">("diagram");
  const [svg, setSvg] = useState<string | null>(null);
  const [renderFailed, setRenderFailed] = useState(false);
  const copyTimeoutRef = useRef<number | null>(null);

  useEffect(() => {
    if (!isMermaid) return;
    let cancelled = false;
    renderMermaidToSvg(code)
      .then((result) => {
        if (!cancelled) setSvg(result);
      })
      .catch((error: unknown) => {
        // A syntax slip in model-generated mermaid is expected, not
        // exceptional — fall back to showing the raw fenced block exactly
        // as it rendered before this feature existed, just without a
        // toggle to a diagram that doesn't exist.
        console.error("Mermaid render failed, showing raw source:", error);
        if (!cancelled) setRenderFailed(true);
      });
    return () => {
      cancelled = true;
    };
    // `code` is a snapshot of `codeElement.textContent` taken once by the
    // scanning effect in `AgentMarkdown.tsx` — a *finished* (non-streaming)
    // message's code blocks don't change again, so re-rendering on `code`
    // identity is exactly "render once".
  }, [isMermaid, code]);

  const showingDiagram = isMermaid && view === "diagram" && svg !== null;
  useEffect(() => {
    setRawCodeHidden(codeElement, showingDiagram);
  }, [codeElement, showingDiagram]);

  useEffect(() => () => window.clearTimeout(copyTimeoutRef.current ?? undefined), []);

  async function copy() {
    await navigator.clipboard.writeText(code);
    setCopied(true);
    window.clearTimeout(copyTimeoutRef.current ?? undefined);
    copyTimeoutRef.current = window.setTimeout(() => setCopied(false), 1500);
  }

  return (
    <>
      <div className={styles.codeToolbar}>
        {isMermaid && svg && !renderFailed && (
          <Tooltip label={view === "diagram" ? "View source" : "View diagram"} side="left">
            <button
              type="button"
              className={styles.codeToolbarButton}
              onClick={() => setView(view === "diagram" ? "code" : "diagram")}
            >
              <FlowArrow size={12} />
              {view === "diagram" ? "Code" : "Diagram"}
            </button>
          </Tooltip>
        )}
        <Tooltip label={copied ? "Copied!" : "Copy code"} side="left">
          <button type="button" className={styles.codeToolbarButton} onClick={() => void copy()}>
            {copied ? <Check size={12} color="var(--green)" /> : <Copy size={12} />}
          </button>
        </Tooltip>
      </div>
      {showingDiagram && (
        <div className={styles.mermaidDiagram} dangerouslySetInnerHTML={{ __html: svg }} />
      )}
    </>
  );
}
