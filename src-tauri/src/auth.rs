//! GitHub credentials: OS keychain storage, `gh` CLI import, and OAuth device flow.

use serde::{Deserialize, Serialize};
use crate::platform;
use std::path::PathBuf;

const SERVICE: &str = "stack-reviewer";
const ACCOUNT: &str = "github";

fn entry() -> Result<keyring::Entry, String> {
    keyring::Entry::new(SERVICE, ACCOUNT).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn auth_get_token() -> Result<Option<String>, String> {
    match entry()?.get_password() {
        Ok(t) => Ok(Some(t)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

#[tauri::command]
pub fn auth_save_token(token: String) -> Result<(), String> {
    entry()?.set_password(token.trim()).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn auth_clear_token() -> Result<(), String> {
    match entry()?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

/// GUI apps don't inherit the shell PATH on macOS, and Windows installers often add dirs that
/// only new shells see, so look in the usual install locations too (see `platform::tool_dirs`).
pub fn find_binary(name: &str) -> Option<PathBuf> {
    if let Ok(p) = which::which(name) {
        return Some(p);
    }
    for dir in platform::current_tool_dirs() {
        for file in platform::candidate_file_names(name, cfg!(windows)) {
            let p = dir.join(&file);
            if p.is_file() {
                return Some(p);
            }
        }
    }
    None
}

/// Reads the token from an existing `gh auth login` session and stores it in the keychain.
#[tauri::command]
pub async fn auth_import_gh_token() -> Result<String, String> {
    let gh = find_binary("gh").ok_or("GitHub CLI (gh) was not found on this machine")?;
    let mut cmd = tokio::process::Command::new(gh);
    cmd.args(["auth", "token", "--hostname", "github.com"]);
    let out = platform::no_window(&mut cmd)
        .output()
        .await
        .map_err(|e| e.to_string())?;
    if !out.status.success() {
        return Err(format!(
            "gh is installed but not signed in: {}",
            String::from_utf8_lossy(&out.stderr).trim()
        ));
    }
    let token = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if token.is_empty() {
        return Err("gh returned an empty token".into());
    }
    auth_save_token(token.clone())?;
    Ok(token)
}

#[derive(Serialize, Deserialize)]
pub struct DeviceCode {
    pub device_code: String,
    pub user_code: String,
    pub verification_uri: String,
    pub interval: u64,
    pub expires_in: u64,
}

#[tauri::command]
pub async fn auth_device_start(client_id: String) -> Result<DeviceCode, String> {
    let res = reqwest::Client::new()
        .post("https://github.com/login/device/code")
        .header("Accept", "application/json")
        .form(&[("client_id", client_id.as_str()), ("scope", "repo read:org workflow")])
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !res.status().is_success() {
        return Err(format!("GitHub refused the device code request ({})", res.status()));
    }
    res.json::<DeviceCode>().await.map_err(|e| e.to_string())
}

#[derive(Serialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum DevicePoll {
    Pending,
    SlowDown,
    Done { token: String },
    Failed { message: String },
}

#[tauri::command]
pub async fn auth_device_poll(client_id: String, device_code: String) -> Result<DevicePoll, String> {
    let v: serde_json::Value = reqwest::Client::new()
        .post("https://github.com/login/oauth/access_token")
        .header("Accept", "application/json")
        .form(&[
            ("client_id", client_id.as_str()),
            ("device_code", device_code.as_str()),
            ("grant_type", "urn:ietf:params:oauth:grant-type:device_code"),
        ])
        .send()
        .await
        .map_err(|e| e.to_string())?
        .json()
        .await
        .map_err(|e| e.to_string())?;
    if let Some(token) = v.get("access_token").and_then(|t| t.as_str()) {
        auth_save_token(token.to_string())?;
        return Ok(DevicePoll::Done { token: token.to_string() });
    }
    Ok(match v.get("error").and_then(|e| e.as_str()) {
        Some("authorization_pending") => DevicePoll::Pending,
        Some("slow_down") => DevicePoll::SlowDown,
        Some(other) => DevicePoll::Failed {
            message: v
                .get("error_description")
                .and_then(|d| d.as_str())
                .unwrap_or(other)
                .to_string(),
        },
        None => DevicePoll::Failed { message: "Unexpected response from GitHub".into() },
    })
}
