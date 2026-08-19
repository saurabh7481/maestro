import { ArrowCounterClockwise, MagnifyingGlassMinus, MagnifyingGlassPlus } from "@phosphor-icons/react";
import { useUiStore } from "../../state/uiStore";
import { CODE_FONT_OPTIONS } from "../../design/codeFonts";
import {
  TERMINAL_CURSOR_STYLE_OPTIONS,
  TERMINAL_FONT_SIZE_DEFAULT,
  TERMINAL_LINE_HEIGHT_DEFAULT,
  TERMINAL_LINE_HEIGHT_STEP,
  TERMINAL_SCROLLBACK_DEFAULT,
  TERMINAL_SCROLLBACK_STEP,
  clampTerminalFontSize,
  clampTerminalLineHeight,
  clampTerminalScrollback,
  type TerminalCursorStyle,
} from "../../design/terminalPrefs";
import { IconButton, Select, Switch } from "../primitives";
import styles from "./SettingsModal.module.css";

/** A labeled row with a −/value/+ stepper, matching `AppearancePane`'s zoom
 * row so terminal font size/line height/scrollback read as the same kind of
 * control rather than a one-off. */
function StepperRow({
  label,
  value,
  displayValue,
  onChange,
  onReset,
  step,
  isDefault,
}: {
  label: string;
  value: number;
  displayValue: string;
  onChange: (next: number) => void;
  onReset: () => void;
  step: number;
  isDefault: boolean;
}) {
  return (
    <div className={styles.zoomRow}>
      <span style={{ flex: 1, fontSize: "var(--text-sm)" }}>{label}</span>
      <IconButton
        icon={MagnifyingGlassMinus}
        label={`Decrease ${label.toLowerCase()}`}
        size="sm"
        onClick={() => onChange(value - step)}
      />
      <span className={styles.zoomValue}>{displayValue}</span>
      <IconButton
        icon={MagnifyingGlassPlus}
        label={`Increase ${label.toLowerCase()}`}
        size="sm"
        onClick={() => onChange(value + step)}
      />
      {!isDefault && (
        <IconButton icon={ArrowCounterClockwise} label={`Reset ${label.toLowerCase()}`} size="sm" onClick={onReset} />
      )}
    </div>
  );
}

/** Settings → Terminal — font, cursor, and scrollback for every open
 * `TerminalTab`, applied live (see that component's settings-sync effect)
 * rather than only to terminals opened after the change. Persisted the
 * same way as every other `uiStore` preference (`design/persistence.ts`),
 * which is already cross-platform: `@tauri-apps/plugin-store` writes to
 * the OS app-config directory on Linux, macOS, and Windows alike, so
 * nothing here is platform-specific. */
export function TerminalPane() {
  const fontSize = useUiStore((s) => s.terminalFontSize);
  const setFontSize = useUiStore((s) => s.setTerminalFontSize);
  const fontFamily = useUiStore((s) => s.terminalFontFamily);
  const setFontFamily = useUiStore((s) => s.setTerminalFontFamily);
  const lineHeight = useUiStore((s) => s.terminalLineHeight);
  const setLineHeight = useUiStore((s) => s.setTerminalLineHeight);
  const cursorStyle = useUiStore((s) => s.terminalCursorStyle);
  const setCursorStyle = useUiStore((s) => s.setTerminalCursorStyle);
  const cursorBlink = useUiStore((s) => s.terminalCursorBlink);
  const setCursorBlink = useUiStore((s) => s.setTerminalCursorBlink);
  const scrollback = useUiStore((s) => s.terminalScrollback);
  const setScrollback = useUiStore((s) => s.setTerminalScrollback);

  return (
    <div className={styles.group}>
      <span className={styles.groupLabel}>Font</span>

      <div className={styles.presetRow}>
        <div className={styles.presetText}>
          <div className={styles.presetTitle}>Font family</div>
          <div className={styles.presetDescription}>
            "JetBrains Mono" is bundled with Maestro and always available; the others depend on
            what's installed on this machine and fall back to it automatically if missing.
          </div>
        </div>
        <Select
          aria-label="Terminal font family"
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

      <StepperRow
        label="Font size"
        value={fontSize}
        displayValue={`${fontSize}px`}
        step={1}
        isDefault={fontSize === TERMINAL_FONT_SIZE_DEFAULT}
        onChange={(next) => setFontSize(clampTerminalFontSize(next))}
        onReset={() => setFontSize(TERMINAL_FONT_SIZE_DEFAULT)}
      />

      <StepperRow
        label="Line height"
        value={lineHeight}
        displayValue={lineHeight.toFixed(2)}
        step={TERMINAL_LINE_HEIGHT_STEP}
        isDefault={lineHeight === TERMINAL_LINE_HEIGHT_DEFAULT}
        onChange={(next) => setLineHeight(clampTerminalLineHeight(next))}
        onReset={() => setLineHeight(TERMINAL_LINE_HEIGHT_DEFAULT)}
      />

      <span className={styles.groupLabel}>Cursor</span>

      <div className={styles.presetRow}>
        <div className={styles.presetText}>
          <div className={styles.presetTitle}>Cursor style</div>
          <div className={styles.presetDescription}>How the cursor renders in every terminal.</div>
        </div>
        <Select
          aria-label="Terminal cursor style"
          value={cursorStyle}
          onChange={(e) => setCursorStyle(e.target.value as TerminalCursorStyle)}
          style={{ minWidth: "9rem" }}
        >
          {TERMINAL_CURSOR_STYLE_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </Select>
      </div>

      <div className={styles.presetRow}>
        <div className={styles.presetText}>
          <div className={styles.presetTitle}>Cursor blink</div>
          <div className={styles.presetDescription}>Blink the cursor while it's idle.</div>
        </div>
        <Switch label="Cursor blink" checked={cursorBlink} onCheckedChange={setCursorBlink} />
      </div>

      <span className={styles.groupLabel}>History</span>

      <StepperRow
        label="Scrollback"
        value={scrollback}
        displayValue={`${scrollback.toLocaleString()} lines`}
        step={TERMINAL_SCROLLBACK_STEP}
        isDefault={scrollback === TERMINAL_SCROLLBACK_DEFAULT}
        onChange={(next) => setScrollback(clampTerminalScrollback(next))}
        onReset={() => setScrollback(TERMINAL_SCROLLBACK_DEFAULT)}
      />
    </div>
  );
}
