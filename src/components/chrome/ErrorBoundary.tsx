import { Component, type ErrorInfo, type ReactNode } from "react";
import { ArrowClockwise, WarningCircle } from "@phosphor-icons/react";
import { error as logError } from "@tauri-apps/plugin-log";
import { Button } from "../primitives";
import styles from "./ErrorBoundary.module.css";

interface ErrorBoundaryProps {
  children: ReactNode;
}

interface ErrorBoundaryState {
  error: Error | null;
}

/** Catches render-time exceptions anywhere in the tree below it. Without
 * this, an uncaught render exception unmounts the whole React app,
 * leaving nothing behind but `body`'s background color — see
 * `tokens.css`'s static `--bg` fallback for the other half of that fix.
 * `main.tsx`'s corner diagnostic overlay still exists as a net for errors
 * *outside* React (event handlers, promise rejections) — this is the net
 * for render-time crashes specifically, and gives a real, themed,
 * full-page fallback instead of a silent blank tree. */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error("Maestro crashed:", error, info.componentStack);
    // Local-only crash record (no remote telemetry) — lands in the same
    // on-disk log file as the Rust side's, via `tauri-plugin-log`.
    void logError(`Maestro crashed: ${error.stack ?? error.message}${info.componentStack ?? ""}`);
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;

    return (
      <div className={styles.overlay}>
        <div className={styles.card}>
          <WarningCircle size={32} color="var(--red)" />
          <div className={styles.title}>Something went wrong</div>
          <p className={styles.message}>{error.message}</p>
          {error.stack && <pre className={styles.stack}>{error.stack}</pre>}
          <Button variant="primary" onClick={() => window.location.reload()}>
            <ArrowClockwise size={15} />
            Reload
          </Button>
        </div>
      </div>
    );
  }
}
