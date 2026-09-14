import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { FileText, X } from "@phosphor-icons/react";
import { agentsApi } from "../../api/agents";
import type { ComposerAttachment } from "../../state/agentSessionStore";
import styles from "./ComposerAttachments.module.css";

/** Extensions the composer treats as previewable images. Kept in sync with
 * `attachments.rs::image_mime`, which is the one that actually decides —
 * this only picks which UI to render while the preview loads. */
const IMAGE_EXTENSIONS = ["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "avif"];

export function isImagePath(path: string): boolean {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  return IMAGE_EXTENSIONS.includes(ext);
}

export function attachmentName(relPath: string): string {
  return relPath.split("/").pop() || relPath;
}

/** Full-size view of one attached image, over everything.
 *
 * In a portal because the composer sits inside the agent tab's own
 * stacking and overflow context — an overlay rendered there would be
 * clipped by the transcript's scroll container rather than covering the
 * window. */
function Lightbox({ src, alt, onClose }: { src: string; alt: string; onClose: () => void }) {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  return createPortal(
    <div
      className={styles.lightbox}
      role="dialog"
      aria-modal="true"
      aria-label={alt}
      onClick={onClose}
    >
      {/* Clicking the image itself must not dismiss — only the backdrop
          around it does, which is what "click outside it" means. */}
      <img
        className={styles.lightboxImage}
        src={src}
        alt={alt}
        onClick={(event) => event.stopPropagation()}
      />
    </div>,
    document.body,
  );
}

function AttachmentCard({
  attachment,
  worktreeRoot,
  onRemove,
}: {
  attachment: ComposerAttachment;
  worktreeRoot: string;
  onRemove: () => void;
}) {
  const [preview, setPreview] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    if (!attachment.isImage || !worktreeRoot) return;
    let cancelled = false;
    void agentsApi
      .readAttachmentPreview(worktreeRoot, attachment.relPath)
      .then((dataUrl) => {
        if (!cancelled) setPreview(dataUrl);
      })
      // A preview that won't load falls back to the document card — the
      // file is staged and the agent can still read it either way.
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [attachment.isImage, attachment.relPath, worktreeRoot]);

  const showImage = attachment.isImage && preview;

  return (
    <div className={styles.card} data-image={showImage || undefined}>
      {showImage ? (
        <button
          type="button"
          className={styles.thumbButton}
          aria-label={`Expand ${attachment.name}`}
          onClick={() => setExpanded(true)}
        >
          <img className={styles.thumb} src={preview} alt={attachment.name} />
        </button>
      ) : (
        <div className={styles.document} title={attachment.relPath}>
          <FileText size={16} weight="regular" className={styles.documentIcon} />
          <span className={styles.documentName}>{attachment.name}</span>
        </div>
      )}

      <button
        type="button"
        className={styles.remove}
        aria-label={`Remove ${attachment.name}`}
        onClick={onRemove}
      >
        <X size={10} weight="bold" />
      </button>

      {expanded && preview && (
        <Lightbox src={preview} alt={attachment.name} onClose={() => setExpanded(false)} />
      )}
    </div>
  );
}

/** The row of staged attachments above the composer input.
 *
 * These used to be spliced into the draft as `@path` text, which put a
 * long generated path like `@.maestro/attachments/pasted-image-3.png` in
 * front of the user for something they had just pasted and could not
 * see. The path is still what the agent receives — appended to the
 * message on send — so this is a presentation change, not a second
 * attachment mechanism. */
export function ComposerAttachments({
  attachments,
  worktreeRoot,
  onRemove,
}: {
  attachments: ComposerAttachment[];
  worktreeRoot: string;
  onRemove: (relPath: string) => void;
}) {
  if (attachments.length === 0) return null;
  return (
    <div className={styles.strip}>
      {attachments.map((attachment) => (
        <AttachmentCard
          key={attachment.relPath}
          attachment={attachment}
          worktreeRoot={worktreeRoot}
          onRemove={() => onRemove(attachment.relPath)}
        />
      ))}
    </div>
  );
}
