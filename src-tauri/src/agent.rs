//! Spawns local ACP agents (Claude Code via its ACP adapter, Gemini CLI) and relays their stdio
//! to the webview as events. The ACP protocol itself is spoken by the frontend.

use crate::auth::find_binary;
use serde::{Deserialize, Serialize};
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

/// A command the user entered in Settings: replaces the built-in launch for a known agent,
/// or defines a custom ACP agent. Only ever built from Settings values by the frontend.
#[derive(Deserialize, Clone, Debug)]
pub struct AgentOverride {
    pub id: String,
    #[serde(default)]
    pub name: String,
    pub command: String,
    #[serde(default)]
    pub args: Vec<String>,
}

/// Resolves a user-entered command: a path (absolute, `~/`, or containing a separator) must exist; a bare name is looked up on PATH.
fn resolve_command(command: &str) -> Result<PathBuf, String> {
    let c = command.trim();
    if c.is_empty() {
        return Err("The command is empty".into());
    }
    let expanded = match c.strip_prefix("~/") {
        Some(rest) => PathBuf::from(std::env::var("HOME").unwrap_or_default()).join(rest),
        None => PathBuf::from(c),
    };
    if c.contains('/') || c.contains('\\') || c.starts_with('~') {
        if expanded.is_file() { Ok(expanded) } else { Err(format!("{} does not exist", expanded.display())) }
    } else {
        find_binary(c).ok_or_else(|| format!("`{c}` was not found on PATH"))
    }
}

fn launch_spec(id: &str, over: Option<&AgentOverride>) -> Result<LaunchSpec, String> {
    if let Some(o) = over {
        return Ok(LaunchSpec { program: resolve_command(&o.command)?, args: o.args.clone() });
    }
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

fn info(id: &str, name: &str, over: Option<&AgentOverride>) -> AgentInfo {
    match launch_spec(id, over) {
        Ok(spec) => AgentInfo {
            id: id.into(),
            name: name.into(),
            available: true,
            detail: format!("{} {}", spec.program.display(), spec.args.join(" ")).trim().to_string(),
        },
        Err(e) => AgentInfo { id: id.into(), name: name.into(), available: false, detail: e },
    }
}

/// Detects the built-in agents (using any override from Settings) plus the user's custom agents.
#[tauri::command]
pub fn agents_detect(overrides: Option<Vec<AgentOverride>>) -> Vec<AgentInfo> {
    let overrides = overrides.unwrap_or_default();
    let find = |id: &str| overrides.iter().find(|o| o.id == id);
    let mut out: Vec<AgentInfo> = [("claude", "Claude Code"), ("gemini", "Gemini CLI")]
        .into_iter()
        .map(|(id, name)| info(id, name, find(id)))
        .collect();
    for o in overrides.iter().filter(|o| o.id != "claude" && o.id != "gemini") {
        let name = if o.name.trim().is_empty() { o.id.as_str() } else { o.name.as_str() };
        out.push(info(&o.id, name, Some(o)));
    }
    out
}

#[tauri::command]
pub async fn agent_spawn(app: AppHandle, state: State<'_, Agents>, agent: String, cwd: String, launch: Option<AgentOverride>) -> Result<u32, String> {
    let spec = launch_spec(&agent, launch.as_ref())?;
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn override_replaces_builtin_and_custom_needs_command() {
        let o = AgentOverride { id: "custom-x".into(), name: "X".into(), command: "/definitely/not/here".into(), args: vec![] };
        assert!(launch_spec("custom-x", Some(&o)).is_err());
        assert!(launch_spec("custom-x", None).is_err());
        let sh = AgentOverride { id: "gemini".into(), name: String::new(), command: "/bin/sh".into(), args: vec!["-c".into(), "true".into()] };
        let spec = launch_spec("gemini", Some(&sh)).unwrap();
        assert_eq!(spec.program, PathBuf::from("/bin/sh"));
        assert_eq!(spec.args, vec!["-c", "true"]);
    }

    #[test]
    fn detect_lists_custom_agents() {
        let o = AgentOverride { id: "custom-x".into(), name: "My agent".into(), command: "/bin/sh".into(), args: vec![] };
        let list = agents_detect(Some(vec![o]));
        assert_eq!(list.len(), 3);
        assert!(list[2].available && list[2].name == "My agent");
    }
}
