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

const packageJson = JSON.parse(await readFile(files.package, "utf8"));
const tauriConfig = JSON.parse(await readFile(files.tauri, "utf8"));
const cargoToml = await readFile(files.cargo, "utf8");
const cargoVersion = cargoToml.match(/^version = "([^"]+)"/m)?.[1];

if (checkOnly) {
  const versions = [packageJson.version, tauriConfig.version, cargoVersion];
  if (!versions.every((version) => version === versions[0])) {
    throw new Error(`Version mismatch: package=${versions[0]}, tauri=${versions[1]}, cargo=${versions[2]}`);
  }
  if (expectedTag && expectedTag !== `v${versions[0]}`) {
    throw new Error(`Release tag ${expectedTag} does not match application version v${versions[0]}`);
  }
  console.log(`Maestro version ${versions[0]} is synchronized.`);
  process.exit(0);
}

if (!requestedVersion) {
  throw new Error("Usage: pnpm version:set <major.minor.patch>");
}

packageJson.version = requestedVersion;
tauriConfig.version = requestedVersion;

await writeFile(files.package, `${JSON.stringify(packageJson, null, 2)}\n`);
await writeFile(files.tauri, `${JSON.stringify(tauriConfig, null, 2)}\n`);
await writeFile(
  files.cargo,
  cargoToml.replace(/^version = "[^"]+"/m, `version = "${requestedVersion}"`),
);

console.log(`Set Maestro version to ${requestedVersion}. Run pnpm install to refresh lockfiles.`);
