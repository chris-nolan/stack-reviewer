mod agent;
mod auth;
mod cache;
mod git;
mod mcp;
mod platform;
mod store;

/// GET a URL with a bearer token, following redirects. reqwest drops the Authorization header
/// when a redirect leaves the original host (e.g. Actions logs on blob storage).
#[tauri::command]
async fn http_get_text(url: String, token: String) -> Result<String, String> {
    if !url.starts_with("https://api.github.com/") {
        return Err("only api.github.com URLs are allowed".into());
    }
    let res = reqwest::Client::new()
        .get(&url)
        .bearer_auth(token)
        .header("User-Agent", "stack-reviewer")
        .header("Accept", "application/vnd.github+json")
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !res.status().is_success() {
        return Err(format!("GitHub returned {}", res.status()));
    }
    res.text().await.map_err(|e| e.to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        .manage(agent::Agents::default())
        .manage(mcp::Mcp::default())
        .setup(|app| store::setup(app.handle()))
        .invoke_handler(tauri::generate_handler![
            auth::auth_get_token,
            auth::auth_save_token,
            auth::auth_clear_token,
            auth::auth_import_gh_token,
            auth::auth_device_start,
            auth::auth_device_poll,
            agent::agents_detect,
            agent::agent_spawn,
            agent::agent_write,
            agent::agent_kill,
            git::worktree_prepare,
            git::repo_prefetch,
            cache::cache_report,
            cache::cache_cleanup,
            cache::cache_remove_repo,
            mcp::mcp_url,
            mcp::mcp_respond,
            store::store_load,
            store::store_set,
            store::store_delete,
            http_get_text,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
