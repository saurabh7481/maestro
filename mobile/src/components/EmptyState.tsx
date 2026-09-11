import type { Icon } from "@phosphor-icons/react";

export function EmptyState({
  icon: Icon,
  title,
  detail,
}: {
  icon: Icon;
  title: string;
  detail?: string;
}) {
  return (
    <div className="empty-state">
      <Icon size={36} weight="duotone" className="empty-state-icon" />
      <div className="empty-state-title">{title}</div>
      {detail && <div className="empty-state-detail">{detail}</div>}
    </div>
  );
}

export function LoadingState() {
  return <div className="loading-state">Loading…</div>;
}

export function ErrorBanner({ message }: { message: string }) {
  return <div className="error-banner">{message}</div>;
}
