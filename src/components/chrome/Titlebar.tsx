import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  CaretDown,
  CaretRight,
  FolderOpen,
  GitBranch,
  MagnifyingGlass,
  Minus,
  Square,
  X,
} from "@phosphor-icons/react";
import clsx from "clsx";
import { useUiStore } from "../../state/uiStore";
import type { ThemeId } from "../../design/themes";
import { THEME_LABELS } from "../../design/themes";
import { IconButton, Kbd, Tooltip } from "../primitives";
import styles from "./Titlebar.module.css";

const THEME_SWATCH_GRADIENT: Record<ThemeId, string> = {
  maestro: "linear-gradient(135deg,#7c8cff,#c678dd)",
  darkplus: "linear-gradient(135deg,#1e1e1e,#569cd6)",
  onedark: "linear-gradient(135deg,#282c34,#61afef)",
};

// Placeholder project/branch until Phase 2 wires the real workspace state.
const MOCK_PROJECT = "my-app";
const MOCK_BRANCH = "feat/payments-refactor";

export function Titlebar() {
  const theme = useUiStore((s) => s.theme);
  const setTheme = useUiStore((s) => s.setTheme);
  const setCommandPaletteOpen = useUiStore((s) => s.setCommandPaletteOpen);

  const appWindow = getCurrentWindow();

  return (
    <div className={styles.titlebar} data-tauri-drag-region>
      <div className={styles.brand}>
        <div className={clsx(styles.mark, "mo-gradient-mark", "mo-glow-accent")} />
        <span className={styles.brandName}>Maestro</span>
      </div>

      <div className={styles.divider} />

      <button type="button" className={styles.breadcrumb}>
        <FolderOpen size={15} color="var(--yellow)" />
        <span className={styles.breadcrumbProject}>{MOCK_PROJECT}</span>
        <CaretRight size={11} color="var(--text-mute)" />
        <GitBranch size={14} color="var(--accent)" />
        <span className={styles.breadcrumbBranch}>{MOCK_BRANCH}</span>
        <CaretDown size={12} color="var(--text-mute)" />
      </button>

      <div className={styles.searchWrap}>
        <button type="button" className={styles.search} onClick={() => setCommandPaletteOpen(true)}>
          <MagnifyingGlass size={14} />
          <span className={styles.searchLabel}>Search files, symbols, commands…</span>
          <Kbd>⌘K</Kbd>
        </button>
      </div>

      <div className={styles.themeSwatches}>
        {(Object.keys(THEME_SWATCH_GRADIENT) as ThemeId[]).map((id) => (
          <Tooltip key={id} label={THEME_LABELS[id]}>
            <button
              type="button"
              aria-label={THEME_LABELS[id]}
              data-active={theme === id}
              className={styles.swatch}
              style={{ background: THEME_SWATCH_GRADIENT[id] }}
              onClick={() => setTheme(id)}
            />
          </Tooltip>
        ))}
      </div>

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
