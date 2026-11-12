//! Spawns local ACP agents (Claude Code via its ACP adapter, Gemini CLI) and relays their stdio
//! to the webview as events. The ACP protocol itself is spoken by the frontend.

use crate::auth::find_binary;
use serde::Serialize;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Arc;
use tauri::{AppHandle, Emitter, State};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, Command};
use tokio::sync::Mutex;

/// Pinned so a new adapter release can't change behaviour under us.
const CLAUDE_ADAPTER: &str = "@agentclientprotocol/claude-agent-acp@0.106.0";

#[derive(Default)]
pub struct Agents {
    next: AtomicU32,
    procs: Mutex<HashMap<u32, Proc>>,
}

struct Proc {
    stdin: Arc<Mutex<ChildStdin>>,
    child: Arc<Mutex<Child>>,
}

#[derive(Serialize, Clone)]
pub struct AgentInfo {
    id: String,
    name: String,
    available: bool,
    detail: String,
}

struct LaunchSpec {
    program: PathBuf,
    args: Vec<String>,
}

/// PATH for agent subprocesses: GUI apps start with a minimal PATH, but agents need node etc.
fn agent_path() -> String {
    let home = std::env::var("HOME").unwrap_or_default();
    let mut dirs: Vec<String> = std::env::var("PATH")
        .unwrap_or_default()
        .split(if cfg!(windows) { ';' } else { ':' })
        .map(String::from)
        .collect();
    for d in [
        "/opt/homebrew/bin".to_string(),
        "/usr/local/bin".to_string(),
        format!("{home}/.local/bin"),
        format!("{home}/.proto/shims"),
        format!("{home}/.proto/bin"),
        format!("{home}/.bun/bin"),
        format!("{home}/.volta/bin"),
        format!("{home}/.npm-global/bin"),
    ] {
        if !dirs.contains(&d) {
            dirs.push(d);
        }
    }
    dirs.join(if cfg!(windows) { ";" } else { ":" })
}

fn launch_spec(id: &str) -> Result<LaunchSpec, String> {
    match id {
        "claude" => {
            find_binary("claude").ok_or("Claude Code is not installed (no `claude` on PATH)")?;
            let npx = find_binary("npx").ok_or("Node.js (npx) is needed to run the Claude Code ACP adapter")?;
            Ok(LaunchSpec { program: npx, args: vec!["-y".into(), CLAUDE_ADAPTER.into()] })
        }
        "gemini" => {
            let gemini = find_binary("gemini").ok_or("Gemini CLI is not installed")?;
            Ok(LaunchSpec { program: gemini, args: vec!["--acp".into()] })
        }
        other => Err(format!("Unknown agent {other}")),
    }
}

#[tauri::command]
pub fn agents_detect() -> Vec<AgentInfo> {
    [("claude", "Claude Code"), ("gemini", "Gemini CLI")]
        .into_iter()
        .map(|(id, name)| match launch_spec(id) {
            Ok(spec) => AgentInfo {
                id: id.into(),
                name: name.into(),
                available: true,
                detail: format!("{} {}", spec.program.display(), spec.args.join(" ")),
            },
            Err(e) => AgentInfo { id: id.into(), name: name.into(), available: false, detail: e },
        })
        .collect()
}

#[tauri::command]
pub async fn agent_spawn(app: AppHandle, state: State<'_, Agents>, agent: String, cwd: String) -> Result<u32, String> {
    let spec = launch_spec(&agent)?;
    let mut child = Command::new(&spec.program)
        .args(&spec.args)
        .current_dir(&cwd)
        .env("PATH", agent_path())
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| format!("Could not start {agent}: {e}"))?;

    let id = state.next.fetch_add(1, Ordering::SeqCst) + 1;
    let stdout = child.stdout.take().ok_or("no stdout")?;
    let stderr = child.stderr.take().ok_or("no stderr")?;
    let stdin = child.stdin.take().ok_or("no stdin")?;
    let child = Arc::new(Mutex::new(child));

    let app_out = app.clone();
    tokio::spawn(async move {
        let mut lines = BufReader::new(stdout).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            let _ = app_out.emit(&format!("agent-stdout-{id}"), line);
        }
        let _ = app_out.emit(&format!("agent-exit-{id}"), ());
    });
    let app_err = app.clone();
    tokio::spawn(async move {
        let mut lines = BufReader::new(stderr).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            let _ = app_err.emit(&format!("agent-stderr-{id}"), line);
        }
    });

    state.procs.lock().await.insert(id, Proc { stdin: Arc::new(Mutex::new(stdin)), child });
    Ok(id)
}

#[tauri::command]
pub async fn agent_write(state: State<'_, Agents>, id: u32, line: String) -> Result<(), String> {
    let stdin = {
        let procs = state.procs.lock().await;
        procs.get(&id).map(|p| p.stdin.clone()).ok_or("agent is not running")?
    };
    let mut w = stdin.lock().await;
    w.write_all(line.as_bytes()).await.map_err(|e| e.to_string())?;
    w.write_all(b"\n").await.map_err(|e| e.to_string())?;
    w.flush().await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn agent_kill(state: State<'_, Agents>, id: u32) -> Result<(), String> {
    if let Some(p) = state.procs.lock().await.remove(&id) {
        let _ = p.child.lock().await.kill().await;
    }
    Ok(())
}
