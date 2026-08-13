use crate::fs_ops::{self, FileReadResult, FsEntry, WriteResult};
use crate::git;
use std::collections::HashMap;
use std::path::PathBuf;

#[tauri::command]
pub async fn list_dir(worktree_root: String, rel_dir: String) -> Result<Vec<FsEntry>, String> {
    fs_ops::list_dir(&PathBuf::from(worktree_root), &rel_dir).await
}

#[tauri::command]
pub async fn read_file(worktree_root: String, rel_path: String) -> Result<FileReadResult, String> {
    fs_ops::read_file(&PathBuf::from(worktree_root), &rel_path).await
}

#[tauri::command]
pub async fn write_file(
    worktree_root: String,
    rel_path: String,
    content: String,
    expected_mtime_ms: Option<i64>,
) -> Result<WriteResult, String> {
    fs_ops::write_file(
        &PathBuf::from(worktree_root),
        &rel_path,
        &content,
        expected_mtime_ms,
    )
    .await
}

#[tauri::command]
pub async fn create_entry(
    worktree_root: String,
    rel_path: String,
    is_dir: bool,
) -> Result<(), String> {
    fs_ops::create_entry(&PathBuf::from(worktree_root), &rel_path, is_dir).await
}

#[tauri::command]
pub async fn rename_entry(
    worktree_root: String,
    from_rel: String,
    to_rel: String,
) -> Result<(), String> {
    fs_ops::rename_entry(&PathBuf::from(worktree_root), &from_rel, &to_rel).await
}

#[tauri::command]
pub async fn delete_entry(worktree_root: String, rel_path: String) -> Result<(), String> {
    fs_ops::delete_entry(&PathBuf::from(worktree_root), &rel_path).await
}

#[tauri::command]
pub async fn get_status_map(worktree_root: String) -> Result<HashMap<String, char>, String> {
    git::status_map(&PathBuf::from(worktree_root)).await
}
