/// <reference types="vitest/config" />
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

// https://vite.dev/config/
export default defineConfig(async () => ({
  plugins: [react()],
  // `vscode-jsonrpc` exposes its runtime initializer behind the `browser`
  // export condition. Keep the same implementation in production and
  // Vitest/jsdom so transport tests don't accidentally exercise Node streams.
  resolve: { conditions: ["browser"] },

  test: {
    environment: "jsdom",
    setupFiles: ["./src/test-setup.ts"],
    exclude: [
      "**/node_modules/**",
      "**/src-tauri/**",
      // Stale agent worktrees under `.claude/worktrees/` carry their own
      // node_modules; sweeping them in runs a different snapshot of the
      // tests against mismatched React instances and fails confusingly.
      "**/.claude/**",
    ],
  },

  build: {
    rollupOptions: {
      output: {
        // Splits the long-lived vendor code out of the app chunk. Without
        // this everything not behind a dynamic `import()` landed in one
        // ~1.2 MB entry chunk that the webview re-parsed from scratch on
        // every app update, even though React and Radix hadn't changed.
        // Monaco, xterm, and the markdown renderer are already separate by
        // virtue of being lazily imported (see `MainContent`, `TabHost`,
        // `design/renderMarkdown.ts`) and are deliberately not listed here
        // — naming them would pull them back into the eager graph.
        manualChunks: {
          react: ["react", "react-dom", "react-dom/client"],
          radix: [
            "@radix-ui/react-alert-dialog",
            "@radix-ui/react-context-menu",
            "@radix-ui/react-dialog",
            "@radix-ui/react-dropdown-menu",
            "@radix-ui/react-switch",
            "@radix-ui/react-tooltip",
          ],
        },
      },
    },
  },

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },
}));
