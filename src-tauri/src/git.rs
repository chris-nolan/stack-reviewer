//! App-managed partial clones and per-layer worktrees, so agents can read real code.

use crate::auth::find_binary;
use crate::platform;
use base64::Engine;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};
use tokio::process::Command;

/// Owner/repo names become directory names. GitHub only allows `[A-Za-z0-9._-]`; being that strict also
/// rules out every Windows hazard: drive letters/streams (`:`), separators, `<>"|?*`, and (on Windows)
/// reserved device names and trailing dots.
fn safe(s: &str) -> Result<&str, String> {
    let ok_chars = s.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'));
    let win_bad = cfg!(windows) && (platform::is_windows_reserved(s) || s.ends_with('.'));
    if s.is_empty() || s == "." || s.contains("..") || !ok_chars || s.starts_with('-') || win_bad {
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
    let mut cmd = Command::new(bin);
    cmd.args(args)
        .current_dir(dir)
        // Scope the credential to github.com without writing it to any config file.
        .env("GIT_CONFIG_COUNT", "2")
        .env("GIT_CONFIG_KEY_0", "http.https://github.com/.extraheader")
        .env("GIT_CONFIG_VALUE_0", format!("AUTHORIZATION: basic {basic}"))
        // Windows' 260-char path limit bites deep repo trees under the app data dir.
        .env("GIT_CONFIG_KEY_1", "core.longpaths")
        .env("GIT_CONFIG_VALUE_1", "true")
        .env("GIT_TERMINAL_PROMPT", "0")
        // Git Credential Manager (bundled with Git for Windows) must never pop a dialog; we auth via the header.
        .env("GCM_INTERACTIVE", "never");
    let out = platform::no_window(&mut cmd)
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
    slot: Option<String>,
) -> Result<Worktree, String> {
    let data = app.path().app_data_dir().map_err(|e| e.to_string())?;
    prepare(&data, &token, &owner, &repo, number, &head_sha, &base_ref, slot.as_deref()).await
}

pub async fn prepare(
    data_dir: &Path,
    token: &str,
    owner: &str,
    repo: &str,
    number: u32,
    head_sha: &str,
    base_ref: &str,
    slot: Option<&str>,
) -> Result<Worktree, String> {
    // A named slot (e.g. one per stack) is a single worktree that moves between layers;
    // without one, each layer head gets its own worktree.
    if let Some(s) = slot {
        if s.is_empty() || s.len() > 64 || !s.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') {
            return Err("invalid worktree slot".into());
        }
    }
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
    // `.exists()` (not `.is_dir()`): a clone has a `.git` directory, but a linked worktree has a `.git` file.
    if !clone.join(".git").exists() {
        std::fs::create_dir_all(&root).map_err(|e| e.to_string())?;
        let url = format!("https://github.com/{owner}/{repo}.git");
        git(&root, &token, &["clone", "--filter=blob:none", "--no-checkout", "--quiet", &url, "clone"]).await?;
    }
    let pr_ref = format!("+refs/pull/{number}/head:refs/sr/pr/{number}");
    let base_spec = format!("+refs/heads/{base_ref}:refs/sr/base/{number}");
    git(&clone, &token, &["fetch", "--quiet", "--filter=blob:none", "origin", &pr_ref, &base_spec]).await?;

    let name = match slot {
        Some(s) => format!("slot-{s}"),
        None => format!("{number}-{}", &head_sha[..12.min(head_sha.len())]),
    };
    let wt = root.join("worktrees").join(name);
    if !wt.exists() {
        std::fs::create_dir_all(wt.parent().unwrap()).map_err(|e| e.to_string())?;
        let wt_str = platform::strip_verbatim(&wt.to_string_lossy());
        git(&clone, &token, &["worktree", "add", "--detach", "--quiet", &wt_str, &head_sha]).await?;
    } else if slot.is_some() {
        // Move the shared worktree to this layer. It is app-managed and agents may not edit it,
        // so discarding local changes is safe.
        git(&wt, &token, &["checkout", "--detach", "--force", "--quiet", &head_sha]).await?;
    }
    let base_sha = git(&clone, &token, &["rev-parse", &format!("refs/sr/base/{number}")]).await?.trim().to_string();
    Ok(Worktree { path: wt.to_string_lossy().to_string(), head: head_sha, base: base_sha })
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LayerCommits {
    number: u32,
    head_sha: String,
    base_sha: Option<String>,
}

#[derive(Serialize, Debug)]
pub struct Prefetch {
    /// Layers whose diff can now be read locally (commits and changed blobs present).
    ready: Vec<u32>,
    /// Problems that left a layer to the agent's own `git fetch` (not fatal).
    warnings: Vec<String>,
}

/// Before a whole-stack agent run: fetch every layer's commits into the managed clone and
/// materialise the blobs each layer's diff reads, using the app's credentials, so the agent's
/// `git diff <base> <head>` / `git show` work offline instead of asking to run `git fetch`.
#[tauri::command]
pub async fn repo_prefetch(app: AppHandle, token: String, owner: String, repo: String, layers: Vec<LayerCommits>) -> Result<Prefetch, String> {
    let data = app.path().app_data_dir().map_err(|e| e.to_string())?;
    prefetch(&data, &token, &owner, &repo, &layers).await
}

async fn fetch_into(clone: &Path, token: &str, items: &[&str]) -> Result<String, String> {
    let mut args = vec!["fetch", "--quiet", "--filter=blob:none", "origin"];
    args.extend_from_slice(items);
    git(clone, token, &args).await
}

pub async fn prefetch(data_dir: &Path, token: &str, owner: &str, repo: &str, layers: &[LayerCommits]) -> Result<Prefetch, String> {
    let (owner, repo) = (safe(owner)?, safe(repo)?);
    if layers.is_empty() || layers.len() > 200 {
        return Err("expected 1-200 layers".into());
    }
    for l in layers {
        if !is_sha(&l.head_sha) || l.base_sha.as_deref().is_some_and(|b| !is_sha(b)) {
            return Err(format!("invalid commit for #{}", l.number));
        }
    }
    let clone = data_dir.join("repos").join(owner).join(repo).join("clone");
    if !clone.join(".git").exists() {
        return Err("No checkout of this repository yet; start the agent first.".into());
    }
    let mut warnings = Vec::new();
    // PR head refs keep each layer reachable (and gc-safe); the SHAs cover bases such as the
    // trunk commit under layer 1. One fetch for everything; per-item retries only on failure.
    let refspecs: Vec<String> = layers.iter().map(|l| format!("+refs/pull/{0}/head:refs/sr/pr/{0}", l.number)).collect();
    let mut shas: Vec<&str> = layers.iter().flat_map(|l| std::iter::once(l.head_sha.as_str()).chain(l.base_sha.as_deref())).collect();
    shas.sort_unstable();
    shas.dedup();
    let all: Vec<&str> = refspecs.iter().map(String::as_str).chain(shas.iter().copied()).collect();
    if fetch_into(&clone, token, &all).await.is_err() {
        let refs: Vec<&str> = refspecs.iter().map(String::as_str).collect();
        if let Err(e) = fetch_into(&clone, token, &refs).await {
            warnings.push(format!("PR refs: {e}"));
        }
        for sha in &shas {
            if let Err(e) = fetch_into(&clone, token, &[sha]).await {
                warnings.push(format!("{}: {e}", &sha[..7.min(sha.len())]));
            }
        }
    }
    // A partial clone fetches the blobs a diff needs lazily, in one batch per diff, through this
    // process's credentials; --numstat reads both sides of every changed file.
    let mut ready = Vec::new();
    for l in layers {
        let Some(base) = &l.base_sha else {
            warnings.push(format!("#{}: no base commit known", l.number));
            continue;
        };
        match git(&clone, token, &["diff", "--numstat", base, &l.head_sha]).await {
            Ok(_) => ready.push(l.number),
            Err(e) => warnings.push(format!("#{}: {e}", l.number)),
        }
    }
    Ok(Prefetch { ready, warnings })
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
        let wt = super::prepare(&dir, &token, "octocat", "Hello-World", 1, &head_sha, "master", None).await.unwrap();
        assert!(std::path::Path::new(&wt.path).join("README").exists());
        assert_eq!(wt.base.len(), 40);
        // Second call reuses the clone and worktree.
        let again = super::prepare(&dir, &token, "octocat", "Hello-World", 1, &head_sha, "master", None).await.unwrap();
        assert_eq!(again.path, wt.path);
        // A slot worktree is created once and then moved between commits.
        let base = wt.base.clone();
        let slot = super::prepare(&dir, &token, "octocat", "Hello-World", 1, &head_sha, "master", Some("stack-1")).await.unwrap();
        assert!(slot.path.ends_with("slot-stack-1"));
        let moved = super::prepare(&dir, &token, "octocat", "Hello-World", 1, &base, "master", Some("stack-1")).await.unwrap();
        assert_eq!(moved.path, slot.path);
        let at = super::git(std::path::Path::new(&moved.path), &token, &["rev-parse", "HEAD"]).await.unwrap();
        assert_eq!(at.trim(), base);
        let _ = std::fs::remove_dir_all(&dir);
    }

    fn layer(number: u32, head: &str, base: Option<&str>) -> super::LayerCommits {
        super::LayerCommits { number, head_sha: head.into(), base_sha: base.map(Into::into) }
    }

    #[tokio::test]
    async fn prefetch_checks_its_inputs() {
        let dir = std::env::temp_dir().join(format!("sr-prefetch-{}", std::process::id()));
        let sha = "a".repeat(40);
        assert!(super::prefetch(&dir, "t", "o", "r", &[]).await.is_err());
        assert!(super::prefetch(&dir, "t", "../o", "r", &[layer(1, &sha, None)]).await.is_err());
        let bad = super::prefetch(&dir, "t", "o", "r", &[layer(1, "HEAD; rm", Some(&sha))]).await.unwrap_err();
        assert!(bad.contains("invalid commit"), "{bad}");
        let no_clone = super::prefetch(&dir, "t", "o", "r", &[layer(1, &sha, Some(&sha))]).await.unwrap_err();
        assert!(no_clone.contains("No checkout"), "{no_clone}");
    }

    /// Real repo check: a fresh partial clone, then prefetch, then every layer's diff must read with
    /// lazy fetching turned off (as for an agent without credentials). Needs network:
    /// GH_TOKEN=$(gh auth token) SR_TEST_REPO=owner/repo SR_TEST_LAYERS="n:head:base,n:head:base" cargo test prefetch_real -- --ignored
    #[tokio::test]
    #[ignore]
    async fn prefetch_real_stack_makes_diffs_local() {
        let token = std::env::var("GH_TOKEN").expect("GH_TOKEN");
        let repo = std::env::var("SR_TEST_REPO").expect("SR_TEST_REPO");
        let (owner, name) = repo.split_once('/').expect("owner/repo");
        let layers: Vec<_> = std::env::var("SR_TEST_LAYERS").expect("SR_TEST_LAYERS").split(',').map(|s| {
            let p: Vec<&str> = s.split(':').collect();
            layer(p[0].parse().unwrap(), p[1], Some(p[2]))
        }).collect();
        let dir = std::env::temp_dir().join(format!("sr-prefetch-real-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let first = &layers[0];
        super::prepare(&dir, &token, owner, name, first.number, &first.head_sha, "main", Some("t")).await.expect("prepare");
        let report = super::prefetch(&dir, &token, owner, name, &layers).await.expect("prefetch");
        println!("{report:?}");
        assert_eq!(report.ready.len(), layers.len(), "{:?}", report.warnings);
        let clone = dir.join("repos").join(owner).join(name).join("clone");
        for l in &layers {
            let out = std::process::Command::new("git")
                .args(["diff", "--stat", l.base_sha.as_deref().unwrap(), &l.head_sha])
                .current_dir(&clone)
                .env("GIT_NO_LAZY_FETCH", "1")
                .env("GIT_TERMINAL_PROMPT", "0")
                .output()
                .unwrap();
            assert!(out.status.success(), "#{} diff needs the network: {}", l.number, String::from_utf8_lossy(&out.stderr));
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn safe_names_reject_windows_and_unix_tricks() {
        for ok in ["octocat", "Hello-World", ".github", "a_b.c", "repo.js"] {
            assert!(super::safe(ok).is_ok(), "{ok}");
        }
        for bad in ["", ".", "..", "a/b", "a\\b", "C:\\x", "c:", "a:b", "x*", "a?b", "a|b", "<a>", "\"q\"", "-x", "a..b", "a b", "o\\r"] {
            assert!(super::safe(bad).is_err(), "{bad}");
        }
    }

    #[tokio::test]
    async fn rejects_path_tricks() {
        let dir = std::env::temp_dir();
        assert!(super::prepare(&dir, "t", "..", "x", 1, "abcdef1", "main", None).await.is_err());
        assert!(super::prepare(&dir, "t", "o", "r", 1, "not-a-sha", "main", None).await.is_err());
        assert!(super::prepare(&dir, "t", "o", "r", 1, "abcdef1", "--upload-pack=x", None).await.is_err());
        assert!(super::prepare(&dir, "t", "o", "r", 1, "abcdef1", "main", Some("../x")).await.is_err());
    }
}
