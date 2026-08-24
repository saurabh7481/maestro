import { useEffect, useState } from "react";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { Check, GitBranch, Plus, TrashSimple } from "@phosphor-icons/react";
import { useActiveWorktree, useWorkspaceStore } from "../../state/workspaceStore";
import { workspaceApi } from "../../api/workspace";
import { gitApi } from "../../api/git";
import { fuzzyMatch } from "../../design/fuzzy";
import { AlertDialog } from "../primitives";
import { ICON_SIZE } from "../../design/iconSize";
import styles from "./BranchSwitcher.module.css";

/** A status-bar branch switcher — checks out a different branch *within
 * the active worktree* (`git checkout`), distinct from `WorktreeSwitcher`
 * in `Titlebar.tsx`, which only changes which worktree the UI is looking
 * at. Branches load lazily on open (same "don't pay for it until asked"
 * stance `AttachFileButton` in `AgentComposer.tsx` takes for the worktree
 * file list). */
export function BranchSwitcher() {
  const activeWorktree = useActiveWorktree();
  const reloadWorktrees = useWorkspaceStore((s) => s.reloadWorktrees);
  const [open, setOpen] = useState(false);
  const [branches, setBranches] = useState<string[] | null>(null);
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);

  const projectId = activeWorktree?.projectId;

  useEffect(() => {
    if (!open || !projectId) return;
    let cancelled = false;
    void workspaceApi.listProjectBranches(projectId).then(
      (list) => {
        if (cancelled) return;
        setBranches(list);
        setError(null);
      },
      (err: unknown) => {
        if (!cancelled) setError(String(err));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [open, projectId]);

  if (!activeWorktree) return null;

  async function checkout(branch: string) {
    if (!activeWorktree || branch === activeWorktree.branch) {
      setOpen(false);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await gitApi.checkoutBranch(activeWorktree.id, activeWorktree.path, branch);
      await reloadWorktrees(activeWorktree.projectId);
      setOpen(false);
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  }

  async function createAndCheckout() {
    const name = newName.trim();
    if (!name || !activeWorktree) return;
    setBusy(true);
    setError(null);
    try {
      await gitApi.createBranch(activeWorktree.path, name, activeWorktree.branch);
      await gitApi.checkoutBranch(activeWorktree.id, activeWorktree.path, name);
      await reloadWorktrees(activeWorktree.projectId);
      setOpen(false);
      setCreating(false);
      setNewName("");
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  }

  async function confirmDelete() {
    const branch = pendingDelete;
    setPendingDelete(null);
    if (!branch || !activeWorktree) return;
    setBusy(true);
    setError(null);
    try {
      await gitApi.deleteBranch(activeWorktree.path, branch);
      setBranches((prev) => (prev ?? []).filter((b) => b !== branch));
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  }

  const filtered = (branches ?? []).filter((b) => fuzzyMatch(query, b));

  return (
    <>
      <DropdownMenu.Root
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          if (!next) {
            setQuery("");
            setCreating(false);
            setNewName("");
            setError(null);
          }
        }}
      >
        <DropdownMenu.Trigger asChild>
          <button type="button" className={styles.trigger} title="Switch branch">
            <GitBranch size={13} />
            {activeWorktree.branch}
          </button>
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content
            className={`${styles.panel} mo-glass`}
            align="start"
            side="top"
            sideOffset={8}
            onCloseAutoFocus={(e) => e.preventDefault()}
          >
            {creating ? (
              <div className={styles.createRow}>
                <input
                  autoFocus
                  className={styles.createInput}
                  placeholder={`New branch from ${activeWorktree.branch}…`}
                  value={newName}
                  disabled={busy}
                  onChange={(e) => setNewName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      void createAndCheckout();
                    } else if (e.key === "Escape") {
                      e.preventDefault();
                      setCreating(false);
                      setNewName("");
                    }
                  }}
                />
              </div>
            ) : (
              <input
                autoFocus
                className={styles.searchInput}
                placeholder="Switch branch…"
                value={query}
                disabled={busy}
                onChange={(e) => setQuery(e.target.value)}
              />
            )}
            <DropdownMenu.Item
              className={styles.item}
              disabled={busy}
              onSelect={(e) => {
                e.preventDefault();
                setCreating(true);
              }}
            >
              <Plus size={ICON_SIZE.sm} /> Create branch…
            </DropdownMenu.Item>
            <div className={styles.separator} />
            {error && <div className={styles.error}>{error}</div>}
            {branches === null ? (
              <div className={styles.empty}>Loading branches…</div>
            ) : filtered.length === 0 ? (
              <div className={styles.empty}>No matching branches</div>
            ) : (
              <div className={styles.list}>
                {filtered.map((branch) => {
                  const isCurrent = branch === activeWorktree.branch;
                  return (
                    <DropdownMenu.Item
                      key={branch}
                      className={styles.item}
                      disabled={busy}
                      // Stays open on select — a failed checkout (dirty
                      // working tree, branch checked out elsewhere) needs
                      // the dropdown alive to actually show `error`;
                      // `checkout` closes it itself on success.
                      onSelect={(e) => {
                        e.preventDefault();
                        void checkout(branch);
                      }}
                    >
                      <span className={styles.itemCheck}>
                        {isCurrent && <Check size={ICON_SIZE.sm} color="var(--accent)" />}
                      </span>
                      <span className={styles.itemLabel}>{branch}</span>
                      {!isCurrent && (
                        <button
                          type="button"
                          className={styles.deleteAction}
                          aria-label={`Delete branch ${branch}`}
                          title="Delete branch"
                          // Both handlers matter: Radix's own item-select
                          // triggers off pointerdown, not click, so only
                          // stopping the click's propagation still lets a
                          // click on this button select the whole row.
                          onPointerDown={(e) => e.stopPropagation()}
                          onClick={(e) => {
                            e.preventDefault();
                            e.stopPropagation();
                            setPendingDelete(branch);
                          }}
                        >
                          <TrashSimple size={ICON_SIZE.sm} />
                        </button>
                      )}
                    </DropdownMenu.Item>
                  );
                })}
              </div>
            )}
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>

      <AlertDialog
        open={pendingDelete !== null}
        onOpenChange={(next) => !next && setPendingDelete(null)}
        title={`Delete branch "${pendingDelete}"?`}
        description="This can't be undone. Git will refuse if the branch has unmerged commits or is checked out in another worktree."
        confirmLabel="Delete branch"
        destructive
        onConfirm={() => void confirmDelete()}
      />
    </>
  );
}
