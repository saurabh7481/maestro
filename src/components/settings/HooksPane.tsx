import { useEffect, useRef, useState } from "react";
import { CheckCircle, Copy, Globe, Link, Package } from "@phosphor-icons/react";
import { workspaceApi } from "../../api/workspace";
import type { HookConfig } from "../../types/workspace";
import { Button, Switch, TextArea, TextInput } from "../primitives";
import styles from "./SettingsModal.module.css";

const VARIABLES = ["$NEW_WORKTREE", "$SOURCE_WORKTREE", "$BRANCH", "$PROJECT_ROOT"];

export type HooksPaneScope =
  { kind: "global" } | { kind: "project"; projectId: string; projectName: string };

/** Worktree-creation hooks, editable at two levels: a global default
 * (`kind: "global"`, Settings → Worktree Hooks) applied to every project,
 * and a per-project override (`kind: "project"`, opened from a project's
 * right-click → Settings) that — only once its own "Override global
 * settings" switch is on — replaces the global config for that project's
 * worktrees. See `commands/hooks.rs::resolve_effective_hook_config` for
 * where that resolution actually happens. */
export function HooksPane({ scope }: { scope: HooksPaneScope }) {
  // Keyed on the target (global vs a specific project) so switching
  // targets fully remounts this, resetting local config/saved/saving
  // state without needing a reset-on-change effect.
  const key = scope.kind === "global" ? "global" : `project:${scope.projectId}`;
  return <HooksPaneBody key={key} scope={scope} />;
}

function HooksPaneBody({ scope }: { scope: HooksPaneScope }) {
  const [config, setConfig] = useState<HookConfig | null>(null);
  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState(false);
  const scriptRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const load =
      scope.kind === "global"
        ? workspaceApi.getGlobalHookConfig()
        : workspaceApi.getHookConfig(scope.projectId);
    void load.then(setConfig);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!config) {
    return <p className={styles.placeholder}>Loading…</p>;
  }

  // Project scope, override off: the rest of the form describes settings
  // that don't currently apply (the global config governs instead), so
  // it's disabled rather than hidden — the user can see and stage values
  // before flipping the switch on.
  const fieldsDisabled = scope.kind === "project" && !config.overrideEnabled;

  function update(patch: Partial<HookConfig>) {
    setConfig((c) => (c ? { ...c, ...patch } : c));
    setSaved(false);
  }

  function insertVariable(variable: string) {
    const textarea = scriptRef.current;
    if (!textarea || !config) return;
    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    const next = config.customScript.slice(0, start) + variable + config.customScript.slice(end);
    update({ customScript: next });
    requestAnimationFrame(() => {
      textarea.focus();
      textarea.setSelectionRange(start + variable.length, start + variable.length);
    });
  }

  async function handleSave() {
    if (!config) return;
    setSaving(true);
    try {
      if (scope.kind === "global") {
        await workspaceApi.setGlobalHookConfig(config);
      } else {
        await workspaceApi.setHookConfig(scope.projectId, config);
      }
      setSaved(true);
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      {scope.kind === "project" && (
        <div className={styles.group}>
          <div className={styles.presetRow}>
            <Globe size={18} color="var(--accent-2)" />
            <div className={styles.presetText}>
              <div className={styles.presetTitle}>Override global settings</div>
              <div className={styles.presetDescription}>
                When off, <strong style={{ color: "var(--text-dim)" }}>{scope.projectName}</strong>{" "}
                uses the global worktree hooks. When on, the settings below replace the global
                config for this project only.
              </div>
            </div>
            <Switch
              label="Override global settings"
              checked={config.overrideEnabled}
              onCheckedChange={(v) => update({ overrideEnabled: v })}
            />
          </div>
        </div>
      )}

      <div className={styles.group} style={fieldsDisabled ? { opacity: 0.5 } : undefined}>
        <span className={styles.groupLabel}>Quick presets</span>

        <div className={styles.presetRow}>
          <Copy size={18} color="var(--accent-2)" />
          <div className={styles.presetText}>
            <div className={styles.presetTitle}>Copy .env files</div>
            <div className={styles.presetDescription}>Copies .env* from the source worktree</div>
          </div>
          <Switch
            label="Copy .env files"
            checked={config.copyEnvFiles}
            onCheckedChange={(v) => update({ copyEnvFiles: v })}
            disabled={fieldsDisabled}
          />
        </div>

        <div className={styles.presetRow} style={{ alignItems: "flex-start" }}>
          <Package size={18} color="var(--orange)" style={{ marginTop: "0.125rem" }} />
          <div className={styles.presetText}>
            <div className={styles.presetTitle}>Run install command</div>
            {config.runInstallCommand && (
              <div className={styles.presetInline}>
                <TextInput
                  value={config.installCommand ?? ""}
                  placeholder="pnpm install"
                  onChange={(e) => update({ installCommand: e.target.value })}
                  disabled={fieldsDisabled}
                />
              </div>
            )}
            {!config.runInstallCommand && (
              <div className={styles.presetDescription}>
                Detected install command runs after creation
              </div>
            )}
          </div>
          <Switch
            label="Run install command"
            checked={config.runInstallCommand}
            onCheckedChange={(v) => update({ runInstallCommand: v })}
            disabled={fieldsDisabled}
          />
        </div>

        <div className={styles.presetRow}>
          <Link size={18} color="var(--text-mute)" />
          <div className={styles.presetText}>
            <div className={styles.presetTitle}>Symlink node_modules</div>
            <div className={styles.presetDescription}>Share deps instead of reinstalling</div>
          </div>
          <Switch
            label="Symlink node_modules"
            checked={config.symlinkNodeModules}
            onCheckedChange={(v) => update({ symlinkNodeModules: v })}
            disabled={fieldsDisabled}
          />
        </div>
      </div>

      <div className={styles.group} style={fieldsDisabled ? { opacity: 0.5 } : undefined}>
        <div className={styles.scriptHeader}>
          <span className={styles.groupLabel} style={{ flex: 1 }}>
            Custom post-create hook
          </span>
          <span className={styles.scriptBadge}>bash</span>
          <Switch
            label="Enable custom script"
            checked={config.customScriptEnabled}
            onCheckedChange={(v) => update({ customScriptEnabled: v })}
            disabled={fieldsDisabled}
          />
        </div>
        <TextArea
          ref={scriptRef}
          rows={6}
          placeholder={'#!/usr/bin/env bash\ncd "$NEW_WORKTREE" && pnpm install'}
          value={config.customScript}
          onChange={(e) => update({ customScript: e.target.value })}
          disabled={fieldsDisabled}
        />
        <div className={styles.chips}>
          <span className={styles.chipsLabel}>Variables:</span>
          {VARIABLES.map((v) => (
            <span
              key={v}
              className={styles.chip}
              onClick={() => !fieldsDisabled && insertVariable(v)}
            >
              {v}
            </span>
          ))}
        </div>
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: "0.75rem" }}>
        <Button variant="primary" onClick={() => void handleSave()} disabled={saving}>
          {saving ? "Saving…" : "Save hooks"}
        </Button>
        {saved && (
          <span
            style={{
              display: "flex",
              alignItems: "center",
              gap: "0.375rem",
              color: "var(--green)",
              fontSize: "var(--text-sm)",
            }}
          >
            <CheckCircle size={14} weight="fill" />
            Saved
          </span>
        )}
        <span className={styles.footerNote} style={{ marginLeft: "auto" }}>
          {scope.kind === "global" ? (
            "Applies to every project without its own override"
          ) : (
            <>
              Applies to <strong style={{ color: "var(--text-dim)" }}>{scope.projectName}</strong>
            </>
          )}
        </span>
      </div>
    </>
  );
}
