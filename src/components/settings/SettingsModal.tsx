import { useState } from "react";
import {
  ArrowCounterClockwise,
  ArrowsLeftRight,
  FloppyDisk,
  GearSix,
  GitBranch,
  Keyboard,
  MagnifyingGlassMinus,
  MagnifyingGlassPlus,
  MapTrifold,
  Palette,
  Sliders,
  Sparkle,
  TextAlignLeft,
  UserFocus,
  Code,
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
import { LanguageIntelligencePane } from "./LanguageIntelligencePane";
import styles from "./SettingsModal.module.css";

type Section = "general" | "appearance" | "agents" | "language" | "hooks" | "keybindings";

const NAV: { id: Section; label: string; icon: Icon }[] = [
  { id: "general", label: "General", icon: Sliders },
  { id: "appearance", label: "Appearance", icon: Palette },
  { id: "agents", label: "Agents & CLI", icon: Sparkle },
  { id: "language", label: "Language Intelligence", icon: Code },
  { id: "hooks", label: "Worktree Hooks", icon: GitBranch },
  { id: "keybindings", label: "Keybindings", icon: Keyboard },
];

function GeneralPane() {
  const autoSaveEnabled = useUiStore((s) => s.autoSaveEnabled);
  const setAutoSaveEnabled = useUiStore((s) => s.setAutoSaveEnabled);
  const minimapEnabled = useUiStore((s) => s.minimapEnabled);
  const setMinimapEnabled = useUiStore((s) => s.setMinimapEnabled);
  const wordWrapEnabled = useUiStore((s) => s.wordWrapEnabled);
  const setWordWrapEnabled = useUiStore((s) => s.setWordWrapEnabled);
  const formatOnSaveEnabled = useUiStore((s) => s.formatOnSaveEnabled);
  const setFormatOnSaveEnabled = useUiStore((s) => s.setFormatOnSaveEnabled);
  const gitBlameEnabled = useUiStore((s) => s.gitBlameEnabled);
  const setGitBlameEnabled = useUiStore((s) => s.setGitBlameEnabled);

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
      <div className={styles.presetRow}>
        <TextAlignLeft size={18} color="var(--accent-2)" />
        <div className={styles.presetText}>
          <div className={styles.presetTitle}>Format on save</div>
          <div className={styles.presetDescription}>
            Reformat a file right before it's written to disk — the active language server's
            formatter if one's running, otherwise Prettier for the languages it supports (JS/TS,
            CSS/SCSS/LESS, JSON, HTML, Markdown, YAML). Off by default.
          </div>
        </div>
        <Switch
          label="Format on save"
          checked={formatOnSaveEnabled}
          onCheckedChange={setFormatOnSaveEnabled}
        />
      </div>
      <div className={styles.presetRow}>
        <ArrowsLeftRight size={18} color="var(--accent-2)" />
        <div className={styles.presetText}>
          <div className={styles.presetTitle}>Word wrap</div>
          <div className={styles.presetDescription}>
            Wrap long lines to the editor's width instead of scrolling horizontally. Always off
            for large files regardless of this setting.
          </div>
        </div>
        <Switch
          label="Word wrap"
          checked={wordWrapEnabled}
          onCheckedChange={setWordWrapEnabled}
        />
      </div>
      <div className={styles.presetRow}>
        <UserFocus size={18} color="var(--accent-2)" />
        <div className={styles.presetText}>
          <div className={styles.presetTitle}>Inline git blame</div>
          <div className={styles.presetDescription}>
            Show who last changed the cursor's current line, as dimmed text at the end of it.
          </div>
        </div>
        <Switch
          label="Inline git blame"
          checked={gitBlameEnabled}
          onCheckedChange={setGitBlameEnabled}
        />
      </div>
      <div className={styles.presetRow}>
        <MapTrifold size={18} color="var(--accent-2)" />
        <div className={styles.presetText}>
          <div className={styles.presetTitle}>Minimap</div>
          <div className={styles.presetDescription}>
            Show a zoomed-out map of the file alongside the editor. Off by default — its painting
            is disproportionately expensive on Linux/WebKitGTK.
          </div>
        </div>
        <Switch label="Minimap" checked={minimapEnabled} onCheckedChange={setMinimapEnabled} />
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
              aria-pressed={theme === id}
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
              aria-current={section === item.id ? "page" : undefined}
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
          {section === "language" && <LanguageIntelligencePane scope={{ kind: "global" }} />}
          {section === "keybindings" && <KeybindingsPane />}
        </div>
      </div>
    </Modal>
  );
}
