import { useEffect } from "react";
import { CheckCircle, Info, WarningCircle, X } from "@phosphor-icons/react";
import { useToastStore } from "../../state/toastStore";
import type { Toast, ToastTone } from "../../state/toastStore";
import styles from "./ToastHost.module.css";

const TONE_ICON: Record<ToastTone, typeof Info> = {
  info: Info,
  success: CheckCircle,
  error: WarningCircle,
};

const TONE_COLOR: Record<ToastTone, string> = {
  info: "var(--accent-2)",
  success: "var(--green)",
  error: "var(--red)",
};

function ToastItem({ toast }: { toast: Toast }) {
  const dismiss = useToastStore((s) => s.dismiss);
  const ToneIcon = TONE_ICON[toast.tone];

  useEffect(() => {
    const timer = window.setTimeout(() => dismiss(toast.id), toast.durationMs);
    return () => window.clearTimeout(timer);
  }, [toast.id, toast.durationMs, dismiss]);

  return (
    <div className={`${styles.toast} mo-glass`} data-tone={toast.tone}>
      <span className={styles.icon}>
        <ToneIcon size={16} color={TONE_COLOR[toast.tone]} weight="fill" />
      </span>
      <div className={styles.body}>
        <div className={styles.title}>{toast.title}</div>
        {toast.description && <div className={styles.description}>{toast.description}</div>}
      </div>
      <button
        type="button"
        className={styles.close}
        aria-label="Dismiss notification"
        onClick={() => dismiss(toast.id)}
      >
        <X size={12} />
      </button>
    </div>
  );
}

/** Renders active background-event notifications (hook finished, agent
 * finished while unfocused, push failed, ...) — see `state/toastStore.ts`
 * for the push sites. Mounted once at the app root, alongside the other
 * always-present overlays (`SettingsModal`, `CommandPalette`, ...). */
export function ToastHost() {
  const toasts = useToastStore((s) => s.toasts);
  if (toasts.length === 0) return null;

  return (
    <div className={styles.host}>
      {toasts.map((toast) => (
        <ToastItem key={toast.id} toast={toast} />
      ))}
    </div>
  );
}
