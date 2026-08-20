/** Lazy mermaid diagram rendering for `AgentMarkdown.tsx`'s fenced
 * ```mermaid``` code blocks — same "dynamic import, own chunk" discipline
 * as `renderMarkdown.ts`'s `marked`/`dompurify`, but even more deliberately
 * isolated: mermaid pulls in d3/dagre/cytoscape and is easily the heaviest
 * dependency in this file's neighborhood, so it must never load for a
 * message that doesn't actually contain a mermaid block, let alone the
 * app's first paint.
 *
 * Diagrams come from model output, which can itself be steered by
 * untrusted content the agent read (a malicious file, a scraped page) —
 * `securityLevel: "strict"` (mermaid's own HTML-in-label sanitization) plus
 * running the rendered SVG back through DOMPurify is belt-and-suspenders
 * against that, matching how every other rendering path in this app treats
 * model-influenced HTML as untrusted by default. */

let mermaidPromise: Promise<typeof import("mermaid").default> | null = null;

function loadMermaid() {
  mermaidPromise ??= import("mermaid").then(({ default: mermaid }) => {
    mermaid.initialize({ startOnLoad: false, theme: "dark", securityLevel: "strict" });
    return mermaid;
  });
  return mermaidPromise;
}

let diagramSeq = 0;

/** Renders mermaid source to a sanitized SVG string. Rejects on malformed
 * source (a syntax slip in model-generated mermaid is expected, not
 * exceptional) — callers decide the fallback themselves, same stance
 * `renderMarkdown.ts`'s `loadRenderer` takes for a bad markdown parse. */
export async function renderMermaidToSvg(source: string): Promise<string> {
  const [mermaid, { default: DOMPurify }] = await Promise.all([loadMermaid(), import("dompurify")]);
  diagramSeq += 1;
  const { svg } = await mermaid.render(`mo-mermaid-${diagramSeq}`, source);
  return DOMPurify.sanitize(svg, { USE_PROFILES: { svg: true, svgFilters: true } });
}
