//! Housekeeping for the app-managed repository cache (`<app data>/repos/<owner>/<repo>/{clone,worktrees}`).
//! Everything that deletes goes through `ensure_inside`, which refuses any path outside `repos/`.

use crate::auth::find_binary;
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Manager};
use tokio::process::Command;

const SLOT_MAX_AGE: Duration = Duration::from_secs(14 * 24 * 60 * 60);

#[derive(Serialize)]
pub struct WorktreeInfo {
    name: String,
    path: String,
    size: u64,
    /// Unix seconds.
    modified: u64,
    legacy: bool,
}

#[derive(Serialize)]
pub struct RepoCache {
    owner: String,
    repo: String,
    path: String,
    clone_size: u64,
    size: u64,
    worktrees: Vec<WorktreeInfo>,
}

#[derive(Serialize)]
pub struct CacheReport {
    path: String,
    total_size: u64,
    repos: Vec<RepoCache>,
}

#[derive(Serialize)]
pub struct CleanupResult {
    removed: Vec<String>,
    freed: u64,
    errors: Vec<String>,
}

fn repos_root(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app.path().app_data_dir().map_err(|e| e.to_string())?.join("repos"))
}

/// Legacy per-layer worktrees are named `<number>-<sha>`.
pub fn is_legacy_name(name: &str) -> bool {
    match name.split_once('-') {
        Some((n, sha)) => {
            !n.is_empty() && n.chars().all(|c| c.is_ascii_digit()) && sha.len() >= 7 && sha.chars().all(|c| c.is_ascii_hexdigit())
        }
        None => false,
    }
}

/// Pure selection of worktree names to delete: every legacy one, and slot worktrees not modified within `max_age`.
/// Anything else is left alone.
pub fn select_stale(entries: &[(String, SystemTime)], now: SystemTime, max_age: Duration) -> Vec<String> {
    entries
        .iter()
        .filter(|(name, modified)| {
            if is_legacy_name(name) {
                return true;
            }
            name.starts_with("slot-") && now.duration_since(*modified).map(|age| age > max_age).unwrap_or(false)
        })
        .map(|(n, _)| n.clone())
        .collect()
}

/// Returns the canonical path if `path` exists, is not a symlink, and lies strictly inside `root`.
pub fn ensure_inside(root: &Path, path: &Path) -> Result<PathBuf, String> {
    let root = root.canonicalize().map_err(|e| format!("cache root unavailable: {e}"))?;
    let meta = std::fs::symlink_metadata(path).map_err(|e| format!("{}: {e}", path.display()))?;
    if meta.file_type().is_symlink() {
        return Err(format!("refusing to touch symlink {}", path.display()));
    }
    let real = path.canonicalize().map_err(|e| e.to_string())?;
    if real == root || !real.starts_with(&root) {
        return Err(format!("{} is outside the repository cache", path.display()));
    }
    Ok(real)
}

fn dir_size(p: &Path) -> u64 {
    let Ok(meta) = std::fs::symlink_metadata(p) else { return 0 };
    if meta.is_file() {
        return meta.len();
    }
    if !meta.is_dir() {
        return 0;
    }
    std::fs::read_dir(p).map(|rd| rd.flatten().map(|e| dir_size(&e.path())).sum()).unwrap_or(0)
}

fn secs(t: SystemTime) -> u64 {
    t.duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

fn subdirs(p: &Path) -> Vec<(String, PathBuf)> {
    let mut v: Vec<_> = std::fs::read_dir(p)
        .map(|rd| {
            rd.flatten()
                .filter(|e| e.file_type().map(|t| t.is_dir()).unwrap_or(false))
                .map(|e| (e.file_name().to_string_lossy().to_string(), e.path()))
                .collect()
        })
        .unwrap_or_default();
    v.sort();
    v
}

pub fn report(root: &Path) -> CacheReport {
    let mut repos = Vec::new();
    for (owner, opath) in subdirs(root) {
        for (repo, rpath) in subdirs(&opath) {
            let clone_size = dir_size(&rpath.join("clone"));
            let worktrees: Vec<WorktreeInfo> = subdirs(&rpath.join("worktrees"))
                .into_iter()
                .map(|(name, path)| WorktreeInfo {
                    size: dir_size(&path),
                    modified: std::fs::metadata(&path).and_then(|m| m.modified()).map(secs).unwrap_or(0),
                    legacy: is_legacy_name(&name),
                    path: path.to_string_lossy().to_string(),
                    name,
                })
                .collect();
            let size = clone_size + worktrees.iter().map(|w| w.size).sum::<u64>();
            repos.push(RepoCache { owner: owner.clone(), repo, path: rpath.to_string_lossy().to_string(), clone_size, size, worktrees });
        }
    }
    CacheReport { path: root.to_string_lossy().to_string(), total_size: repos.iter().map(|r| r.size).sum(), repos }
}

async fn git_in(dir: &Path, args: &[&str]) -> Result<(), String> {
    let bin = find_binary("git").ok_or("git is not installed")?;
    let out = Command::new(bin).args(args).current_dir(dir).output().await.map_err(|e| e.to_string())?;
    if out.status.success() { Ok(()) } else { Err(String::from_utf8_lossy(&out.stderr).trim().to_string()) }
}

/// Removes one worktree directory (after the safety check): `git worktree remove --force` first, then the directory itself.
async fn remove_worktree(root: &Path, clone: &Path, wt: &Path) -> Result<u64, String> {
    let real = ensure_inside(root, wt)?;
    let size = dir_size(&real);
    if clone.join(".git").exists() {
        let _ = git_in(clone, &["worktree", "remove", "--force", &real.to_string_lossy()]).await;
    }
    if real.exists() {
        std::fs::remove_dir_all(&real).map_err(|e| format!("{}: {e}", real.display()))?;
    }
    Ok(size)
}

pub async fn cleanup(root: &Path, now: SystemTime) -> CleanupResult {
    let mut res = CleanupResult { removed: vec![], freed: 0, errors: vec![] };
    for (owner, opath) in subdirs(root) {
        for (repo, rpath) in subdirs(&opath) {
            let clone = rpath.join("clone");
            let wts = subdirs(&rpath.join("worktrees"));
            let entries: Vec<(String, SystemTime)> = wts
                .iter()
                .map(|(n, p)| (n.clone(), std::fs::metadata(p).and_then(|m| m.modified()).unwrap_or(now)))
                .collect();
            let stale = select_stale(&entries, now, SLOT_MAX_AGE);
            for name in &stale {
                let path = rpath.join("worktrees").join(name);
                match remove_worktree(root, &clone, &path).await {
                    Ok(n) => {
                        res.freed += n;
                        res.removed.push(format!("{owner}/{repo}/{name}"));
                    }
                    Err(e) => res.errors.push(e),
                }
            }
            if !stale.is_empty() && clone.join(".git").exists() {
                let _ = git_in(&clone, &["worktree", "prune"]).await;
            }
        }
    }
    res
}

fn plain(s: &str) -> Result<&str, String> {
    if s.is_empty() || s == "." || s.contains("..") || s.contains('/') || s.contains('\\') || s.starts_with('-') {
        return Err(format!("invalid name: {s}"));
    }
    Ok(s)
}

pub async fn remove_repo_dir(root: &Path, owner: &str, repo: &str) -> Result<u64, String> {
    let dir = root.join(plain(owner)?).join(plain(repo)?);
    let real = ensure_inside(root, &dir)?;
    let size = dir_size(&real);
    std::fs::remove_dir_all(&real).map_err(|e| format!("{}: {e}", real.display()))?;
    // Drop the owner dir too if it is now empty.
    if let Some(parent) = real.parent() {
        if parent != root.canonicalize().unwrap_or_default() {
            let _ = std::fs::remove_dir(parent);
        }
    }
    Ok(size)
}

#[tauri::command]
pub async fn cache_report(app: AppHandle) -> Result<CacheReport, String> {
    let root = repos_root(&app)?;
    tokio::task::spawn_blocking(move || report(&root)).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn cache_cleanup(app: AppHandle) -> Result<CleanupResult, String> {
    let root = repos_root(&app)?;
    if !root.exists() {
        return Ok(CleanupResult { removed: vec![], freed: 0, errors: vec![] });
    }
    Ok(cleanup(&root, SystemTime::now()).await)
}

#[tauri::command]
pub async fn cache_remove_repo(app: AppHandle, owner: String, repo: String) -> Result<u64, String> {
    let root = repos_root(&app)?;
    remove_repo_dir(&root, &owner, &repo).await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("sr-cache-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn selects_legacy_and_old_slots_only() {
        let now = SystemTime::now();
        let old = now - Duration::from_secs(20 * 86400);
        let fresh = now - Duration::from_secs(86400);
        let entries = vec![
            ("123-abcdef012345".to_string(), fresh),
            ("slot-s1-claude".to_string(), old),
            ("slot-s2-claude".to_string(), fresh),
            ("notes".to_string(), old),
            ("12-xyz".to_string(), old),
        ];
        assert_eq!(select_stale(&entries, now, SLOT_MAX_AGE), vec!["123-abcdef012345", "slot-s1-claude"]);
    }

    #[test]
    fn path_safety() {
        let root = tmp("safe");
        let repos = root.join("repos");
        std::fs::create_dir_all(repos.join("o/r/clone")).unwrap();
        std::fs::create_dir_all(root.join("outside")).unwrap();
        assert!(ensure_inside(&repos, &repos.join("o/r")).is_ok());
        assert!(ensure_inside(&repos, &repos).is_err());
        assert!(ensure_inside(&repos, &root.join("outside")).is_err());
        assert!(ensure_inside(&repos, &repos.join("o/r/../../../outside")).is_err());
        assert!(ensure_inside(&repos, &repos.join("missing")).is_err());
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(root.join("outside"), repos.join("o/link")).unwrap();
            assert!(ensure_inside(&repos, &repos.join("o/link")).is_err());
        }
        let _ = std::fs::remove_dir_all(&root);
    }

    #[tokio::test]
    async fn cleanup_and_remove_in_temp_dir() {
        let root = tmp("clean");
        let repos = root.join("repos");
        let w = repos.join("o/r/worktrees");
        for n in ["5-abcdef0123456", "slot-a-claude"] {
            std::fs::create_dir_all(w.join(n)).unwrap();
            std::fs::write(w.join(n).join("f"), b"hello").unwrap();
        }
        std::fs::create_dir_all(repos.join("o/r/clone")).unwrap();
        // Fresh slot is kept; legacy is removed.
        let r = cleanup(&repos, SystemTime::now()).await;
        assert_eq!(r.removed, vec!["o/r/5-abcdef0123456"]);
        assert_eq!(r.freed, 5);
        assert!(w.join("slot-a-claude").exists() && !w.join("5-abcdef0123456").exists());
        // Far in the future the slot is stale too.
        let r = cleanup(&repos, SystemTime::now() + Duration::from_secs(30 * 86400)).await;
        assert_eq!(r.removed, vec!["o/r/slot-a-claude"]);
        let rep = report(&repos);
        assert_eq!(rep.repos.len(), 1);
        assert!(remove_repo_dir(&repos, "..", "x").await.is_err());
        assert!(remove_repo_dir(&repos, "o", "r").await.is_ok());
        assert!(!repos.join("o").exists());
        let _ = std::fs::remove_dir_all(&root);
    }
}
