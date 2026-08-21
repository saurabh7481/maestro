//! OpenCode-specific commands.
//!
//! Layering note: every command here is a thin acquire → call → project
//! sequence. Raw sidecar responses carry provider keys (Phase O1), so the
//! only types that cross IPC are the projected structs from
//! `agents::opencode::providers` — there is no passthrough anywhere in
//! this file, and there must not be.

use crate::agents::opencode::client::Endpoint;
use crate::agents::opencode::providers::{self, AuthMethod, Authorization, ProviderOverview};
use crate::agents::opencode::{SidecarGuard, SidecarStatus};
use crate::agents::registry::AgentKind;
use crate::commands::agents::binary_path_for;
use crate::state::AppState;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};
use tauri::State;

/// §2.3's catalog TTL — long enough that reopening the modal doesn't
/// refetch, short enough that models added to a provider show up without
/// a restart. Every connect/disconnect invalidates it regardless.
const PROVIDER_CACHE_TTL: Duration = Duration::from_secs(10 * 60);

/// How long a successful disconnect is trusted over the server's own
/// (stale) `connected` list — see `opencode_recent_disconnects` in
/// `state.rs`.
const DISCONNECT_TRUST_WINDOW: Duration = Duration::from_secs(10 * 60);

static NEXT_GUARD_TOKEN: AtomicU64 = AtomicU64::new(1);

/// Acquires the server and returns its coordinates *with* the guard still
/// held — callers keep the guard alive across their HTTP work, so an
/// idle-reaper race can never kill the server mid-request.
async fn acquire_endpoint(state: &AppState) -> Result<(Endpoint, SidecarGuard), String> {
    let binary_path = {
        let conn = state.db.lock().map_err(|e| e.to_string())?;
        binary_path_for(&conn, AgentKind::OpenCode)?
    };
    let guard = state.opencode_sidecar.acquire(&binary_path).await?;
    let endpoint = state.opencode_sidecar.endpoint().ok_or_else(|| {
        "OpenCode server is not running even though it reported healthy".to_string()
    })?;
    Ok((endpoint, guard))
}

/// Read-only snapshot of the supervisor — never starts anything.
#[tauri::command]
pub async fn opencode_sidecar_status(state: State<'_, AppState>) -> Result<SidecarStatus, String> {
    Ok(state.opencode_sidecar.status())
}

/// Acquires the server on behalf of a mounted settings pane and returns a
/// token to release it with. This is how "pane visible" becomes one of
/// §2.2's consumers across an IPC boundary the guard can't cross.
#[tauri::command]
pub async fn opencode_sidecar_acquire(state: State<'_, AppState>) -> Result<u64, String> {
    let (_, guard) = acquire_endpoint(&state).await?;
    let token = NEXT_GUARD_TOKEN.fetch_add(1, Ordering::SeqCst);
    state
        .opencode_guards
        .lock()
        .map_err(|e| e.to_string())?
        .insert(token, guard);
    Ok(token)
}

#[tauri::command]
pub async fn opencode_sidecar_release(
    state: State<'_, AppState>,
    token: u64,
) -> Result<(), String> {
    // Dropping the guard may arm the idle reaper; that's synchronous
    // bookkeeping inside Drop, fine to do right here.
    state
        .opencode_guards
        .lock()
        .map_err(|e| e.to_string())?
        .remove(&token);
    Ok(())
}

#[tauri::command]
pub async fn opencode_list_providers(
    state: State<'_, AppState>,
    force: bool,
) -> Result<ProviderOverview, String> {
    if !force {
        if let Some((at, overview)) = state
            .opencode_provider_cache
            .lock()
            .map_err(|e| e.to_string())?
            .as_ref()
        {
            if at.elapsed() < PROVIDER_CACHE_TTL {
                return Ok(overview.clone());
            }
        }
    }

    let (endpoint, _guard) = acquire_endpoint(&state).await?;
    let mut overview = providers::overview(&endpoint).await?;

    // The server keeps removed ids in its connected list until restart
    // (Phase O4 live finding). A recent successful DELETE outranks it.
    //
    // The `recent` lock is held through the cache write below rather than
    // dropped right after the filter — `opencode_disconnect` inserts into
    // this same map under its own lock acquisition, so keeping this one
    // held serializes the two: its insert can now only land fully before
    // this filter (and gets excluded here) or fully after this whole
    // block releases the lock (in which case the *next* refresh excludes
    // it). Without that, a disconnect racing in in-between this filter
    // and the cache write below could have this call clobber a fresh
    // `invalidate_cache()` with a stale, still-connected snapshot.
    let mut recent = state
        .opencode_recent_disconnects
        .lock()
        .map_err(|e| e.to_string())?;
    recent.retain(|_, at| at.elapsed() < DISCONNECT_TRUST_WINDOW);
    overview
        .connected
        .retain(|provider| !recent.contains_key(&provider.id));

    *state
        .opencode_provider_cache
        .lock()
        .map_err(|e| e.to_string())? = Some((Instant::now(), overview.clone()));
    drop(recent);
    Ok(overview)
}

#[tauri::command]
pub async fn opencode_provider_auth_methods(
    state: State<'_, AppState>,
    provider_id: String,
) -> Result<Vec<AuthMethod>, String> {
    let (endpoint, _guard) = acquire_endpoint(&state).await?;
    providers::auth_methods(&endpoint, &provider_id).await
}

#[tauri::command]
pub async fn opencode_connect_with_key(
    state: State<'_, AppState>,
    provider_id: String,
    key: String,
) -> Result<(), String> {
    let (endpoint, _guard) = acquire_endpoint(&state).await?;
    providers::connect_api_key(&endpoint, &provider_id, &key).await?;
    invalidate_cache(&state);
    refresh_detection(&state).await;
    Ok(())
}

#[tauri::command]
pub async fn opencode_begin_oauth(
    state: State<'_, AppState>,
    provider_id: String,
    method_index: u32,
    inputs: Vec<(String, String)>,
) -> Result<Authorization, String> {
    let (endpoint, _guard) = acquire_endpoint(&state).await?;
    providers::begin_oauth(&endpoint, &provider_id, method_index, &inputs).await
}

/// Polled by the OAuth waiting state until this provider turns up
/// connected (or the frontend gives up). Cheap GET, no side effects.
#[tauri::command]
pub async fn opencode_oauth_status(
    state: State<'_, AppState>,
    provider_id: String,
) -> Result<bool, String> {
    let (endpoint, _guard) = acquire_endpoint(&state).await?;
    providers::is_connected(&endpoint, &provider_id).await
}

#[tauri::command]
pub async fn opencode_disconnect(
    state: State<'_, AppState>,
    provider_id: String,
) -> Result<(), String> {
    let (endpoint, _guard) = acquire_endpoint(&state).await?;
    providers::disconnect(&endpoint, &provider_id).await?;
    // Recorded *before* invalidating the cache, not after: a concurrent
    // `opencode_list_providers` holds the same `recent` lock across its
    // own filter-check-through-cache-write (see its comment), so whichever
    // of these two operations gets there first fully determines the
    // outcome — this row can never fall in the gap between "cache
    // cleared" and "removal recorded" the way it would if the insert
    // happened last.
    if let Ok(mut recent) = state.opencode_recent_disconnects.lock() {
        recent.insert(provider_id, Instant::now());
    }
    invalidate_cache(&state);
    refresh_detection(&state).await;
    Ok(())
}

fn invalidate_cache(state: &AppState) {
    if let Ok(mut cache) = state.opencode_provider_cache.lock() {
        *cache = None;
    }
}

/// Auth just changed, so the Agents card's pill ("Needs provider" ↔
/// "Connected") and everything downstream of `isReady` must re-derive.
/// `detect_agent_cli`'s cache would otherwise serve the stale answer
/// until the next manual Recheck.
async fn refresh_detection(state: &AppState) {
    use crate::agents::registry;
    let binary_override = {
        let conn = match state.db.lock() {
            Ok(conn) => conn,
            Err(_) => return,
        };
        match crate::commands::agents::read_binary_override(&conn, AgentKind::OpenCode) {
            Ok(override_path) => override_path,
            Err(_) => return,
        }
    };
    let status = registry::detect(AgentKind::OpenCode, binary_override).await;
    if let Ok(mut cache) = state.agent_status_cache.lock() {
        cache.insert(AgentKind::OpenCode, status);
    }
}
