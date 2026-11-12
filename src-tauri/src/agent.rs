//! Spawns local ACP agents (Claude Code via its ACP adapter, Gemini CLI) and relays their stdio
//! to the webview as events. The ACP protocol itself is spoken by the frontend.

use crate::auth::find_binary;
use crate::platform;
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
    cwd: PathBuf,
}

impl Agents {
    /// Working directories of running agents, so cache cleanup never deletes one in use.
    pub async fn busy_dirs(&self) -> Vec<PathBuf> {
        self.procs.lock().await.values().map(|p| p.cwd.canonicalize().unwrap_or_else(|_| p.cwd.clone())).collect()
    }
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
fn agent_path() -> std::ffi::OsString {
    let existing = std::env::var_os("PATH").unwrap_or_default();
    platform::build_path(&existing, &platform::current_tool_dirs(), cfg!(windows))
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
/// On Windows a path may omit the extension (`...\npm\gemini`), so `.exe`/`.cmd`/`.bat` are tried too.
fn resolve_command(command: &str) -> Result<PathBuf, String> {
    let c = command.trim();
    if c.is_empty() {
        return Err("The command is empty".into());
    }
    if c.contains('/') || c.contains('\\') || c.starts_with('~') {
        let expanded = platform::expand_tilde(c, platform::home_dir().as_deref());
        if expanded.is_file() {
            return Ok(expanded);
        }
        if cfg!(windows) {
            let s = expanded.to_string_lossy().to_string();
            for name in platform::candidate_file_names(&s, true) {
                let p = PathBuf::from(name);
                if p.is_file() {
                    return Ok(p);
                }
            }
        }
        Err(format!("{} does not exist", expanded.display()))
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
    // `.cmd`/`.bat` shims (npx.cmd, npm-installed gemini) are run by std through cmd.exe with its own
    // escaping; arguments it cannot escape safely (`%`, quotes, `&`...) are rejected with InvalidInput.
    let batch = platform::is_batch_script(&spec.program);
    let mut cmd = Command::new(&spec.program);
    cmd.args(&spec.args)
        .current_dir(&cwd)
        .env("PATH", agent_path())
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true);
    let mut child = platform::no_window(&mut cmd).spawn().map_err(|e| {
        if batch && e.kind() == std::io::ErrorKind::InvalidInput {
            format!("Could not start {agent}: Windows cannot pass these arguments to a .cmd/.bat script (avoid %, quotes and &, or point the command at the .exe): {e}")
        } else {
            format!("Could not start {agent}: {e}")
        }
    })?;

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

    state.procs.lock().await.insert(id, Proc { stdin: Arc::new(Mutex::new(stdin)), child, cwd: PathBuf::from(&cwd) });
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
        let mut child = p.child.lock().await;
        // Killing `npx.cmd` only ends cmd.exe and leaves node running, so take the whole tree down.
        #[cfg(windows)]
        if let Some(pid) = child.id() {
            let mut tk = Command::new("taskkill");
            tk.args(["/PID", &pid.to_string(), "/T", "/F"]);
            let _ = platform::no_window(&mut tk).output().await;
        }
        let _ = child.kill().await;
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
        // Any existing file works as the override target; the test binary itself exists on every OS.
        let exe = std::env::current_exe().unwrap();
        let sh = AgentOverride { id: "gemini".into(), name: String::new(), command: exe.to_string_lossy().to_string(), args: vec!["-c".into(), "true".into()] };
        let spec = launch_spec("gemini", Some(&sh)).unwrap();
        assert_eq!(spec.program, exe);
        assert_eq!(spec.args, vec!["-c", "true"]);
    }

    #[test]
    fn detect_lists_custom_agents() {
        let o = AgentOverride { id: "custom-x".into(), name: "My agent".into(), command: std::env::current_exe().unwrap().to_string_lossy().to_string(), args: vec![] };
        let list = agents_detect(Some(vec![o]));
        assert_eq!(list.len(), 3);
        assert!(list[2].available && list[2].name == "My agent");
    }

    #[test]
    fn tilde_and_missing_paths() {
        assert!(resolve_command("").is_err());
        assert!(resolve_command("~/definitely-not-here-sr").unwrap_err().contains("does not exist"));
        assert!(resolve_command("C:\\definitely\\not\\here.exe").unwrap_err().contains("does not exist"));
    }
}
