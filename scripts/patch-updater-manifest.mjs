#!/usr/bin/env node

import { writeFile } from "node:fs/promises";
import process from "node:process";

// Merges one platform's entry into a release's `latest.json` updater
// manifest and writes the result to ./latest.json for the caller to
// re-upload. Needed only for the Linux AppImage: `tauri-action` generates
// and merges `latest.json` entries for macOS/Windows automatically when
// `createUpdaterArtifacts` + signing env vars are set, but the AppImage is
// built and repaired manually (`release.yml`'s "Build compatible Linux
// AppImage" step, working around a Mesa/WebKitGTK bug) — tauri-action
// never sees that artifact, so nothing publishes its manifest entry unless
// this script does.
//
// Known limitation: the release workflow's platform jobs run in parallel
// with no ordering between them, and this does a plain read-modify-write
// of the shared `latest.json` release asset — a same-instant race with
// another job's own merge (tauri-action does the same read-modify-write
// for macOS/Windows) can drop an entry. Re-running this step (or the
// affected job) fixes it; there is no cross-job locking here.
const [repo, tag, platformKey, downloadUrl, signature] = process.argv.slice(2);
if (!repo || !tag || !platformKey || !downloadUrl || !signature) {
  throw new Error(
    "usage: node scripts/patch-updater-manifest.mjs <owner/repo> <tag> <platform-key> <download-url> <signature>",
  );
}

const manifestUrl = `https://github.com/${repo}/releases/download/${tag}/latest.json`;

let manifest;
const existing = await fetch(manifestUrl);
if (existing.ok) {
  manifest = await existing.json();
} else if (existing.status === 404) {
  // No other job has published a manifest for this release yet (or none
  // will) — start fresh with just this platform's entry.
  manifest = {
    version: tag.replace(/^v/, ""),
    notes: "",
    pub_date: new Date().toISOString(),
    platforms: {},
  };
} else {
  throw new Error(
    `failed to fetch existing manifest at ${manifestUrl}: ${existing.status} ${existing.statusText}`,
  );
}

manifest.platforms ??= {};
manifest.platforms[platformKey] = { signature, url: downloadUrl };

await writeFile("latest.json", `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`Patched latest.json: "${platformKey}" -> ${downloadUrl}`);
