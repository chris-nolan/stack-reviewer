//! A loopback HTTP endpoint that agents connect to as an MCP server ("stack-reviewer").
//! Each JSON-RPC request is forwarded to the webview, which implements the tools and answers
//! via `mcp_respond`. Requests must carry the per-launch secret in the URL path.

use axum::{
    body::Bytes,
    extract::{Path, State as AxState},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::post,
    Router,
};
use serde::Serialize;
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use tauri::{AppHandle, Emitter, State};
use tokio::sync::{oneshot, Mutex};

#[derive(Clone)]
struct Shared {
    app: AppHandle,
    secret: String,
    next: Arc<AtomicU64>,
    pending: Arc<Mutex<HashMap<u64, oneshot::Sender<String>>>>,
}

pub struct Mcp {
    url: Mutex<Option<String>>,
    pending: Arc<Mutex<HashMap<u64, oneshot::Sender<String>>>>,
}

impl Default for Mcp {
    fn default() -> Self {
        Self { url: Mutex::new(None), pending: Arc::new(Mutex::new(HashMap::new())) }
    }
}

#[derive(Serialize, Clone)]
struct McpRequestEvent {
    id: u64,
    /// Which agent session sent this (the `x-sr-session` header the app gives each session).
    session: String,
    body: String,
}

async fn handle(AxState(s): AxState<Shared>, Path(secret): Path<String>, headers: HeaderMap, body: Bytes) -> Response {
    if secret != s.secret {
        return StatusCode::NOT_FOUND.into_response();
    }
    let text = String::from_utf8_lossy(&body).to_string();
    let is_request = serde_json::from_str::<serde_json::Value>(&text)
        .ok()
        .map(|v| v.get("id").is_some() && v.get("method").is_some())
        .unwrap_or(false);
    let id = s.next.fetch_add(1, Ordering::SeqCst);
    let (tx, rx) = oneshot::channel();
    if is_request {
        s.pending.lock().await.insert(id, tx);
    }
    let session = headers.get("x-sr-session").and_then(|v| v.to_str().ok()).unwrap_or("").to_string();
    let _ = s.app.emit("mcp-request", McpRequestEvent { id, session, body: text });
    if !is_request {
        return StatusCode::ACCEPTED.into_response(); // notifications and responses
    }
    match tokio::time::timeout(std::time::Duration::from_secs(120), rx).await {
        Ok(Ok(reply)) => ([("content-type", "application/json")], reply).into_response(),
        _ => {
            s.pending.lock().await.remove(&id);
            StatusCode::GATEWAY_TIMEOUT.into_response()
        }
    }
}

async fn not_allowed() -> StatusCode {
    StatusCode::METHOD_NOT_ALLOWED
}

/// Starts the endpoint on first use and returns its URL.
#[tauri::command]
pub async fn mcp_url(app: AppHandle, state: State<'_, Mcp>) -> Result<String, String> {
    let mut url = state.url.lock().await;
    if let Some(u) = url.as_ref() {
        return Ok(u.clone());
    }
    let secret = uuid::Uuid::new_v4().simple().to_string();
    let shared = Shared { app, secret: secret.clone(), next: Arc::new(AtomicU64::new(1)), pending: state.pending.clone() };
    let router = Router::new()
        .route("/mcp/{secret}", post(handle).get(not_allowed).delete(not_allowed))
        .with_state(shared);
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.map_err(|e| e.to_string())?;
    let addr = listener.local_addr().map_err(|e| e.to_string())?;
    tauri::async_runtime::spawn(async move {
        let _ = axum::serve(listener, router).await;
    });
    let u = format!("http://127.0.0.1:{}/mcp/{secret}", addr.port());
    *url = Some(u.clone());
    Ok(u)
}

#[tauri::command]
pub async fn mcp_respond(state: State<'_, Mcp>, id: u64, body: String) -> Result<(), String> {
    if let Some(tx) = state.pending.lock().await.remove(&id) {
        let _ = tx.send(body);
    }
    Ok(())
}
