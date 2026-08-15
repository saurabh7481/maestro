import { AppShell } from "./components/chrome/AppShell";
import { ErrorBoundary } from "./components/chrome/ErrorBoundary";

function App() {
  return (
    <ErrorBoundary>
      <AppShell />
    </ErrorBoundary>
  );
}

export default App;
