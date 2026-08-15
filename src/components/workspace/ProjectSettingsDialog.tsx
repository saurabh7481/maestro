import { useState } from "react";
import { Code, GitBranch, X } from "@phosphor-icons/react";
import type { Icon } from "@phosphor-icons/react";
import type { Project } from "../../types/workspace";
import { Modal, IconButton } from "../primitives";
import { HooksPane } from "../settings/HooksPane";
import { LanguageIntelligencePane } from "../settings/LanguageIntelligencePane";
import styles from "../settings/SettingsModal.module.css";

type Section = "hooks" | "language";

// A single entry for now — `HooksPaneScope`'s `project` variant is the
// first project-level setting; more sections join this list the same way
// `SettingsModal.tsx`'s `NAV` grows, once there's a second one.
const NAV: { id: Section; label: string; icon: Icon }[] = [
  { id: "hooks", label: "Worktree Hooks", icon: GitBranch },
  { id: "language", label: "Language Intelligence", icon: Code },
];

export function ProjectSettingsDialog({
  project,
  open,
  onOpenChange,
}: {
  project: Project;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [section, setSection] = useState<Section>("hooks");
  const active = NAV.find((item) => item.id === section)!;

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title={`${project.name} settings`}
      width="57.5rem"
      height="34rem"
    >
      <nav className={styles.nav}>
        <div className={styles.navTitle}>{project.name}</div>
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
            <IconButton icon={X} label="Close" onClick={() => onOpenChange(false)} />
          </div>
        </div>
        <div className={styles.paneBody}>
          {section === "hooks" && (
            <HooksPane
              scope={{ kind: "project", projectId: project.id, projectName: project.name }}
            />
          )}
          {section === "language" && (
            <LanguageIntelligencePane
              scope={{ kind: "project", projectId: project.id, projectName: project.name }}
            />
          )}
        </div>
      </div>
    </Modal>
  );
}
