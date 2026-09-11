import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Standalone Vite project (see `src-tauri/src/relay/mod.rs`'s module doc)
// rather than a mode inside the desktop `src/` tree — keeps Monaco/xterm's
// desktop-chrome weight out of a page a phone has to download over
// cellular. It still reuses the desktop's design tokens directly from
// `../src/styles` and `../src/design/themes.ts` (confirmed framework-
// agnostic, zero React/Tauri coupling) rather than forking them.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 4173,
    // Needed because this project's root is `mobile/`, but it imports
    // `../src/styles/*` and `../src/design/themes.ts` from the sibling
    // desktop project — outside Vite's default same-root file-serving
    // allowlist.
    fs: {
      allow: [".."],
    },
  },
  build: {
    // Consumed by `relay/server.rs::mobile_dist_dir` (dev fallback path)
    // and bundled as a Tauri resource in release builds
    // (`src-tauri/tauri.conf.json`'s `bundle.resources`).
    outDir: "dist",
  },
});
