//! GitHub credentials: OS keychain storage, `gh` CLI import, and OAuth device flow.

use serde::{Deserialize, Serialize};
use crate::platform;
use crate::store::Store;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{LazyLock, Mutex};
use tauri::State;

const SERVICE: &str = "stack-reviewer";
/// The single entry older versions stored the one token in; migrated to a per-login entry.
const LEGACY_ACCOUNT: &str = "github";
/// Where older versions kept the account index; moved to state.db on first start (see `load_index`).
const INDEX_ACCOUNT: &str = "accounts-index";

fn entry(account: &str) -> Result<keyring::Entry, String> {
    keyring::Entry::new(SERVICE, account).map_err(|e| e.to_string())
}

fn token_account(login: &str) -> String {
    format!("github:{login}")
}

fn read_entry(account: &str) -> Result<Option<String>, String> {
    match entry(account)?.get_password() {
        Ok(t) => Ok(Some(t)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

fn delete_entry(account: &str) -> Result<(), String> {
    match entry(account)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

/// How an account signs in. `Gh` accounts keep no token of ours: it is read from `gh` on every use.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Via {
    Gh,
    Device,
    Token,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
pub struct StoredAccount {
    pub login: String,
    pub via: Via,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq, Eq)]
pub struct AccountIndex {
    pub accounts: Vec<StoredAccount>,
    pub current: Option<String>,
}

impl AccountIndex {
    /// Adds the account, or updates how it signs in, and makes it the current one.
    pub fn upsert(&mut self, login: &str, via: Via) {
        match self.accounts.iter_mut().find(|a| a.login.eq_ignore_ascii_case(login)) {
            Some(a) => a.via = via,
            None => self.accounts.push(StoredAccount { login: login.to_string(), via }),
        }
        self.current = Some(self.canonical(login).unwrap_or_else(|| login.to_string()));
    }

    fn canonical(&self, login: &str) -> Option<String> {
        self.accounts.iter().find(|a| a.login.eq_ignore_ascii_case(login)).map(|a| a.login.clone())
    }

    pub fn select(&mut self, login: &str) -> Result<(), String> {
        let l = self.canonical(login).ok_or_else(|| format!("{login} is not one of this app's accounts"))?;
        self.current = Some(l);
        Ok(())
    }

    /// Forgets the account; if it was current, the first remaining one becomes current.
    pub fn remove(&mut self, login: &str) {
        self.accounts.retain(|a| !a.login.eq_ignore_ascii_case(login));
        if self.current.as_deref().is_some_and(|c| c.eq_ignore_ascii_case(login)) {
            self.current = self.accounts.first().map(|a| a.login.clone());
        }
    }

    /// Adopts a token stored by an older version (a single anonymous entry) under its login.
    /// An account that already exists keeps how it signs in.
    pub fn adopt_legacy(&mut self, login: &str) {
        if self.canonical(login).is_none() {
            self.accounts.push(StoredAccount { login: login.to_string(), via: Via::Token });
        }
        if self.current.is_none() {
            self.current = self.canonical(login);
        }
    }
}

/// GitHub usernames: 1-39 letters, digits and single hyphens, not starting or ending with a hyphen.
/// Enterprise Managed User logins also carry an underscore suffix, so `_` is accepted too. This
/// also keeps anything that looks like a command-line flag away from `gh`.
pub fn valid_login(login: &str) -> bool {
    let b = login.as_bytes();
    !b.is_empty()
        && b.len() <= 39
        && b.iter().all(|c| c.is_ascii_alphanumeric() || *c == b'-' || *c == b'_')
        && b[0] != b'-'
        && b[b.len() - 1] != b'-'
        && !login.contains("--")
}

fn check_login(login: &str) -> Result<(), String> {
    if valid_login(login) { Ok(()) } else { Err(format!("\"{login}\" is not a valid GitHub username")) }
}

static INDEX_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

// The index holds no secrets (logins and how each signs in), so it lives in state.db rather than
// the keychain. On macOS every keychain read can ask for the login password, and an unsigned
// build is a new app to the keychain each time, so the keychain is kept for tokens only.
// The webview's durable store never loads this namespace.
const INDEX_NS: &str = "accounts";
const INDEX_KEY: &str = "index";

fn load_index(store: &Store) -> Result<AccountIndex, String> {
    load_index_with(store, || read_entry(INDEX_ACCOUNT), || delete_entry(INDEX_ACCOUNT))
}

/// Reads the index from the store. The first time (after upgrading from a version that kept it in
/// the keychain) it is moved over from `old`, once. If the old entry can't be read (the user
/// denied the keychain prompt), nothing is written, so the move is tried again next start.
fn load_index_with(
    store: &Store,
    old: impl FnOnce() -> Result<Option<String>, String>,
    forget_old: impl FnOnce() -> Result<(), String>,
) -> Result<AccountIndex, String> {
    if let Some(raw) = store.get(INDEX_NS, INDEX_KEY)? {
        // An unreadable index must not lock the user out: treat it as empty.
        return Ok(serde_json::from_str(&raw).unwrap_or_default());
    }
    let had_old = old()?;
    let index = had_old.as_deref().map(|raw| serde_json::from_str(raw).unwrap_or_default()).unwrap_or_default();
    store_index(store, &index)?;
    if had_old.is_some() {
        let _ = forget_old(); // best effort: the store's copy now wins either way
    }
    Ok(index)
}

fn store_index(store: &Store, index: &AccountIndex) -> Result<(), String> {
    let raw = serde_json::to_string(index).map_err(|e| e.to_string())?;
    store.set(INDEX_NS, INDEX_KEY, &raw)
}

/// Keychain tokens already read this launch, by lowercased login, so each is read (and on macOS
/// possibly prompted for) at most once per run.
static TOKENS: LazyLock<Mutex<HashMap<String, String>>> = LazyLock::new(Default::default);

fn tokens() -> std::sync::MutexGuard<'static, HashMap<String, String>> {
    TOKENS.lock().unwrap_or_else(|e| e.into_inner())
}

fn read_token(login: &str) -> Result<Option<String>, String> {
    let key = login.to_ascii_lowercase();
    if let Some(t) = tokens().get(&key) {
        return Ok(Some(t.clone()));
    }
    let t = read_entry(&token_account(login))?;
    if let Some(t) = &t {
        tokens().insert(key, t.clone());
    }
    Ok(t)
}

fn save_token(login: &str, token: &str) -> Result<(), String> {
    entry(&token_account(login))?.set_password(token).map_err(|e| e.to_string())?;
    tokens().insert(login.to_ascii_lowercase(), token.to_string());
    Ok(())
}

fn forget_token(login: &str) -> Result<(), String> {
    tokens().remove(&login.to_ascii_lowercase());
    delete_entry(&token_account(login))
}

/// Looks up the login a token belongs to (used once, to migrate the pre-accounts single token).
async fn login_for_token(token: &str) -> Result<String, String> {
    let v: serde_json::Value = reqwest::Client::new()
        .get("https://api.github.com/user")
        .bearer_auth(token)
        .header("User-Agent", "stack-reviewer")
        .header("Accept", "application/vnd.github+json")
        .send()
        .await
        .map_err(|e| e.to_string())?
        .error_for_status()
        .map_err(|e| e.to_string())?
        .json()
        .await
        .map_err(|e| e.to_string())?;
    v.get("login").and_then(|l| l.as_str()).map(str::to_string).ok_or_else(|| "no login in response".to_string())
}

/// The app's accounts. On the first start after an upgrade this moves the old single token under
/// its login. If GitHub can't be reached the old token stays put and the migration retries next start.
#[tauri::command]
pub async fn auth_accounts(store: State<'_, Store>) -> Result<AccountIndex, String> {
    // Looking up an entry that doesn't exist never prompts, so this costs nothing once migrated.
    let legacy = read_entry(LEGACY_ACCOUNT)?;
    if let Some(token) = legacy {
        match login_for_token(&token).await {
            Ok(login) if valid_login(&login) => {
                let _g = INDEX_LOCK.lock().unwrap_or_else(|e| e.into_inner());
                let mut index = load_index(&store)?;
                if read_token(&login)?.is_none() {
                    save_token(&login, token.trim())?;
                }
                index.adopt_legacy(&login);
                store_index(&store, &index)?;
                delete_entry(LEGACY_ACCOUNT)?;
                return Ok(index);
            }
            Ok(_) => {}
            // A rejected token is useless; anything else (offline) is worth retrying.
            Err(e) if e.contains("401") => delete_entry(LEGACY_ACCOUNT)?,
            Err(_) => {}
        }
    }
    let _g = INDEX_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    load_index(&store)
}

/// The token for an account: fresh from `gh` for gh accounts, otherwise from the keychain
/// (read once per launch).
#[tauri::command]
pub async fn auth_account_token(store: State<'_, Store>, login: String) -> Result<Option<String>, String> {
    check_login(&login)?;
    let via = {
        let _g = INDEX_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        load_index(&store)?.accounts.iter().find(|a| a.login.eq_ignore_ascii_case(&login)).map(|a| a.via)
    };
    match via {
        None => Ok(None),
        Some(Via::Gh) => auth_gh_token(login).await.map(Some),
        Some(_) => read_token(&login),
    }
}

/// Remembers an account and makes it current. Device and token accounts store their token in the
/// keychain under the login; gh accounts store nothing (the token is read from gh when needed).
#[tauri::command]
pub fn auth_account_save(store: State<'_, Store>, login: String, via: Via, token: Option<String>) -> Result<AccountIndex, String> {
    check_login(&login)?;
    let _g = INDEX_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    match (via, token) {
        (Via::Gh, _) => forget_token(&login)?,
        (_, Some(t)) if !t.trim().is_empty() => save_token(&login, t.trim())?,
        _ => return Err("a token is required for this kind of account".into()),
    }
    let mut index = load_index(&store)?;
    index.upsert(&login, via);
    store_index(&store, &index)?;
    Ok(index)
}

#[tauri::command]
pub fn auth_account_select(store: State<'_, Store>, login: String) -> Result<AccountIndex, String> {
    check_login(&login)?;
    let _g = INDEX_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let mut index = load_index(&store)?;
    index.select(&login)?;
    store_index(&store, &index)?;
    Ok(index)
}

/// Forgets an account in this app only: its keychain token and index entry. gh is not touched.
#[tauri::command]
pub fn auth_account_remove(store: State<'_, Store>, login: String) -> Result<AccountIndex, String> {
    check_login(&login)?;
    let _g = INDEX_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    forget_token(&login)?;
    let mut index = load_index(&store)?;
    index.remove(&login);
    store_index(&store, &index)?;
    Ok(index)
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

#[derive(Serialize, Debug, PartialEq, Eq)]
pub struct GhAccount {
    pub login: String,
    /// The account `gh` itself uses by default (the app does not depend on it).
    pub active: bool,
    /// gh reports the login as working (not expired or revoked).
    pub ok: bool,
}

#[derive(Deserialize)]
struct GhStatus {
    #[serde(default)]
    hosts: std::collections::HashMap<String, Vec<GhHostAccount>>,
}

#[derive(Deserialize)]
struct GhHostAccount {
    login: String,
    #[serde(default)]
    active: bool,
    #[serde(default)]
    state: String,
}

/// Parses `gh auth status --json hosts` output, keeping github.com only. Only logins and flags are
/// read; anything else gh prints (it never includes tokens) is ignored.
pub fn parse_gh_status(json: &str) -> Vec<GhAccount> {
    let Ok(status) = serde_json::from_str::<GhStatus>(json) else { return vec![] };
    status
        .hosts
        .get("github.com")
        .map(|list| {
            list.iter()
                .filter(|a| valid_login(&a.login))
                .map(|a| GhAccount { login: a.login.clone(), active: a.active, ok: a.state == "success" })
                .collect()
        })
        .unwrap_or_default()
}

/// The accounts logged in to the GitHub CLI. Empty when gh is missing, too old or signed out.
/// Read-only: never switches gh's active account.
#[tauri::command]
pub async fn auth_gh_accounts() -> Result<Vec<GhAccount>, String> {
    let Some(gh) = find_binary("gh") else { return Ok(vec![]) };
    let mut cmd = tokio::process::Command::new(gh);
    cmd.args(["auth", "status", "--json", "hosts"]);
    // gh exits non-zero when any account is broken but still prints the JSON.
    let Ok(out) = platform::no_window(&mut cmd).output().await else { return Ok(vec![]) };
    Ok(parse_gh_status(&String::from_utf8_lossy(&out.stdout)))
}

/// A token for one gh login, read fresh from gh without changing which account gh has active.
#[tauri::command]
pub async fn auth_gh_token(login: String) -> Result<String, String> {
    check_login(&login)?;
    let gh = find_binary("gh").ok_or("GitHub CLI (gh) was not found on this machine")?;
    let mut cmd = tokio::process::Command::new(gh);
    cmd.args(["auth", "token", "--hostname", "github.com", "--user", &login]);
    let out = platform::no_window(&mut cmd).output().await.map_err(|e| e.to_string())?;
    if !out.status.success() {
        return Err(format!("gh has no working login for {login}: {}", String::from_utf8_lossy(&out.stderr).trim()));
    }
    let token = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if token.is_empty() {
        return Err("gh returned an empty token".into());
    }
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_gh_status() {
        let json = r#"{"hosts":{"github.com":[
          {"state":"success","active":true,"host":"github.com","login":"alex-r","tokenSource":"keyring","scopes":"repo","gitProtocol":"https"},
          {"state":"error","active":false,"host":"github.com","login":"priya-k","tokenSource":"keyring"}],
          "ghe.example.test":[{"state":"success","active":true,"login":"sam-w"}]}}"#;
        assert_eq!(
            parse_gh_status(json),
            vec![
                GhAccount { login: "alex-r".into(), active: true, ok: true },
                GhAccount { login: "priya-k".into(), active: false, ok: false },
            ]
        );
    }

    #[test]
    fn gh_status_tolerates_junk() {
        assert!(parse_gh_status("").is_empty());
        assert!(parse_gh_status("not json").is_empty());
        assert!(parse_gh_status(r#"{"hosts":{}}"#).is_empty());
        assert!(parse_gh_status(r#"{"hosts":{"github.com":[{"login":"--evil","state":"success"}]}}"#).is_empty());
    }

    #[test]
    fn validates_logins() {
        for ok in ["alex-r", "a", "Priya-K", "a1-b2", "alex_acme", &"a".repeat(39)] {
            assert!(valid_login(ok), "{ok}");
        }
        for bad in ["", "-alex", "alex-", "a--b", "al ex", "a/b", "alex;rm", "--user", &"a".repeat(40), "né"] {
            assert!(!valid_login(bad), "{bad}");
        }
    }

    #[test]
    fn index_add_select_remove() {
        let mut i = AccountIndex::default();
        i.upsert("alex-r", Via::Gh);
        i.upsert("priya-k", Via::Token);
        assert_eq!(i.current.as_deref(), Some("priya-k"));
        i.select("ALEX-R").unwrap();
        assert_eq!(i.current.as_deref(), Some("alex-r"));
        assert!(i.select("nobody").is_err());
        i.upsert("alex-r", Via::Device);
        assert_eq!(i.accounts.len(), 2);
        assert_eq!(i.accounts[0].via, Via::Device);
        i.remove("alex-r");
        assert_eq!(i.current.as_deref(), Some("priya-k"));
        i.remove("priya-k");
        assert_eq!(i, AccountIndex::default());
    }

    #[test]
    fn migrates_legacy_single_token() {
        let mut i = AccountIndex::default();
        i.adopt_legacy("alex-r");
        assert_eq!(i.accounts, vec![StoredAccount { login: "alex-r".into(), via: Via::Token }]);
        assert_eq!(i.current.as_deref(), Some("alex-r"));
        // An existing gh account keeps its sign-in method, and the current account is not stolen.
        let mut j = AccountIndex::default();
        j.upsert("priya-k", Via::Gh);
        j.upsert("sam-w", Via::Device);
        j.adopt_legacy("priya-k");
        assert_eq!(j.accounts[0].via, Via::Gh);
        assert_eq!(j.current.as_deref(), Some("sam-w"));
    }

    #[test]
    fn index_json_shape() {
        let mut i = AccountIndex::default();
        i.upsert("alex-r", Via::Gh);
        assert_eq!(serde_json::to_string(&i).unwrap(), r#"{"accounts":[{"login":"alex-r","via":"gh"}],"current":"alex-r"}"#);
    }

    fn tmp_store(name: &str) -> (Store, std::path::PathBuf) {
        let dir = std::env::temp_dir().join(format!("stack-reviewer-auth-{name}-{}", uuid::Uuid::new_v4()));
        (Store::open(&dir.join("state.db")).unwrap(), dir)
    }

    #[test]
    fn index_moves_from_keychain_once() {
        let (store, dir) = tmp_store("move");
        let old = r#"{"accounts":[{"login":"alex-r","via":"gh"},{"login":"priya-k","via":"token"}],"current":"priya-k"}"#;
        let forgot = std::cell::Cell::new(0);
        let i = load_index_with(&store, || Ok(Some(old.to_string())), || { forgot.set(forgot.get() + 1); Ok(()) }).unwrap();
        assert_eq!(i.accounts.len(), 2);
        assert_eq!(i.current.as_deref(), Some("priya-k"));
        assert_eq!(forgot.get(), 1);
        // From now on the keychain isn't consulted at all.
        let again = load_index_with(&store, || panic!("read the keychain again"), || panic!("forgot again")).unwrap();
        assert_eq!(again, i);
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn index_without_keychain_entry_is_empty_and_settled() {
        let (store, dir) = tmp_store("empty");
        let i = load_index_with(&store, || Ok(None), || panic!("nothing to forget")).unwrap();
        assert_eq!(i, AccountIndex::default());
        // An empty index is written, so a fresh install never looks in the keychain again.
        assert!(store.get(INDEX_NS, INDEX_KEY).unwrap().is_some());
        load_index_with(&store, || panic!("read the keychain again"), || Ok(())).unwrap();
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn denied_keychain_read_retries_next_start() {
        let (store, dir) = tmp_store("denied");
        assert!(load_index_with(&store, || Err("User canceled the operation".into()), || Ok(())).is_err());
        assert!(store.get(INDEX_NS, INDEX_KEY).unwrap().is_none());
        let i = load_index_with(&store, || Ok(Some(r#"{"accounts":[{"login":"alex-r","via":"gh"}],"current":"alex-r"}"#.into())), || Ok(())).unwrap();
        assert_eq!(i.current.as_deref(), Some("alex-r"));
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn store_index_round_trips() {
        let (store, dir) = tmp_store("rt");
        let mut i = AccountIndex::default();
        i.upsert("alex-r", Via::Device);
        store_index(&store, &i).unwrap();
        assert_eq!(load_index_with(&store, || panic!("keychain"), || Ok(())).unwrap(), i);
        std::fs::remove_dir_all(dir).ok();
    }

    /// Run by hand against the real gh CLI: `cargo test real_gh -- --ignored --nocapture`. Prints logins only.
    #[test]
    #[ignore]
    fn real_gh_accounts() {
        let list = tokio::runtime::Runtime::new().unwrap().block_on(auth_gh_accounts()).unwrap();
        for a in &list {
            println!("gh account: {} active={} ok={}", a.login, a.active, a.ok);
        }
    }
}
