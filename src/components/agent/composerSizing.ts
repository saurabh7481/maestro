/** WebKitGTK does not implement textarea content sizing consistently.
 * Reset before measuring so the field can shrink again after text is
 * deleted, then hand scrolling over only once the configured cap is hit. */
export function resizeComposerTextarea(element: HTMLTextAreaElement): void {
  element.style.height = "auto";
  const maxHeight = Number.parseFloat(window.getComputedStyle(element).maxHeight);
  const nextHeight = Number.isFinite(maxHeight)
    ? Math.min(element.scrollHeight, maxHeight)
    : element.scrollHeight;
  element.style.height = `${nextHeight}px`;
  element.style.overflowY =
    Number.isFinite(maxHeight) && element.scrollHeight > maxHeight ? "auto" : "hidden";
}
