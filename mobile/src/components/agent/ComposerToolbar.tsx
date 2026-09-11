import { useState } from "react";
import { At, CaretDown, Compass, Lightning, ShieldCheck, Sparkle } from "@phosphor-icons/react";
import { useAgentCapabilities, useAgentModels } from "../../state/agentCatalog";
import type { AgentConfig } from "../../state/agentConfigStore";
import type { AgentEffort, AgentKind, ModelOption, PermissionMode } from "../../api/types";
import { PickerSheet } from "./PickerSheet";

const EFFORT_LABEL: Record<AgentEffort, string> = {
  none: "None",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra high",
  max: "Max",
  ultra: "Ultra",
};

const PERMISSION_MODE_META: Record<PermissionMode, { label: string; icon: typeof ShieldCheck }> = {
  manual: { label: "Manual", icon: ShieldCheck },
  auto: { label: "Auto", icon: Sparkle },
  plan: { label: "Plan", icon: Compass },
};
const PERMISSION_MODE_ORDER: PermissionMode[] = ["manual", "auto", "plan"];

/** The model/effort/fast/permission-mode picker row (mirrors the desktop's
 * `AgentComposer.tsx` toolbar), plus a lightweight "Add context" that
 * inserts an `@` mention rather than the desktop's full file-browser —
 * the underlying CLI parses `@path` mentions from plain text either way,
 * so typing the rest is no different from what the desktop's own text
 * field expects once a mention starts.
 *
 * A controlled component on purpose: a brand-new session (`NewAgentSheet`)
 * has no `runId` yet to key a store entry by, so the config lives wherever
 * the caller keeps it — local `useState` there, the shared
 * `agentConfigStore` for an already-running session (`AgentScreen.tsx`). */
export function ComposerToolbar({
  kind,
  config,
  onSetModel,
  onSetEffort,
  onSetFast,
  onSetPermissionMode,
  onAddContext,
}: {
  kind: AgentKind;
  config: AgentConfig;
  onSetModel: (models: ModelOption[], modelId: string) => void;
  onSetEffort: (effort: AgentEffort) => void;
  onSetFast: (fast: boolean) => void;
  onSetPermissionMode: (mode: PermissionMode) => void;
  onAddContext: () => void;
}) {
  const models = useAgentModels(kind);
  const capabilities = useAgentCapabilities(kind);
  const [openSheet, setOpenSheet] = useState<"model" | "effort" | "permission" | null>(null);

  const selectedModel = models.find((m) => m.id === config.model) ?? null;
  const modelLabel = selectedModel?.label ?? "Default";
  const effortValues = selectedModel?.supportedEfforts ?? [];
  const effortValue = effortValues.includes(config.effort) ? config.effort : effortValues[0];
  const visibleModes = PERMISSION_MODE_ORDER.filter(
    (id) => id !== "manual" || capabilities.manualGate !== "externalConfig",
  );
  const modeMeta = PERMISSION_MODE_META[config.permissionMode];
  const ModeIcon = modeMeta.icon;

  return (
    <div className="composer-toolbar">
      <button type="button" className="toolbar-pill" onClick={onAddContext}>
        <At size={13} />
        Add context
      </button>

      {models.length > 0 && (
        <button type="button" className="toolbar-pill" onClick={() => setOpenSheet("model")}>
          <Sparkle size={13} />
          {modelLabel}
          <CaretDown size={10} />
        </button>
      )}

      {selectedModel && effortValues.length > 0 && (
        <button type="button" className="toolbar-pill" onClick={() => setOpenSheet("effort")}>
          <Lightning size={13} />
          {capabilities.effortLabel}: {EFFORT_LABEL[effortValue]}
          <CaretDown size={10} />
        </button>
      )}

      {selectedModel?.supportsFast && (
        <button
          type="button"
          className="toolbar-pill"
          data-active={config.fast || undefined}
          onClick={() => onSetFast(!config.fast)}
        >
          <Lightning size={13} />
          Fast
        </button>
      )}

      <button type="button" className="toolbar-pill" onClick={() => setOpenSheet("permission")}>
        <ModeIcon size={13} />
        {modeMeta.label}
        <CaretDown size={10} />
      </button>

      {openSheet === "model" && (
        <PickerSheet
          title="Model"
          items={models}
          getKey={(m) => m.id}
          getLabel={(m) => m.label}
          selectedKey={config.model}
          onSelect={(m) => onSetModel(models, m.id)}
          onClose={() => setOpenSheet(null)}
          searchable={models.length > 6}
        />
      )}
      {openSheet === "effort" && (
        <PickerSheet
          title={capabilities.effortLabel}
          items={effortValues}
          getKey={(e) => e}
          getLabel={(e) => EFFORT_LABEL[e]}
          selectedKey={effortValue ?? null}
          onSelect={(e) => onSetEffort(e)}
          onClose={() => setOpenSheet(null)}
        />
      )}
      {openSheet === "permission" && (
        <PickerSheet
          title="Permission mode"
          items={visibleModes}
          getKey={(m) => m}
          getLabel={(m) => PERMISSION_MODE_META[m].label}
          selectedKey={config.permissionMode}
          onSelect={(m) => onSetPermissionMode(m)}
          onClose={() => setOpenSheet(null)}
        />
      )}
    </div>
  );
}
