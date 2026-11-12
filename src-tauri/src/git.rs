//! App-managed partial clones and per-layer worktrees, so agents can read real code.

use crate::auth::find_binary;
use base64::Engine;
use serde::Serialize;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};
use tokio::process::Command;

fn safe(s: &str) -> Result<&str, String> {
    if s.is_empty() || s.contains("..") || s.contains('/') || s.contains('\\') || s.starts_with('-') {
        return Err(format!("invalid name: {s}"));
    }
    Ok(s)
}

fn is_sha(s: &str) -> bool {
    s.len() >= 7 && s.len() <= 64 && s.chars().all(|c| c.is_ascii_hexdigit())
}

async fn git(dir: &Path, token: &str, args: &[&str]) -> Result<String, String> {
    let bin = find_binary("git").ok_or("git is not installed")?;
    let basic = base64::engine::general_purpose::STANDARD.encode(format!("x-access-token:{token}"));
    let out = Command::new(bin)
        .args(args)
        .current_dir(dir)
        // Scope the credential to github.com without writing it to any config file.
        .env("GIT_CONFIG_COUNT", "1")
        .env("GIT_CONFIG_KEY_0", "http.https://github.com/.extraheader")
        .env("GIT_CONFIG_VALUE_0", format!("AUTHORIZATION: basic {basic}"))
        .env("GIT_TERMINAL_PROMPT", "0")
        .output()
        .await
        .map_err(|e| e.to_string())?;
    if !out.status.success() {
        return Err(format!("git {} failed: {}", args.first().unwrap_or(&""), String::from_utf8_lossy(&out.stderr).trim()));
    }
    Ok(String::from_utf8_lossy(&out.stdout).to_string())
}

#[derive(Serialize)]
pub struct Worktree {
    path: String,
    head: String,
    base: String,
}

/// Ensures a partial clone of owner/repo and a detached worktree at the PR head.
/// Returns the worktree path plus the SHAs to diff (`git diff base...head`).
#[tauri::command]
pub async fn worktree_prepare(
    app: AppHandle,
    token: String,
    owner: String,
    repo: String,
    number: u32,
    head_sha: String,
    base_ref: String,
) -> Result<Worktree, String> {
    let data = app.path().app_data_dir().map_err(|e| e.to_string())?;
    prepare(&data, &token, &owner, &repo, number, &head_sha, &base_ref).await
}

pub async fn prepare(
    data_dir: &Path,
    token: &str,
    owner: &str,
    repo: &str,
    number: u32,
    head_sha: &str,
    base_ref: &str,
) -> Result<Worktree, String> {
    let (owner, repo) = (safe(owner)?.to_string(), safe(repo)?.to_string());
    let (token, head_sha, base_ref) = (token.to_string(), head_sha.to_string(), base_ref.to_string());
    if !is_sha(&head_sha) {
        return Err("invalid head sha".into());
    }
    if base_ref.starts_with('-') || base_ref.contains("..") {
        return Err("invalid base ref".into());
    }
    let root: PathBuf = data_dir.join("repos").join(&owner).join(&repo);
    let clone = root.join("clone");
    if !clone.join(".git").exists() {
        std::fs::create_dir_all(&root).map_err(|e| e.to_string())?;
        let url = format!("https://github.com/{owner}/{repo}.git");
        git(&root, &token, &["clone", "--filter=blob:none", "--no-checkout", "--quiet", &url, "clone"]).await?;
    }
    let pr_ref = format!("+refs/pull/{number}/head:refs/sr/pr/{number}");
    let base_spec = format!("+refs/heads/{base_ref}:refs/sr/base/{number}");
    git(&clone, &token, &["fetch", "--quiet", "--filter=blob:none", "origin", &pr_ref, &base_spec]).await?;

    let wt = root.join("worktrees").join(format!("{number}-{}", &head_sha[..12.min(head_sha.len())]));
    if !wt.exists() {
        std::fs::create_dir_all(wt.parent().unwrap()).map_err(|e| e.to_string())?;
        let wt_str = wt.to_string_lossy().to_string();
        git(&clone, &token, &["worktree", "add", "--detach", "--quiet", &wt_str, &head_sha]).await?;
    }
    let base_sha = git(&clone, &token, &["rev-parse", &format!("refs/sr/base/{number}")]).await?.trim().to_string();
    Ok(Worktree { path: wt.to_string_lossy().to_string(), head: head_sha, base: base_sha })
}

#[cfg(test)]
mod tests {
    /// Needs network and GH_TOKEN; run with `GH_TOKEN=$(gh auth token) cargo test -- --ignored`.
    #[tokio::test]
    #[ignore]
    async fn prepares_a_worktree_for_a_public_pr() {
        let token = std::env::var("GH_TOKEN").expect("GH_TOKEN");
        let dir = std::env::temp_dir().join(format!("sr-git-test-{}", std::process::id()));
        // octocat/Hello-World PR #1 is a long-lived public pull request.
        let sha = "7629413c8d0e52c3ea3ac0d0e0e8e7cc8cb3d4ee";
        let head = super::git(&std::env::temp_dir(), &token, &["ls-remote", "https://github.com/octocat/Hello-World.git", "refs/pull/1/head"])
            .await
            .unwrap();
        let head_sha = head.split_whitespace().next().unwrap_or(sha).to_string();
        let wt = super::prepare(&dir, &token, "octocat", "Hello-World", 1, &head_sha, "master").await.unwrap();
        assert!(std::path::Path::new(&wt.path).join("README").exists());
        assert_eq!(wt.base.len(), 40);
        // Second call reuses the clone and worktree.
        let again = super::prepare(&dir, &token, "octocat", "Hello-World", 1, &head_sha, "master").await.unwrap();
        assert_eq!(again.path, wt.path);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn rejects_path_tricks() {
        let dir = std::env::temp_dir();
        assert!(super::prepare(&dir, "t", "..", "x", 1, "abcdef1", "main").await.is_err());
        assert!(super::prepare(&dir, "t", "o", "r", 1, "not-a-sha", "main").await.is_err());
        assert!(super::prepare(&dir, "t", "o", "r", 1, "abcdef1", "--upload-pack=x").await.is_err());
    }
}
