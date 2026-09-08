function normalizedCode(code: string): string {
  return code.endsWith("\n") ? code.slice(0, -1) : code;
}

/** Code bodies whose closing fence has already arrived. Markdown renderers
 * happily produce a `<pre>` for an unfinished fence, so the DOM alone
 * cannot tell whether a streaming block is safe to expose as copyable. */
export function completedFencedCodeBodies(markdown: string): string[] {
  const completed: string[] = [];
  let open: { marker: "`" | "~"; length: number; lines: string[] } | null = null;

  for (const line of markdown.split("\n")) {
    if (!open) {
      const match = line.match(/^ {0,3}(`{3,}|~{3,})/);
      if (match) {
        open = {
          marker: match[1][0] as "`" | "~",
          length: match[1].length,
          lines: [],
        };
      }
      continue;
    }

    const close = line.match(/^ {0,3}(`+|~+)\s*$/);
    if (close && close[1][0] === open.marker && close[1].length >= open.length) {
      completed.push(normalizedCode(open.lines.join("\n")));
      open = null;
    } else {
      open.lines.push(line);
    }
  }

  return completed;
}

export function codeBlockLookupKey(code: string): string {
  return normalizedCode(code);
}
