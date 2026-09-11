import { useEffect } from "react";
import { Shell } from "./components/Shell";
import { PairScreen } from "./screens/PairScreen";
import { useAuthStore } from "./state/authStore";

const ACCESS_REFRESH_INTERVAL_MS = 15_000;

export default function App() {
  const status = useAuthStore((s) => s.status);
  const boot = useAuthStore((s) => s.boot);
  const refresh = useAuthStore((s) => s.refresh);

  useEffect(() => {
    void boot();
  }, [boot]);

  useEffect(() => {
    if (status !== "authenticated") return;
    const interval = setInterval(() => void refresh(), ACCESS_REFRESH_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [status, refresh]);

  if (status === "checking") {
    return <div className="loading-state">Loading…</div>;
  }

  if (status !== "authenticated") {
    return (
      <div className="app">
        <PairScreen />
      </div>
    );
  }

  return (
    <div className="app app-shell-root">
      <Shell />
    </div>
  );
}
