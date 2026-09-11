import { useWorktreeFiles } from "../../state/worktreeFiles";
import { PickerSheet } from "./PickerSheet";

/** "Add context" — search the worktree's tracked files (the same
 * gitignore-respecting list the desktop's @-mention search uses) and
 * insert a mention for the one picked. Unlike the desktop's version there
 * is no "Browse files…" fallback to an OS file dialog: a file picked
 * there wouldn't exist on the machine actually running the agent CLI, so
 * that half of the feature has no meaningful mobile equivalent. */
export function AddContextSheet({
  worktreeId,
  onSelect,
  onClose,
}: {
  worktreeId: string;
  onSelect: (path: string) => void;
  onClose: () => void;
}) {
  const files = useWorktreeFiles(worktreeId);

  return (
    <PickerSheet
      title="Add context"
      items={files}
      getKey={(path) => path}
      getLabel={(path) => path}
      selectedKey={null}
      onSelect={onSelect}
      onClose={onClose}
      searchable
    />
  );
}
