import { useDesignSystem } from "../../design/useDesignSystem";
import { TooltipProvider } from "../primitives";
import { SettingsModal } from "../settings/SettingsModal";
import { CommandPalette } from "../command-palette/CommandPalette";
import { Titlebar } from "./Titlebar";
import { WorkspaceSidebar } from "./WorkspaceSidebar";
import { ExplorerSidebar } from "./ExplorerSidebar";
import { ActivityRail } from "./ActivityRail";
import { MainContent } from "./MainContent";
import { StatusBar } from "./StatusBar";
import styles from "./AppShell.module.css";

export function AppShell() {
  useDesignSystem();

  return (
    <TooltipProvider>
      <div className={styles.shell}>
        <Titlebar />
        <div className={styles.body}>
          <WorkspaceSidebar />
          <MainContent />
          <ExplorerSidebar />
          <ActivityRail />
        </div>
        <StatusBar />
      </div>
      <SettingsModal />
      <CommandPalette />
    </TooltipProvider>
  );
}
