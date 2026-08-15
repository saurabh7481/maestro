# Versioning and releases

Maestro uses semantic versions (`major.minor.patch`) and Git tags prefixed with
`v`. The application version is kept in sync across `package.json`,
`src-tauri/tauri.conf.json`, and `src-tauri/Cargo.toml`.

## Prepare a release

1. Set the version: `pnpm version:set 0.2.0`
2. Refresh lockfiles: `pnpm install` and `cargo check --manifest-path src-tauri/Cargo.toml`
3. Run the checks: `pnpm version:check`, `pnpm lint`, `pnpm format`,
   `pnpm typecheck`, `pnpm test`, and the Rust checks from CI.
4. Commit the release and push it to `main`.
5. Tag the exact commit and push the tag:
   `git tag -a v0.2.0 -m "Maestro v0.2.0"`, then `git push origin v0.2.0`.

Pushing a `v*` tag starts `.github/workflows/release.yml`. The workflow first
rejects a tag that does not match the application version, then builds and
publishes one GitHub release containing Linux AppImage, macOS DMG (Apple Silicon
and Intel), and Windows installers (including the NSIS `.exe`). Releases are
published automatically after all platform builds upload their bundles.
