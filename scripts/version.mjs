import { readFile, writeFile } from "node:fs/promises";
import process from "node:process";

const files = {
  package: new URL("../package.json", import.meta.url),
  tauri: new URL("../src-tauri/tauri.conf.json", import.meta.url),
  cargo: new URL("../src-tauri/Cargo.toml", import.meta.url),
};

const args = process.argv.slice(2);
const checkOnly = args.includes("--check");
const tagIndex = args.indexOf("--tag");
const expectedTag = tagIndex >= 0 ? args[tagIndex + 1] : undefined;
const requestedVersion = args.find((arg) => /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(arg));

/** The top-level `"version"` field, which is the only `"version"` key in
 * either manifest (dependency entries are `"name": "range"` pairs). */
const JSON_VERSION_FIELD = /^(\s*"version":\s*)"[^"]+"/m;

/** Rewrites just the version, leaving the rest of the file byte-for-byte
 * alone.
 *
 * Deliberately not `JSON.parse` → edit → `JSON.stringify`: that reformats
 * the whole file to `JSON.stringify`'s house style, which disagrees with
 * Prettier's (single-element arrays get expanded across three lines). The
 * result was that `pnpm version:set` left `tauri.conf.json` failing
 * `pnpm format` — two steps later in the very same release checklist.
 * Cargo.toml was always edited this way; the JSON files now match. */
function setJsonVersion(source, version, label) {
  if (!JSON_VERSION_FIELD.test(source)) {
    throw new Error(`No top-level "version" field found in ${label}`);
  }
  return source.replace(JSON_VERSION_FIELD, `$1"${version}"`);
}

const packageSource = await readFile(files.package, "utf8");
const tauriSource = await readFile(files.tauri, "utf8");
const packageJson = JSON.parse(packageSource);
const tauriConfig = JSON.parse(tauriSource);
const cargoToml = await readFile(files.cargo, "utf8");
const cargoVersion = cargoToml.match(/^version = "([^"]+)"/m)?.[1];

if (checkOnly) {
  const versions = [packageJson.version, tauriConfig.version, cargoVersion];
  if (!versions.every((version) => version === versions[0])) {
    throw new Error(
      `Version mismatch: package=${versions[0]}, tauri=${versions[1]}, cargo=${versions[2]}`,
    );
  }
  if (expectedTag && expectedTag !== `v${versions[0]}`) {
    throw new Error(
      `Release tag ${expectedTag} does not match application version v${versions[0]}`,
    );
  }
  console.log(`Maestro version ${versions[0]} is synchronized.`);
  process.exit(0);
}

if (!requestedVersion) {
  throw new Error("Usage: pnpm version:set <major.minor.patch>");
}

await writeFile(files.package, setJsonVersion(packageSource, requestedVersion, "package.json"));
await writeFile(files.tauri, setJsonVersion(tauriSource, requestedVersion, "tauri.conf.json"));
await writeFile(
  files.cargo,
  cargoToml.replace(/^version = "[^"]+"/m, `version = "${requestedVersion}"`),
);

console.log(`Set Maestro version to ${requestedVersion}. Run pnpm install to refresh lockfiles.`);
