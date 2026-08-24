import { useEffect, useRef, useState } from "react";
import { CheckCircle, Copy, FolderOpen, Globe, Link, Package } from "@phosphor-icons/react";
import { workspaceApi } from "../../api/workspace";
import type { HookConfig, WorktreeSettings } from "../../types/workspace";
import { Button, Switch, TextArea, TextInput } from "../primitives";
import styles from "./SettingsModal.module.css";

const VARIABLES = ["$NEW_WORKTREE", "$SOURCE_WORKTREE", "$BRANCH", "$PROJECT_ROOT"];

export type WorktreesPaneScope =
  { kind: "global" } | { kind: "project"; projectId: string; projectName: string };

/** Everything that governs worktree creation, editable at two levels:
 * a global default (`kind: "global"`, Settings → Worktrees) applied to
 * every project, and a per-project override (`kind: "project"`, opened
 * from a project's right-click → Settings). Each section — location and
 * post-create hooks — has its own override switch, so a project can take
 * the global hooks but its own worktree directory (or vice versa).
 * Resolution lives backend-side: `commands/worktree_settings.rs` for the
 * location, `commands/hooks.rs::resolve_effective_hook_config` for hooks. */
export function WorktreesPane({ scope }: { scope: WorktreesPaneScope }) {
  // Keyed on the target (global vs a specific project) so switching
  // targets fully remounts this, resetting local config/saved/saving
  // state without needing a reset-on-change effect.
  const key = scope.kind === "global" ? "global" : `project:${scope.projectId}`;
  return <WorktreesPaneBody key={key} scope={scope} />;
}

function WorktreesPaneBody({ scope }: { scope: WorktreesPaneScope }) {
  const [settings, setSettings] = useState<WorktreeSettings | null>(null);
  const [hooks, setHooks] = useState<HookConfig | null>(null);
  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState(false);
  const scriptRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const loadSettings =
      scope.kind === "global"
        ? workspaceApi.getGlobalWorktreeSettings()
        : workspaceApi.getWorktreeSettings(scope.projectId);
    const loadHooks =
      scope.kind === "global"
        ? workspaceApi.getGlobalHookConfig()
        : workspaceApi.getHookConfig(scope.projectId);
    void Promise.all([loadSettings, loadHooks]).then(([s, h]) => {
      setSettings(s);
      setHooks(h);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!settings || !hooks) {
    return <p className={styles.placeholder}>Loading…</p>;
  }

  const projectScope = scope.kind === "project";
  // Project scope, override off: a section's fields describe settings
  // that don't currently apply (the global config governs instead), so
  // they're disabled rather than hidden — the user can see and stage
  // values before flipping the switch on.
  const locationDisabled = projectScope && !settings.overrideEnabled;
  const hooksDisabled = projectScope && !hooks.overrideEnabled;

  function updateSettings(patch: Partial<WorktreeSettings>) {
    setSettings((s) => (s ? { ...s, ...patch } : s));
    setSaved(false);
  }

  function updateHooks(patch: Partial<HookConfig>) {
    setHooks((c) => (c ? { ...c, ...patch } : c));
    setSaved(false);
  }

  function insertVariable(variable: string) {
    const textarea = scriptRef.current;
    if (!textarea || !hooks) return;
    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    const next = hooks.customScript.slice(0, start) + variable + hooks.customScript.slice(end);
    updateHooks({ customScript: next });
    requestAnimationFrame(() => {
      textarea.focus();
      textarea.setSelectionRange(start + variable.length, start + variable.length);
    });
  }

  async function handleSave() {
    if (!settings || !hooks) return;
    setSaving(true);
    try {
      if (scope.kind === "global") {
        await workspaceApi.setGlobalWorktreeSettings(settings);
        await workspaceApi.setGlobalHookConfig(hooks);
      } else {
        await workspaceApi.setWorktreeSettings(scope.projectId, settings);
        await workspaceApi.setHookConfig(scope.projectId, hooks);
      }
      setSaved(true);
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <div className={styles.group}>
        <span className={styles.groupLabel}>Worktree location</span>

        {projectScope && (
          <div className={styles.presetRow}>
            <FolderOpen size={18} color="var(--accent-2)" />
            <div className={styles.presetText}>
              <div className={styles.presetTitle}>Override global location</div>
              <div className={styles.presetDescription}>
                When off, <strong style={{ color: "var(--text-dim)" }}>{scope.projectName}</strong>{" "}
                uses the global worktree location. When on, the directory below is used for this
                project only.
              </div>
            </div>
            <Switch
              label="Override global location"
              checked={settings.overrideEnabled}
              onCheckedChange={(v) => updateSettings({ overrideEnabled: v })}
            />
          </div>
        )}

        <div style={locationDisabled ? { opacity: 0.5 } : undefined}>
          <TextInput
            label="Directory for new worktrees"
            placeholder="Automatic — a .worktrees folder next to the repo"
            value={settings.worktreeDir}
            onChange={(e) => updateSettings({ worktreeDir: e.target.value })}
            disabled={locationDisabled}
          />
          <p className={styles.presetDescription} style={{ marginTop: "var(--space-2)" }}>
            Each worktree is a subdirectory named after its branch. Absolute paths, <code>~/…</code>
            , or paths relative to the folder containing the repo all work.
          </p>
        </div>
      </div>

      <div className={styles.group}>
        <span className={styles.groupLabel}>Post-create hooks</span>

        {projectScope && (
          <div className={styles.presetRow}>
            <Globe size={18} color="var(--accent-2)" />
            <div className={styles.presetText}>
              <div className={styles.presetTitle}>Override global hooks</div>
              <div className={styles.presetDescription}>
                When off, <strong style={{ color: "var(--text-dim)" }}>{scope.projectName}</strong>{" "}
                uses the global worktree hooks. When on, the settings below replace the global
                config for this project only.
              </div>
            </div>
            <Switch
              label="Override global hooks"
              checked={hooks.overrideEnabled}
              onCheckedChange={(v) => updateHooks({ overrideEnabled: v })}
            />
          </div>
        )}

        <div style={hooksDisabled ? { opacity: 0.5 } : undefined}>
          <div className={styles.presetRow}>
            <Copy size={18} color="var(--accent-2)" />
            <div className={styles.presetText}>
              <div className={styles.presetTitle}>Copy .env files</div>
              <div className={styles.presetDescription}>Copies .env* from the source worktree</div>
            </div>
            <Switch
              label="Copy .env files"
              checked={hooks.copyEnvFiles}
              onCheckedChange={(v) => updateHooks({ copyEnvFiles: v })}
              disabled={hooksDisabled}
            />
          </div>

          <div className={styles.presetRow} style={{ alignItems: "flex-start" }}>
            <Package size={18} color="var(--orange)" style={{ marginTop: "0.125rem" }} />
            <div className={styles.presetText}>
              <div className={styles.presetTitle}>Run install command</div>
              {hooks.runInstallCommand && (
                <div className={styles.presetInline}>
                  <TextInput
                    value={hooks.installCommand ?? ""}
                    placeholder="pnpm install"
                    onChange={(e) => updateHooks({ installCommand: e.target.value })}
                    disabled={hooksDisabled}
                  />
                </div>
              )}
              {!hooks.runInstallCommand && (
                <div className={styles.presetDescription}>
                  Detected install command runs after creation
                </div>
              )}
            </div>
            <Switch
              label="Run install command"
              checked={hooks.runInstallCommand}
              onCheckedChange={(v) => updateHooks({ runInstallCommand: v })}
              disabled={hooksDisabled}
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
              checked={hooks.symlinkNodeModules}
              onCheckedChange={(v) => updateHooks({ symlinkNodeModules: v })}
              disabled={hooksDisabled}
            />
          </div>

          <div className={styles.scriptHeader}>
            <span className={styles.groupLabel} style={{ flex: 1 }}>
              Custom post-create hook
            </span>
            <span className={styles.scriptBadge}>bash</span>
            <Switch
              label="Enable custom script"
              checked={hooks.customScriptEnabled}
              onCheckedChange={(v) => updateHooks({ customScriptEnabled: v })}
              disabled={hooksDisabled}
            />
          </div>
          <TextArea
            ref={scriptRef}
            rows={6}
            placeholder={'#!/usr/bin/env bash\ncd "$NEW_WORKTREE" && pnpm install'}
            value={hooks.customScript}
            onChange={(e) => updateHooks({ customScript: e.target.value })}
            disabled={hooksDisabled}
          />
          <div className={styles.chips}>
            <span className={styles.chipsLabel}>Variables:</span>
            {VARIABLES.map((v) => (
              <span
                key={v}
                className={styles.chip}
                onClick={() => !hooksDisabled && insertVariable(v)}
              >
                {v}
              </span>
            ))}
          </div>
        </div>
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: "0.75rem" }}>
        <Button variant="primary" onClick={() => void handleSave()} disabled={saving}>
          {saving ? "Saving…" : "Save settings"}
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
