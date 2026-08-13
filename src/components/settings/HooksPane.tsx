import { useEffect, useRef, useState } from "react";
import { CheckCircle, Copy, Link, Package } from "@phosphor-icons/react";
import { workspaceApi } from "../../api/workspace";
import { useActiveProject } from "../../state/workspaceStore";
import type { HookConfig, Project } from "../../types/workspace";
import { Button, Switch, TextArea, TextInput } from "../primitives";
import styles from "./SettingsModal.module.css";

const VARIABLES = ["$NEW_WORKTREE", "$SOURCE_WORKTREE", "$BRANCH", "$PROJECT_ROOT"];

export function HooksPane() {
  const project = useActiveProject();
  if (!project) {
    return (
      <p className={styles.placeholder}>
        Add a project first — worktree hooks are configured per project.
      </p>
    );
  }
  // Keyed by project id: switching the active project fully remounts this,
  // so config state starts fresh without needing a reset-on-change effect.
  return <HooksPaneForProject key={project.id} project={project} />;
}

function HooksPaneForProject({ project }: { project: Project }) {
  const [config, setConfig] = useState<HookConfig | null>(null);
  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState(false);
  const scriptRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    void workspaceApi.getHookConfig(project.id).then(setConfig);
  }, [project.id]);

  if (!config) {
    return <p className={styles.placeholder}>Loading…</p>;
  }

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
      await workspaceApi.setHookConfig(project.id, config);
      setSaved(true);
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <div className={styles.group}>
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
          />
        </div>
      </div>

      <div className={styles.group}>
        <div className={styles.scriptHeader}>
          <span className={styles.groupLabel} style={{ flex: 1 }}>
            Custom post-create hook
          </span>
          <span className={styles.scriptBadge}>bash</span>
          <Switch
            label="Enable custom script"
            checked={config.customScriptEnabled}
            onCheckedChange={(v) => update({ customScriptEnabled: v })}
          />
        </div>
        <TextArea
          ref={scriptRef}
          rows={6}
          placeholder={'#!/usr/bin/env bash\ncd "$NEW_WORKTREE" && pnpm install'}
          value={config.customScript}
          onChange={(e) => update({ customScript: e.target.value })}
        />
        <div className={styles.chips}>
          <span className={styles.chipsLabel}>Variables:</span>
          {VARIABLES.map((v) => (
            <span key={v} className={styles.chip} onClick={() => insertVariable(v)}>
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
          Applies to <strong style={{ color: "var(--text-dim)" }}>{project.name}</strong>
        </span>
      </div>
    </>
  );
}
