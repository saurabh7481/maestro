import type * as monacoNs from "monaco-editor/editor/editor.api";

/** Inherits Monaco's built-in "vs-dark" (its default `editor.background`,
 * `#1e1e1e`, is `design/editorPrefs.ts`'s `EDITOR_BACKGROUND_DEFAULT`) with
 * only the background overridden — a full custom theme wasn't asked for,
 * just a configurable background. `defineTheme`/`setTheme` are global
 * Monaco APIs (theming is a singleton across every standalone editor
 * instance in the page), so any one call site redefining this updates
 * every mounted editor — `MonacoHost` (file tabs), `MonacoDiffHost`, and
 * `MergeView` all call this on mount and whenever the color changes, so
 * whichever mounts first paints correctly and the other two pick it up
 * globally regardless of mount order. */
export const EDITOR_THEME_NAME = "maestro-editor";

export function applyEditorTheme(monaco: typeof monacoNs, backgroundColor: string): void {
  monaco.editor.defineTheme(EDITOR_THEME_NAME, {
    base: "vs-dark",
    inherit: true,
    rules: [],
    colors: { "editor.background": backgroundColor },
  });
  monaco.editor.setTheme(EDITOR_THEME_NAME);
}
