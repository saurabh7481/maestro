#!/usr/bin/env node

import {
  access,
  lstat,
  readFile,
  readdir,
  realpath,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const requestedAppDir = process.argv[2];

if (!requestedAppDir) {
  throw new Error("usage: node scripts/fix-appimage.mjs <path-to-AppDir>");
}

const appDir = await realpath(path.resolve(requestedAppDir));
if (!path.basename(appDir).endsWith(".AppDir")) {
  throw new Error(`refusing to modify a non-AppDir path: ${appDir}`);
}

// linuxdeploy-plugin-gtk still forces every AppImage through XWayland. On
// current Mesa/WebKitGTK that can make the web process abort during EGL
// initialization and leave only an empty GTK surface. Prefer native Wayland
// in a Wayland session while retaining X11 elsewhere. MAESTRO_GDK_BACKEND is
// an escape hatch for unusual environments.
const hookPath = path.join(appDir, "apprun-hooks", "linuxdeploy-plugin-gtk.sh");
const forcedBackend =
  "export GDK_BACKEND=x11 # Crash with Wayland backend on Wayland - We tested it without it and ended up with this: https://github.com/tauri-apps/tauri/issues/8541";
const backendSelection = `# Maestro: use the display server selected by the desktop session.
if [ -n "\${WAYLAND_DISPLAY:-}" ]; then
  export GDK_BACKEND="\${MAESTRO_GDK_BACKEND:-wayland}"
else
  export GDK_BACKEND="\${MAESTRO_GDK_BACKEND:-x11}"
fi`;

const hook = await readFile(hookPath, "utf8");
if (hook.includes(forcedBackend)) {
  await writeFile(hookPath, hook.replace(forcedBackend, backendSelection));
} else if (!hook.includes("# Maestro: use the display server selected by the desktop session.")) {
  throw new Error(`the linuxdeploy GTK hook changed unexpectedly: ${hookPath}`);
}

// Tauri's current AppImage path also bundles an older libwayland beside the
// host's Mesa driver. Mixing those versions produces EGL_BAD_PARAMETER on
// rolling/new distributions. AppImages already require the host's GTK and
// WebKitGTK runtime, so using its matching Wayland client libraries is the
// compatible choice. See tauri-apps/tauri#15665.
const libDir = path.join(appDir, "usr", "lib");
const bundledWaylandLibrary = /^libwayland-(?:client|cursor|egl|server)\.so(?:\.|$)/;
const removedLibraries = [];

for (const entry of await readdir(libDir, { withFileTypes: true })) {
  if (bundledWaylandLibrary.test(entry.name)) {
    await unlink(path.join(libDir, entry.name));
    removedLibraries.push(entry.name);
  }
}

if (removedLibraries.length === 0) {
  throw new Error(`no bundled Wayland libraries found in ${libDir}`);
}

// AppImageLauncher follows the lowercase root icon link. Tauri currently
// points it at the 32 px icon even though .DirIcon is 256 px, which produces a
// blurry or apparently missing launcher icon after integration.
const launcherIcon = path.join(appDir, "maestro.png");
const launcherIconTarget = "usr/share/icons/hicolor/256x256/apps/maestro.png";
await access(path.join(appDir, launcherIconTarget));

try {
  await lstat(launcherIcon);
  await unlink(launcherIcon);
} catch (error) {
  if (error?.code !== "ENOENT") throw error;
}
await symlink(launcherIconTarget, launcherIcon);

console.log(`patched AppImage runtime: ${hookPath}`);
console.log(`removed bundled Wayland libraries: ${removedLibraries.sort().join(", ")}`);
console.log(`launcher icon: maestro.png -> ${launcherIconTarget}`);
