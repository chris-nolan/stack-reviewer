//! Durable app state (review drafts, agent transcripts, home "seen"/pins) in a SQLite file in the
//! app data dir. The webview keeps an in-memory cache and writes through these commands; UI
//! preferences stay in webview localStorage.

use rusqlite::{Connection, params};
use std::collections::HashMap;
use std::path::Path;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Manager, State};

const SCHEMA_VERSION: i64 = 1;

pub struct Store(Mutex<Connection>);

impl Store {
    pub fn open(path: &Path) -> Result<Self, String> {
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
        }
        let conn = Connection::open(path).map_err(|e| e.to_string())?;
        Self::init(conn)
    }

    /// Like `open`, but if the file can't be used (corrupt, or written by a newer app version) it is
    /// renamed aside to `state.db.unreadable-<unix secs>` (with its -wal/-shm files) and a fresh store
    /// is opened, so the app still starts. Returns the error that caused the move, if any.
    pub fn open_or_recover(path: &Path) -> Result<(Self, Option<String>), String> {
        match Self::open(path) {
            Ok(s) => Ok((s, None)),
            Err(err) => {
                let ts = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
                let name = path.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_else(|| "state.db".into());
                for suffix in ["", "-wal", "-shm"] {
                    let from = path.with_file_name(format!("{name}{suffix}"));
                    if from.exists() {
                        let to = path.with_file_name(format!("{name}.unreadable-{ts}{suffix}"));
                        std::fs::rename(&from, &to).map_err(|e| format!("{err}; could not move it aside: {e}"))?;
                    }
                }
                Ok((Self::open(path)?, Some(err)))
            }
        }
    }

    fn init(conn: Connection) -> Result<Self, String> {
        let e = |e: rusqlite::Error| e.to_string();
        // journal_mode returns a row, so read it rather than execute it.
        let _: String = conn.query_row("PRAGMA journal_mode = WAL", [], |r| r.get(0)).map_err(e)?;
        conn.execute_batch("PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 3000;").map_err(e)?;
        let version: i64 = conn.query_row("PRAGMA user_version", [], |r| r.get(0)).map_err(e)?;
        if version > SCHEMA_VERSION {
            return Err(format!("state.db is from a newer version (schema {version})"));
        }
        if version < 1 {
            conn.execute_batch(
                "CREATE TABLE IF NOT EXISTS kv (
                   ns TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, updated_at INTEGER,
                   PRIMARY KEY (ns, key)
                 );",
            )
            .map_err(e)?;
            conn.execute_batch(&format!("PRAGMA user_version = {SCHEMA_VERSION}")).map_err(e)?;
        }
        Ok(Self(Mutex::new(conn)))
    }

    pub fn load(&self, namespaces: &[String]) -> Result<HashMap<String, HashMap<String, String>>, String> {
        let conn = self.0.lock().map_err(|e| e.to_string())?;
        let mut out: HashMap<String, HashMap<String, String>> = HashMap::new();
        let mut stmt = conn.prepare("SELECT key, value FROM kv WHERE ns = ?1").map_err(|e| e.to_string())?;
        for ns in namespaces {
            let rows = stmt
                .query_map(params![ns], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
                .map_err(|e| e.to_string())?;
            let map = out.entry(ns.clone()).or_default();
            for row in rows {
                let (k, v) = row.map_err(|e| e.to_string())?;
                map.insert(k, v);
            }
        }
        Ok(out)
    }

    pub fn set(&self, ns: &str, key: &str, value: &str) -> Result<(), String> {
        let now = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0);
        self.0
            .lock()
            .map_err(|e| e.to_string())?
            .execute(
                "INSERT INTO kv (ns, key, value, updated_at) VALUES (?1, ?2, ?3, ?4)
                 ON CONFLICT(ns, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
                params![ns, key, value, now],
            )
            .map(|_| ())
            .map_err(|e| e.to_string())
    }

    pub fn get(&self, ns: &str, key: &str) -> Result<Option<String>, String> {
        let conn = self.0.lock().map_err(|e| e.to_string())?;
        match conn.query_row("SELECT value FROM kv WHERE ns = ?1 AND key = ?2", params![ns, key], |r| r.get::<_, String>(0)) {
            Ok(v) => Ok(Some(v)),
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
            Err(e) => Err(e.to_string()),
        }
    }

    pub fn delete(&self, ns: &str, key: &str) -> Result<(), String> {
        self.0
            .lock()
            .map_err(|e| e.to_string())?
            .execute("DELETE FROM kv WHERE ns = ?1 AND key = ?2", params![ns, key])
            .map(|_| ())
            .map_err(|e| e.to_string())
    }
}

/// Open `state.db` in the app data dir and register it as managed state.
pub fn setup(app: &AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    let dir = app.path().app_data_dir()?;
    let path = dir.join("state.db");
    let (store, moved) = Store::open_or_recover(&path)?;
    if let Some(err) = moved {
        eprintln!("stack-reviewer: {} could not be opened ({err}); moved it aside and started a fresh one", path.display());
    }
    app.manage(store);
    Ok(())
}

#[tauri::command]
pub fn store_load(store: State<'_, Store>, namespaces: Vec<String>) -> Result<HashMap<String, HashMap<String, String>>, String> {
    store.load(&namespaces)
}

#[tauri::command]
pub fn store_set(store: State<'_, Store>, ns: String, key: String, value: String) -> Result<(), String> {
    store.set(&ns, &key, &value)
}

#[tauri::command]
pub fn store_delete(store: State<'_, Store>, ns: String, key: String) -> Result<(), String> {
    store.delete(&ns, &key)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("stack-reviewer-store-{name}-{}", uuid::Uuid::new_v4()));
        dir.join("state.db")
    }

    #[test]
    fn set_load_delete_roundtrip() {
        let path = tmp("rt");
        let s = Store::open(&path).unwrap();
        s.set("review", "a/b#1", "{\"x\":1}").unwrap();
        s.set("review", "a/b#2", "2").unwrap();
        s.set("chat", "k", "\"v\"").unwrap();
        s.set("review", "a/b#2", "3").unwrap(); // upsert
        let all = s.load(&["review".into(), "chat".into(), "none".into()]).unwrap();
        assert_eq!(all["review"]["a/b#1"], "{\"x\":1}");
        assert_eq!(all["review"]["a/b#2"], "3");
        assert_eq!(all["chat"].len(), 1);
        assert!(all["none"].is_empty());
        s.delete("review", "a/b#1").unwrap();
        s.delete("review", "missing").unwrap();
        assert_eq!(s.load(&["review".into()]).unwrap()["review"].len(), 1);
        std::fs::remove_dir_all(path.parent().unwrap()).ok();
    }

    #[test]
    fn persists_across_reopen_and_sets_schema() {
        let path = tmp("reopen");
        Store::open(&path).unwrap().set("home", "seen", "{}").unwrap();
        let s = Store::open(&path).unwrap();
        assert_eq!(s.load(&["home".into()]).unwrap()["home"]["seen"], "{}");
        let v: i64 = s.0.lock().unwrap().query_row("PRAGMA user_version", [], |r| r.get(0)).unwrap();
        assert_eq!(v, SCHEMA_VERSION);
        std::fs::remove_dir_all(path.parent().unwrap()).ok();
    }

    #[test]
    fn rejects_newer_schema() {
        let path = tmp("newer");
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        Connection::open(&path).unwrap().execute_batch("PRAGMA user_version = 99").unwrap();
        assert!(Store::open(&path).is_err());
        std::fs::remove_dir_all(path.parent().unwrap()).ok();
    }

    #[test]
    fn recovers_from_unreadable_file() {
        let path = tmp("corrupt");
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, b"this is not a sqlite database, just junk bytes to trip the header check").unwrap();
        let (s, moved) = Store::open_or_recover(&path).unwrap();
        assert!(moved.is_some());
        s.set("home", "k", "1").unwrap();
        let aside: Vec<_> = std::fs::read_dir(path.parent().unwrap()).unwrap().flatten()
            .filter(|e| e.file_name().to_string_lossy().starts_with("state.db.unreadable-")).collect();
        assert_eq!(aside.len(), 1);
        // A healthy file is opened in place.
        drop(s);
        let (s, moved) = Store::open_or_recover(&path).unwrap();
        assert!(moved.is_none());
        assert_eq!(s.load(&["home".into()]).unwrap()["home"]["k"], "1");
        std::fs::remove_dir_all(path.parent().unwrap()).ok();
    }
}
