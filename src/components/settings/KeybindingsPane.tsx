import { useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import { ArrowCounterClockwise } from "@phosphor-icons/react";
import { KEYBINDING_ACTIONS, comboFromEvent, formatCombo } from "../../design/keymap";
import { useKeybindingsStore } from "../../state/keybindingsStore";
import { IconButton } from "../primitives";
import settingsStyles from "./SettingsModal.module.css";
import styles from "./KeybindingsPane.module.css";

const GROUP_ORDER = ["General", "Navigation", "Editor", "View"] as const;

export function KeybindingsPane() {
  const overrides = useKeybindingsStore((s) => s.overrides);
  const setBinding = useKeybindingsStore((s) => s.setBinding);
  const resetBinding = useKeybindingsStore((s) => s.resetBinding);
  const resetAll = useKeybindingsStore((s) => s.resetAll);
  const comboFor = useKeybindingsStore((s) => s.comboFor);
  const [recordingId, setRecordingId] = useState<string | null>(null);
  const [conflict, setConflict] = useState<{ actionId: string; withLabel: string } | null>(null);

  function startRecording(actionId: string) {
    setConflict(null);
    setRecordingId(actionId);
  }

  function onRecordKeyDown(actionId: string, event: ReactKeyboardEvent) {
    event.preventDefault();
    event.stopPropagation();
    if (event.key === "Escape") {
      setRecordingId(null);
      return;
    }
    const combo = comboFromEvent(event);
    if (!combo) return; // modifier-only keydown, keep listening

    const collidingAction = KEYBINDING_ACTIONS.find(
      (a) => a.id !== actionId && comboFor(a.id) === combo,
    );
    if (collidingAction) {
      setConflict({ actionId, withLabel: collidingAction.label });
      return;
    }

    setBinding(actionId, combo);
    setRecordingId(null);
    setConflict(null);
  }

  const hasAnyOverride = Object.keys(overrides).length > 0;

  return (
    <>
      <div className={styles.groupHeader}>
        <p className={settingsStyles.placeholder} style={{ margin: 0 }}>
          Click a shortcut, then press the new key combination. Escape cancels.
        </p>
        <IconButton
          icon={ArrowCounterClockwise}
          label="Reset all to defaults"
          size="sm"
          onClick={resetAll}
          disabled={!hasAnyOverride}
        />
      </div>

      {GROUP_ORDER.map((group) => {
        const actions = KEYBINDING_ACTIONS.filter((a) => a.group === group);
        if (actions.length === 0) return null;
        return (
          <div key={group} className={settingsStyles.group}>
            <span className={settingsStyles.groupLabel}>{group}</span>
            {actions.map((action) => {
              const combo = comboFor(action.id);
              const overridden = combo !== action.defaultCombo;
              const recording = recordingId === action.id;
              return (
                <div key={action.id} className={styles.row} data-recording={recording}>
                  <span className={styles.rowLabel}>{action.label}</span>
                  {conflict?.actionId === action.id && (
                    <span className={styles.conflict}>Already used by {conflict.withLabel}</span>
                  )}
                  <div className={styles.rowActions}>
                    <span className={styles.combo} data-overridden={overridden}>
                      {formatCombo(combo)}
                    </span>
                    <button
                      type="button"
                      className={styles.recordButton}
                      data-recording={recording}
                      onClick={() => startRecording(action.id)}
                      onKeyDown={recording ? (e) => onRecordKeyDown(action.id, e) : undefined}
                      onBlur={() => recording && setRecordingId(null)}
                    >
                      {recording ? "Press keys…" : "Rebind"}
                    </button>
                    {overridden && (
                      <IconButton
                        icon={ArrowCounterClockwise}
                        label={`Reset ${action.label} to default`}
                        size="sm"
                        onClick={() => resetBinding(action.id)}
                      />
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        );
      })}
    </>
  );
}
