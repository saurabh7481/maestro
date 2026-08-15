import { useState } from "react";
import { AppShell } from "./components/chrome/AppShell";
import { SatelliteShell } from "./components/chrome/SatelliteShell";
import { ErrorBoundary } from "./components/chrome/ErrorBoundary";
import { isSatelliteWindow } from "./components/chrome/satelliteWindows";

/** Which shell this window gets is decided from the Tauri window label —
 * detached windows (docs/V2_ROADMAP.md Phase 13) run the same bundle as
 * the main window but render a reduced shell.
 *
 * Read once via a `useState` initializer rather than at module scope: a
 * window never changes roles mid-session, so it only needs reading once,
 * and anything touching a Tauri global during module evaluation runs
 * before React and before `main.tsx`'s error handlers — a throw there is
 * an unrecoverable blank window with nothing logged, rather than a caught
 * error. */
function App() {
  const [satellite] = useState(isSatelliteWindow);
  return <ErrorBoundary>{satellite ? <SatelliteShell /> : <AppShell />}</ErrorBoundary>;
}

export default App;
