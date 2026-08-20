import {
  ArrowCounterClockwise,
  ArrowsLeftRight,
  FloppyDisk,
  MagnifyingGlassMinus,
  MagnifyingGlassPlus,
  MapTrifold,
  PaintBucket,
  TextAlignLeft,
  UserFocus,
} from "@phosphor-icons/react";
import { useUiStore } from "../../state/uiStore";
import { CODE_FONT_OPTIONS } from "../../design/codeFonts";
import {
  EDITOR_BACKGROUND_DEFAULT,
  EDITOR_FONT_SIZE_DEFAULT,
  clampEditorFontSize,
} from "../../design/editorPrefs";
import { IconButton, Select, Switch } from "../primitives";
import styles from "./SettingsModal.module.css";

/** Settings → Editor — everything about how Monaco itself looks and
 * behaves, applied live to every open file/diff/merge editor (see
 * `editor/editorTheme.ts`, `MonacoHost.tsx`, `MonacoDiffHost.tsx`,
 * `MergeView.tsx`). Deliberately the home for anything editor-specific
 * (minimap, word wrap, font, …) rather than General — there is no more
 * "General" section because every one of these previously lived there
 * despite being purely about the editor. */
export function EditorPane() {
  const fontFamily = useUiStore((s) => s.editorFontFamily);
  const setFontFamily = useUiStore((s) => s.setEditorFontFamily);
  const fontSize = useUiStore((s) => s.editorFontSize);
  const setFontSize = useUiStore((s) => s.setEditorFontSize);
  const backgroundColor = useUiStore((s) => s.editorBackgroundColor);
  const setBackgroundColor = useUiStore((s) => s.setEditorBackgroundColor);

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
    <>
      <div className={styles.group}>
        <span className={styles.groupLabel}>Font</span>

        <div className={styles.presetRow}>
          <div className={styles.presetText}>
            <div className={styles.presetTitle}>Font family</div>
            <div className={styles.presetDescription}>
              All eight are bundled with Maestro, so any of them renders the same on Linux, macOS,
              and Windows.
            </div>
          </div>
          <Select
            aria-label="Editor font family"
            value={fontFamily}
            onChange={(e) => setFontFamily(e.target.value)}
            style={{ minWidth: "11rem" }}
          >
            {CODE_FONT_OPTIONS.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </Select>
        </div>

        <div className={styles.zoomRow}>
          <span style={{ flex: 1, fontSize: "var(--text-sm)" }}>Font size</span>
          <IconButton
            icon={MagnifyingGlassMinus}
            label="Decrease font size"
            size="sm"
            onClick={() => setFontSize(clampEditorFontSize(fontSize - 1))}
          />
          <span className={styles.zoomValue}>{fontSize}px</span>
          <IconButton
            icon={MagnifyingGlassPlus}
            label="Increase font size"
            size="sm"
            onClick={() => setFontSize(clampEditorFontSize(fontSize + 1))}
          />
          {fontSize !== EDITOR_FONT_SIZE_DEFAULT && (
            <IconButton
              icon={ArrowCounterClockwise}
              label="Reset font size"
              size="sm"
              onClick={() => setFontSize(EDITOR_FONT_SIZE_DEFAULT)}
            />
          )}
        </div>
      </div>

      <div className={styles.group}>
        <span className={styles.groupLabel}>Appearance</span>

        <div className={styles.presetRow}>
          <PaintBucket size={18} color="var(--accent-2)" />
          <div className={styles.presetText}>
            <div className={styles.presetTitle}>Background color</div>
            <div className={styles.presetDescription}>
              The editor canvas behind your code — everything else about the color scheme still
              comes from Settings → Appearance.
            </div>
          </div>
          <input
            type="color"
            aria-label="Editor background color"
            value={backgroundColor}
            onChange={(e) => setBackgroundColor(e.target.value)}
            style={{
              width: "2.25rem",
              height: "2.25rem",
              padding: 0,
              border: "var(--border-width) solid var(--border)",
              borderRadius: "var(--radius-md)",
              background: "transparent",
              cursor: "pointer",
            }}
          />
          {backgroundColor !== EDITOR_BACKGROUND_DEFAULT && (
            <IconButton
              icon={ArrowCounterClockwise}
              label="Reset background color"
              size="sm"
              onClick={() => setBackgroundColor(EDITOR_BACKGROUND_DEFAULT)}
            />
          )}
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
      </div>

      <div className={styles.group}>
        <span className={styles.groupLabel}>Behavior</span>

        <div className={styles.presetRow}>
          <FloppyDisk size={18} color="var(--accent-2)" />
          <div className={styles.presetText}>
            <div className={styles.presetTitle}>Auto save</div>
            <div className={styles.presetDescription}>
              Automatically save changes shortly after you stop typing, like VS Code — no need to
              press Cmd/Ctrl+S.
            </div>
          </div>
          <Switch
            label="Auto save"
            checked={autoSaveEnabled}
            onCheckedChange={setAutoSaveEnabled}
          />
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
      </div>
    </>
  );
}
