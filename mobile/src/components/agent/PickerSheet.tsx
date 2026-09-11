import { useState } from "react";
import { createPortal } from "react-dom";
import { Check } from "@phosphor-icons/react";

export function PickerSheet<T>({
  title,
  items,
  getKey,
  getLabel,
  selectedKey,
  onSelect,
  onClose,
  searchable = false,
}: {
  title: string;
  items: T[];
  getKey: (item: T) => string;
  getLabel: (item: T) => string;
  selectedKey: string | null;
  onSelect: (item: T) => void;
  onClose: () => void;
  searchable?: boolean;
}) {
  const [query, setQuery] = useState("");
  // Capped at 50 either way — a large worktree's file list otherwise
  // renders hundreds of plain (non-virtualized) rows for "Add context"'s
  // no-query state, same limit the desktop's own file-mention menu uses.
  const normalized = query.trim().toLowerCase();
  const filtered = (
    normalized ? items.filter((item) => getLabel(item).toLowerCase().includes(normalized)) : items
  ).slice(0, 50);

  // Portaled to `document.body` — this sheet is often opened from inside
  // another one (the composer toolbar's pickers, "Add context", both
  // live inside `NewAgentSheet`'s own overlay). Without a portal, a click
  // on this sheet's backdrop would bubble up through the DOM tree and
  // also trigger the *outer* sheet's own backdrop-click `onClose`,
  // dismissing both at once instead of just this one.
  return createPortal(
    <div className="sheet-overlay" onClick={onClose}>
      <div className="sheet" onClick={(e) => e.stopPropagation()}>
        <div className="sheet-handle" />
        <div className="sheet-title">{title}</div>
        {searchable && (
          <input
            className="text-input"
            placeholder="Search…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            autoFocus
          />
        )}
        <div className="picker-list">
          {filtered.map((item) => {
            const key = getKey(item);
            return (
              <button
                key={key}
                type="button"
                className="picker-list-item"
                data-selected={key === selectedKey || undefined}
                onClick={() => {
                  onSelect(item);
                  onClose();
                }}
              >
                {getLabel(item)}
                {key === selectedKey && <Check size={14} />}
              </button>
            );
          })}
          {filtered.length === 0 && <div className="sidebar-loading">No matches</div>}
        </div>
      </div>
    </div>,
    document.body,
  );
}
