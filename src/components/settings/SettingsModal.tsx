import { useState } from "react";
import {
  ArrowCounterClockwise,
  FloppyDisk,
  GearSix,
  GitBranch,
  Keyboard,
  MagnifyingGlassMinus,
  MagnifyingGlassPlus,
  Palette,
  Sliders,
  Sparkle,
  X,
} from "@phosphor-icons/react";
import type { Icon } from "@phosphor-icons/react";
import { useUiStore } from "../../state/uiStore";
import type { ThemeId } from "../../design/themes";
import { themes, THEME_LABELS } from "../../design/themes";
import { clampZoom, ZOOM_DEFAULT, ZOOM_STEP } from "../../design/zoom";
import { Modal, IconButton, Switch } from "../primitives";
import { HooksPane } from "./HooksPane";
import { AgentsPane } from "./AgentsPane";
import { KeybindingsPane } from "./KeybindingsPane";
import styles from "./SettingsModal.module.css";

type Section = "general" | "appearance" | "agents" | "hooks" | "keybindings";

const NAV: { id: Section; label: string; icon: Icon }[] = [
  { id: "general", label: "General", icon: Sliders },
  { id: "appearance", label: "Appearance", icon: Palette },
  { id: "agents", label: "Agents & CLI", icon: Sparkle },
  { id: "hooks", label: "Worktree Hooks", icon: GitBranch },
  { id: "keybindings", label: "Keybindings", icon: Keyboard },
];

function GeneralPane() {
  const autoSaveEnabled = useUiStore((s) => s.autoSaveEnabled);
  const setAutoSaveEnabled = useUiStore((s) => s.setAutoSaveEnabled);

  return (
    <div className={styles.group}>
      <span className={styles.groupLabel}>Editor</span>
      <div className={styles.presetRow}>
        <FloppyDisk size={18} color="var(--accent-2)" />
        <div className={styles.presetText}>
          <div className={styles.presetTitle}>Auto save</div>
          <div className={styles.presetDescription}>
            Automatically save changes shortly after you stop typing, like VS Code — no need to
            press Cmd/Ctrl+S.
          </div>
        </div>
        <Switch label="Auto save" checked={autoSaveEnabled} onCheckedChange={setAutoSaveEnabled} />
      </div>
    </div>
  );
}

function AppearancePane() {
  const theme = useUiStore((s) => s.theme);
  const setTheme = useUiStore((s) => s.setTheme);
  const zoom = useUiStore((s) => s.zoom);
  const setZoom = useUiStore((s) => s.setZoom);

  return (
    <>
      <div className={styles.group}>
        <span className={styles.groupLabel}>Theme</span>
        <div className={styles.themeGrid}>
          {(Object.keys(themes) as ThemeId[]).map((id) => (
            <button
              key={id}
              type="button"
              className={styles.themeCard}
              data-active={theme === id}
              onClick={() => setTheme(id)}
            >
              <div
                className={styles.themePreview}
                style={{
                  background: themes[id]["--bg"],
                  border: `1px solid ${themes[id]["--border-2"]}`,
                }}
              >
                <div
                  style={{
                    width: "40%",
                    height: "100%",
                    borderRadius: "var(--radius-md) 0 0 var(--radius-md)",
                    background: `linear-gradient(135deg, ${themes[id]["--accent"]}, ${themes[id]["--purple"]})`,
                  }}
                />
              </div>
              <span className={styles.themeName}>{THEME_LABELS[id]}</span>
            </button>
          ))}
        </div>
      </div>

      <div className={styles.group}>
        <span className={styles.groupLabel}>Zoom</span>
        <div className={styles.zoomRow}>
          <IconButton
            icon={MagnifyingGlassMinus}
            label="Zoom out"
            size="sm"
            onClick={() => setZoom(clampZoom(zoom - ZOOM_STEP))}
          />
          <span className={styles.zoomValue}>{Math.round(zoom * 100)}%</span>
          <IconButton
            icon={MagnifyingGlassPlus}
            label="Zoom in"
            size="sm"
            onClick={() => setZoom(clampZoom(zoom + ZOOM_STEP))}
          />
          <div style={{ flex: 1 }} />
          <IconButton
            icon={ArrowCounterClockwise}
            label="Reset zoom"
            size="sm"
            onClick={() => setZoom(ZOOM_DEFAULT)}
          />
        </div>
      </div>
    </>
  );
}

export function SettingsModal() {
  const open = useUiStore((s) => s.settingsOpen);
  const closeSettings = useUiStore((s) => s.closeSettings);
  const [section, setSection] = useState<Section>("appearance");

  const active = NAV.find((item) => item.id === section)!;

  return (
    <Modal
      open={open}
      onOpenChange={(next) => !next && closeSettings()}
      title="Settings"
      width="57.5rem"
      height="40rem"
    >
      <nav className={styles.nav}>
        <div className={styles.navTitle}>
          <GearSix size={17} color="var(--accent)" />
          Settings
        </div>
        {NAV.map((item) => {
          const ItemIcon = item.icon;
          return (
            <button
              key={item.id}
              type="button"
              className={styles.navItem}
              data-active={section === item.id}
              onClick={() => setSection(item.id)}
            >
              <ItemIcon size={16} color={section === item.id ? "var(--accent)" : undefined} />
              {item.label}
            </button>
          );
        })}
      </nav>

      <div className={styles.pane}>
        <div className={styles.paneHeader}>
          <div>
            <div className={styles.paneTitle}>{active.label}</div>
          </div>
          <div style={{ marginLeft: "auto" }}>
            <IconButton icon={X} label="Close" onClick={closeSettings} />
          </div>
        </div>
        <div className={styles.paneBody}>
          {section === "general" && <GeneralPane />}
          {section === "appearance" && <AppearancePane />}
          {section === "hooks" && <HooksPane scope={{ kind: "global" }} />}
          {section === "agents" && <AgentsPane />}
          {section === "keybindings" && <KeybindingsPane />}
        </div>
      </div>
    </Modal>
  );
}
