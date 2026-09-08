interface PlanArtifact {
  title: string | null;
  overview: string | null;
  text: string | null;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/** Pulls presentation data out of the provider-specific plan tool input.
 * `plan` is shared by Claude and Cursor; the fallbacks keep the card useful
 * for older transcripts and future compatible providers. */
export function readPlanArtifact(input: unknown): PlanArtifact {
  if (typeof input === "string") {
    return { title: null, overview: null, text: nonEmptyString(input) };
  }
  if (!input || typeof input !== "object") {
    return { title: null, overview: null, text: null };
  }
  const record = input as Record<string, unknown>;
  let text: string | null = null;
  for (const key of ["plan", "text", "content", "message"]) {
    text = nonEmptyString(record[key]);
    if (text) break;
  }

  // Cursor normally includes complete Markdown, but the structured todos
  // remain a useful compatibility fallback if that duplicate field is
  // omitted by a future CLI build.
  if (!text && Array.isArray(record.todos)) {
    const todos = record.todos
      .map((todo) => {
        if (!todo || typeof todo !== "object") return null;
        const value = todo as Record<string, unknown>;
        const content = nonEmptyString(value.content);
        if (!content) return null;
        const status = nonEmptyString(value.status)?.toLocaleLowerCase() ?? "";
        return `- [${status.includes("completed") ? "x" : " "}] ${content}`;
      })
      .filter((todo): todo is string => !!todo);
    if (todos.length) text = todos.join("\n");
  }

  return {
    title: nonEmptyString(record.name) ?? nonEmptyString(record.title),
    overview: nonEmptyString(record.overview),
    text,
  };
}
