import { getCurrentWindow } from "@tauri-apps/api/window";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import {
  CaretDown,
  CaretRight,
  Check,
  FolderOpen,
  GitBranch,
  MagnifyingGlass,
  Minus,
  Square,
  X,
} from "@phosphor-icons/react";
import clsx from "clsx";
import { useUiStore } from "../../state/uiStore";
import {
  useActiveProject,
  useActiveWorktree,
  useWorkspaceStore,
  EMPTY_WORKTREES,
} from "../../state/workspaceStore";
import type { ThemeId } from "../../design/themes";
import { THEME_LABELS, themes } from "../../design/themes";
import { IconButton, Kbd, Tooltip } from "../primitives";
import styles from "./Titlebar.module.css";

const THEME_IDS = Object.keys(THEME_LABELS) as ThemeId[];

const THEME_SWATCH_GRADIENT: Record<ThemeId, string> = {
  maestro: "linear-gradient(135deg,#7c8cff,#c678dd)",
  darkplus: "linear-gradient(135deg,#1e1e1e,#569cd6)",
  onedark: "linear-gradient(135deg,#282c34,#61afef)",
  oled: "linear-gradient(135deg,#000000,#8f9dff)",
};

function ThemeSwatch({ id }: { id: ThemeId }) {
  return (
    <span
      className={styles.themeSwatch}
      style={{ background: THEME_SWATCH_GRADIENT[id] ?? themes[id]["--accent"] }}
    />
  );
}

function ThemePicker() {
  const theme = useUiStore((s) => s.theme);
  const setTheme = useUiStore((s) => s.setTheme);

  return (
    <DropdownMenu.Root>
      <Tooltip label="Theme">
        <DropdownMenu.Trigger asChild>
          <button type="button" aria-label="Change theme" className={styles.themeTrigger}>
            <ThemeSwatch id={theme} />
            <CaretDown size={11} color="var(--text-mute)" />
          </button>
        </DropdownMenu.Trigger>
      </Tooltip>
      <DropdownMenu.Portal>
        <DropdownMenu.Content className={`${styles.themeMenu} mo-glass`} align="end" sideOffset={6}>
          {THEME_IDS.map((id) => (
            <DropdownMenu.Item
              key={id}
              className={styles.themeMenuItem}
              data-active={theme === id}
              onSelect={() => setTheme(id)}
            >
              <ThemeSwatch id={id} />
              <span className={styles.themeMenuLabel}>{THEME_LABELS[id]}</span>
              {theme === id && <Check size={13} color="var(--accent)" />}
            </DropdownMenu.Item>
          ))}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

/** The project/worktree breadcrumb, made clickable: opens a dropdown of
 * every project and its worktrees (grouped, scrollable) so switching
 * context is a couple of clicks instead of hunting through the left
 * sidebar. Previously this was a plain decorative button with a caret
 * that implied it opened something but didn't. */
function WorktreeSwitcher() {
  const activeProject = useActiveProject();
  const activeWorktree = useActiveWorktree();
  const projects = useWorkspaceStore((s) => s.projects);
  const worktreesByProject = useWorkspaceStore((s) => s.worktreesByProject);
  const selectWorktree = useWorkspaceStore((s) => s.selectWorktree);

  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button type="button" className={styles.breadcrumb}>
          <span className={styles.rowIcon}>
            <FolderOpen size={15} color="var(--yellow)" />
          </span>
          <span className={styles.breadcrumbProject}>{activeProject?.name ?? "No project"}</span>
          {activeWorktree && (
            <>
              <span className={styles.rowIcon}>
                <CaretRight size={11} color="var(--text-mute)" />
              </span>
              <span className={styles.rowIcon}>
                <GitBranch size={14} color="var(--accent)" />
              </span>
              <span className={styles.breadcrumbBranch}>{activeWorktree.branch}</span>
            </>
          )}
          <span className={styles.rowIcon}>
            <CaretDown size={12} color="var(--text-mute)" />
          </span>
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          className={`${styles.switcherMenu} mo-glass`}
          align="start"
          sideOffset={6}
        >
          {projects.length === 0 && <div className={styles.switcherEmpty}>No projects yet</div>}
          {projects.map((project) => {
            const worktrees = worktreesByProject[project.id] ?? EMPTY_WORKTREES;
            return (
              <div key={project.id} className={styles.switcherGroup}>
                <div className={styles.switcherGroupLabel}>
                  <span className={styles.rowIcon}>
                    <FolderOpen size={12} color="var(--text-mute)" />
                  </span>
                  {project.name}
                </div>
                {worktrees.map((worktree) => (
                  <DropdownMenu.Item
                    key={worktree.id}
                    className={styles.switcherItem}
                    data-active={worktree.id === activeWorktree?.id}
                    onSelect={() => selectWorktree(project.id, worktree.id)}
                  >
                    <span className={styles.rowIcon}>
                      <GitBranch size={13} color="var(--text-mute)" />
                    </span>
                    <span className={styles.switcherItemLabel}>{worktree.branch}</span>
                    {worktree.id === activeWorktree?.id && (
                      <Check size={13} color="var(--accent)" />
                    )}
                  </DropdownMenu.Item>
                ))}
              </div>
            );
          })}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

export function Titlebar() {
  const setCommandPaletteOpen = useUiStore((s) => s.setCommandPaletteOpen);

  const appWindow = getCurrentWindow();

  return (
    <div className={styles.titlebar} data-tauri-drag-region>
      <div className={styles.brand}>
        <div className={clsx(styles.mark, "mo-gradient-mark", "mo-glow-accent")} />
        <span className={styles.brandName}>Maestro</span>
      </div>

      <div className={styles.divider} />

      <WorktreeSwitcher />

      <div className={styles.searchWrap}>
        <button type="button" className={styles.search} onClick={() => setCommandPaletteOpen(true)}>
          <MagnifyingGlass size={14} />
          <span className={styles.searchLabel}>Search files, symbols, commands…</span>
          <Kbd>⌘K</Kbd>
        </button>
      </div>

      <ThemePicker />

      <div className={styles.divider} />

      <div className={styles.windowControls}>
        <IconButton
          icon={Minus}
          label="Minimize"
          size="md"
          iconSize={14}
          onClick={() => void appWindow.minimize()}
        />
        <IconButton
          icon={Square}
          label="Maximize"
          size="md"
          iconSize={12}
          onClick={() => void appWindow.toggleMaximize()}
        />
        <IconButton
          icon={X}
          label="Close"
          size="md"
          iconSize={14}
          tone="danger"
          onClick={() => void appWindow.close()}
        />
      </div>
    </div>
  );
}
