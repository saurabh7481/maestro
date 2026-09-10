//! In-app updates. Checking for and installing the *latest* version needs
//! no Rust code at all — `@tauri-apps/plugin-updater`'s JS API
//! (`check()`/`Update.downloadAndInstall()`) talks straight to the
//! endpoint configured in `tauri.conf.json` and does the whole
//! check/download/verify/install cycle itself (see `AboutPane.tsx`).
//!
//! This module exists only for what that JS API can't do: **reverting** to
//! an older, already-published release. `check()` always compares against
//! the *configured* endpoint and refuses anything not newer than the
//! running version — there's no per-call override. The Rust
//! `UpdaterBuilder`, however, exposes both `.endpoints(...)` (point at a
//! different manifest) and `.version_comparator(...)` (replace the
//! "only if newer" gate), so a revert reuses the exact same
//! signature-verified download/install path a normal update takes —
//! just aimed at an older release's own manifest instead of a hand-rolled,
//! unverified download of a raw asset.
//!
//! Every tagged release gets its own permanent `latest.json` (the same
//! file `tauri-action`/`scripts/patch-updater-manifest.mjs` publish for
//! "latest" get published per-tag too), reachable forever at
//! `https://github.com/{repo}/releases/download/{tag}/latest.json` — that
//! per-tag URL is what makes "revert to version X" possible at all.

use serde::{Deserialize, Serialize};
use std::time::Duration;
use tauri::{AppHandle, Emitter};
use tauri_plugin_updater::UpdaterExt;

const REPO: &str = "saurabh7481/maestro";
const HTTP_TIMEOUT: Duration = Duration::from_secs(15);

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReleaseOption {
    pub tag: String,
    pub name: String,
    pub published_at: String,
}

#[derive(Deserialize)]
struct GitHubRelease {
    tag_name: String,
    name: Option<String>,
    published_at: Option<String>,
    #[serde(default)]
    draft: bool,
    #[serde(default)]
    prerelease: bool,
    assets: Vec<GitHubAsset>,
}

#[derive(Deserialize)]
struct GitHubAsset {
    name: String,
}

/// The last several published releases that can actually be reverted to —
/// only ones carrying their own `latest.json` asset (releases built after
/// this feature shipped). Older releases are silently excluded rather than
/// offered and then failing when reverting to them is attempted.
#[tauri::command]
pub async fn list_releases() -> Result<Vec<ReleaseOption>, String> {
    let client = reqwest::Client::builder()
        .timeout(HTTP_TIMEOUT)
        .build()
        .map_err(|e| e.to_string())?;
    let releases: Vec<GitHubRelease> = client
        .get(format!(
            "https://api.github.com/repos/{REPO}/releases?per_page=20"
        ))
        // GitHub's REST API rejects requests with no User-Agent, and
        // wants an explicit Accept to pin the response shape.
        .header("User-Agent", "maestro-app")
        .header("Accept", "application/vnd.github+json")
        .send()
        .await
        .map_err(|e| e.to_string())?
        .error_for_status()
        .map_err(|e| e.to_string())?
        .json()
        .await
        .map_err(|e| e.to_string())?;

    Ok(releases
        .into_iter()
        .filter(|r| !r.draft && !r.prerelease)
        .filter(|r| r.assets.iter().any(|a| a.name == "latest.json"))
        .take(10)
        .map(|r| ReleaseOption {
            name: r
                .name
                .filter(|n| !n.trim().is_empty())
                .unwrap_or_else(|| r.tag_name.clone()),
            tag: r.tag_name,
            published_at: r.published_at.unwrap_or_default(),
        })
        .collect())
}

fn update_event_channel(op_id: &str) -> String {
    format!("update://{op_id}")
}

#[derive(Clone, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
enum UpdateEvent {
    #[serde(rename_all = "camelCase")]
    Progress {
        downloaded: usize,
        total: Option<u64>,
    },
    #[serde(rename_all = "camelCase")]
    Done {
        success: bool,
        error: Option<String>,
    },
}

/// Downloads and installs a specific past release, streaming progress on
/// `update://{op_id}`. Does not relaunch — same as a normal update, the
/// frontend prompts for that afterward (`@tauri-apps/plugin-process`'s
/// `relaunch()`).
#[tauri::command]
pub async fn revert_to_version(app: AppHandle, op_id: String, tag: String) -> Result<(), String> {
    let channel = update_event_channel(&op_id);
    let result = revert_inner(&app, &channel, &tag).await;
    let (success, error) = match result {
        Ok(()) => (true, None),
        Err(error) => (false, Some(error)),
    };
    let _ = app.emit(&channel, UpdateEvent::Done { success, error });
    Ok(())
}

async fn revert_inner(app: &AppHandle, channel: &str, tag: &str) -> Result<(), String> {
    let manifest_url = url::Url::parse(&format!(
        "https://github.com/{REPO}/releases/download/{tag}/latest.json"
    ))
    .map_err(|e| e.to_string())?;

    let updater = app
        .updater_builder()
        .endpoints(vec![manifest_url])
        .map_err(|e| e.to_string())?
        // The whole point of a revert: don't skip just because `tag` is
        // older than the running version.
        .version_comparator(|_current, _remote| true)
        .build()
        .map_err(|e| e.to_string())?;

    let update = updater
        .check()
        .await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("{tag} has no update package published for this platform."))?;

    let app_for_progress = app.clone();
    let channel_for_progress = channel.to_string();
    update
        .download_and_install(
            move |downloaded, total| {
                let _ = app_for_progress.emit(
                    &channel_for_progress,
                    UpdateEvent::Progress { downloaded, total },
                );
            },
            || {},
        )
        .await
        .map_err(|e| e.to_string())?;

    Ok(())
}
