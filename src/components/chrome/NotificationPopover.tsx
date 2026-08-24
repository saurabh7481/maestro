import { useState } from "react";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { Bell, CheckCircle, Info, Trash, XCircle } from "@phosphor-icons/react";
import type { Icon } from "@phosphor-icons/react";
import { useNotificationHistoryStore } from "../../state/notificationHistoryStore";
import type { NotificationEntry } from "../../state/notificationHistoryStore";
import type { ToastTone } from "../../state/toastStore";
import { revealTab } from "../../state/tabNavigation";
import { relativeTime } from "../../design/relativeTime";
import { ICON_SIZE } from "../../design/iconSize";
import styles from "./NotificationPopover.module.css";

const TONE_ICON: Record<ToastTone, Icon> = {
  info: Info,
  success: CheckCircle,
  error: XCircle,
};

const TONE_COLOR: Record<ToastTone, string> = {
  info: "var(--accent-2)",
  success: "var(--green)",
  error: "var(--red)",
};

function NotificationRow({ entry, onClose }: { entry: NotificationEntry; onClose: () => void }) {
  const ToneIcon = TONE_ICON[entry.tone];
  return (
    <button
      type="button"
      className={styles.row}
      disabled={!entry.runId}
      onClick={() => {
        if (!entry.runId) return;
        revealTab(entry.runId);
        onClose();
      }}
    >
      <span className={styles.rowIcon} style={{ color: TONE_COLOR[entry.tone] }}>
        <ToneIcon size={ICON_SIZE.sm} weight="fill" />
      </span>
      <div className={styles.rowText}>
        <div className={styles.rowTitle}>{entry.title}</div>
        {entry.description && <div className={styles.rowMeta}>{entry.description}</div>}
      </div>
      <span className={styles.rowTime}>
        {relativeTime(new Date(entry.timestamp).toISOString())}
      </span>
    </button>
  );
}

/** The status-bar bell: what "agent finished/needs approval while you
 * weren't looking" turns into once its toast (`ToastHost.tsx`) has faded —
 * see `agentSessionStore.ts`'s `notifyIfBackgrounded`, the sole writer to
 * `notificationHistoryStore`. Same Radix-popover shape as
 * `ProcessPopover.tsx`/`BranchSwitcher.tsx`, the house style for a
 * status-bar icon that opens a small panel rather than a full tab. */
export function NotificationPopover() {
  const [open, setOpen] = useState(false);
  const entries = useNotificationHistoryStore((s) => s.entries);
  const unreadCount = useNotificationHistoryStore((s) => s.unreadCount);
  const markAllRead = useNotificationHistoryStore((s) => s.markAllRead);
  const clear = useNotificationHistoryStore((s) => s.clear);

  return (
    <DropdownMenu.Root
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) markAllRead();
      }}
    >
      <DropdownMenu.Trigger asChild>
        <button
          type="button"
          className={styles.trigger}
          data-active={open}
          aria-label={`Notifications${unreadCount > 0 ? ` — ${unreadCount} unread` : ""}`}
          title="Notifications"
        >
          <Bell size={13} />
          {unreadCount > 0 && <span className={styles.triggerCount}>{unreadCount}</span>}
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          className={`${styles.panel} mo-glass`}
          align="end"
          side="top"
          sideOffset={8}
        >
          <div className={styles.header}>
            <span className={styles.headerTitle}>Notifications</span>
            {entries.length > 0 && (
              <button
                type="button"
                className={styles.clearButton}
                aria-label="Clear all notifications"
                title="Clear all"
                onClick={() => clear()}
              >
                <Trash size={ICON_SIZE.sm} />
              </button>
            )}
          </div>

          {entries.length === 0 ? (
            <div className={styles.empty}>
              Nothing yet. Agent completions and approval requests show up here when you're not
              looking at that tab.
            </div>
          ) : (
            <div className={styles.list}>
              {entries.map((entry) => (
                <NotificationRow key={entry.id} entry={entry} onClose={() => setOpen(false)} />
              ))}
            </div>
          )}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
