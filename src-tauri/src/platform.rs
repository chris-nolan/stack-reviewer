//! Small cross-platform helpers: home directory, where to look for CLI tools, `~` expansion,
//! and spawn tweaks. The list-building functions are pure (they take an env lookup) so the
//! Windows and Unix variants can both be unit tested on any host.

use std::ffi::OsString;
use std::path::{Path, PathBuf};

/// Home directory. `HOME` on Unix; on Windows `USERPROFILE` (a `HOME` there usually comes from
/// Git Bash and is in MSYS form like `/c/Users/me`, which Rust can't use).
pub fn home_dir() -> Option<PathBuf> {
    let get = |k: &str| std::env::var_os(k).filter(|v| !v.is_empty()).map(PathBuf::from);
    if cfg!(windows) { get("USERPROFILE").or_else(|| get("HOME")) } else { get("HOME") }
}

/// Expands a leading `~`, `~/` or `~\` using `home`. Anything else is returned untouched.
pub fn expand_tilde(input: &str, home: Option<&Path>) -> PathBuf {
    let Some(home) = home else { return PathBuf::from(input) };
    if input == "~" {
        return home.to_path_buf();
    }
    match input.strip_prefix("~/").or_else(|| input.strip_prefix("~\\")) {
        Some(rest) => home.join(rest),
        None => PathBuf::from(input),
    }
}

/// Extra directories where developer tools live, beyond what a GUI app inherits in PATH.
/// `get` looks up an environment variable.
pub fn tool_dirs(windows: bool, get: &dyn Fn(&str) -> Option<String>) -> Vec<PathBuf> {
    let var = |k: &str| get(k).filter(|v| !v.is_empty()).map(PathBuf::from);
    let mut out: Vec<PathBuf> = Vec::new();
    if windows {
        let home = var("USERPROFILE");
        let appdata = var("APPDATA");
        let local = var("LOCALAPPDATA");
        let pf = var("ProgramFiles").unwrap_or_else(|| PathBuf::from("C:\\Program Files"));
        let pf86 = var("ProgramFiles(x86)").unwrap_or_else(|| PathBuf::from("C:\\Program Files (x86)"));
        let pdata = var("ProgramData").unwrap_or_else(|| PathBuf::from("C:\\ProgramData"));
        // npm global installs (`npm i -g @google/gemini-cli`) put .cmd shims here.
        if let Some(a) = &appdata {
            out.push(a.join("npm"));
        }
        out.push(pf.join("nodejs"));
        // nvm-windows exposes the active Node through a symlink dir.
        if let Some(s) = var("NVM_SYMLINK") {
            out.push(s);
        }
        if let Some(h) = var("NVM_HOME") {
            out.push(h);
        }
        // Git for Windows and GitHub CLI, machine-wide and per-user installs.
        out.push(pf.join("Git").join("cmd"));
        out.push(pf86.join("Git").join("cmd"));
        out.push(pf.join("GitHub CLI"));
        if let Some(l) = &local {
            out.push(l.join("Programs").join("Git").join("cmd"));
            out.push(l.join("Programs").join("GitHub CLI"));
            out.push(l.join("Microsoft").join("WinGet").join("Links"));
        }
        // Volta, scoop, Chocolatey.
        match (var("VOLTA_HOME"), &local, &home) {
            (Some(v), _, _) => out.push(v.join("bin")),
            (None, Some(l), _) => out.push(l.join("Volta").join("bin")),
            _ => {}
        }
        match (var("SCOOP"), &home) {
            (Some(s), _) => out.push(s.join("shims")),
            (None, Some(h)) => out.push(h.join("scoop").join("shims")),
            _ => {}
        }
        out.push(var("ChocolateyInstall").unwrap_or_else(|| pdata.join("chocolatey")).join("bin"));
        // Tools that install under the profile on every OS (Claude Code's native installer, bun, proto).
        if let Some(h) = &home {
            for rel in [[".local", "bin"], [".bun", "bin"], [".proto", "shims"], [".proto", "bin"], [".volta", "bin"], [".npm-global", "bin"]] {
                out.push(h.join(rel[0]).join(rel[1]));
            }
        }
    } else {
        for d in ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"] {
            out.push(PathBuf::from(d));
        }
        if let Some(h) = var("HOME") {
            for rel in [[".local", "bin"], [".proto", "shims"], [".proto", "bin"], [".bun", "bin"], [".volta", "bin"], [".npm-global", "bin"]] {
                out.push(h.join(rel[0]).join(rel[1]));
            }
        }
    }
    out
}

/// `tool_dirs` for the running OS and real environment.
pub fn current_tool_dirs() -> Vec<PathBuf> {
    tool_dirs(cfg!(windows), &|k| std::env::var(k).ok())
}

/// File names to try for a command `name` inside one directory.
/// On Windows the extensionless file is deliberately skipped: npm drops an extensionless *shell*
/// script next to `foo.cmd`, and CreateProcess cannot run it.
pub fn candidate_file_names(name: &str, windows: bool) -> Vec<String> {
    if !windows {
        return vec![name.to_string()];
    }
    let lower = name.to_ascii_lowercase();
    if [".exe", ".cmd", ".bat", ".com"].iter().any(|e| lower.ends_with(e)) {
        return vec![name.to_string()];
    }
    [".exe", ".cmd", ".bat", ".com"].iter().map(|e| format!("{name}{e}")).collect()
}

/// PATH for agent subprocesses: the inherited PATH plus `extra` dirs not already present
/// (compared case-insensitively on Windows).
pub fn build_path(existing: &OsString, extra: &[PathBuf], windows: bool) -> OsString {
    let key = |p: &Path| if windows { p.to_string_lossy().to_ascii_lowercase().trim_end_matches(['\\', '/']).to_string() } else { p.to_string_lossy().to_string() };
    let mut dirs: Vec<PathBuf> = std::env::split_paths(existing).filter(|p| !p.as_os_str().is_empty()).collect();
    for d in extra {
        if !dirs.iter().any(|e| key(e) == key(d)) {
            dirs.push(d.clone());
        }
    }
    // join_paths only fails if an entry contains the separator (e.g. a stray `;` on Windows);
    // in that case keep the original PATH rather than a broken one.
    std::env::join_paths(dirs).unwrap_or_else(|_| existing.clone())
}

/// True for `.cmd`/`.bat` scripts, which Windows runs through `cmd.exe`.
pub fn is_batch_script(p: &Path) -> bool {
    p.extension().map(|e| e.eq_ignore_ascii_case("cmd") || e.eq_ignore_ascii_case("bat")).unwrap_or(false)
}

/// Strips the `\\?\` verbatim prefix that `canonicalize` adds on Windows. Git and most CLI tools
/// don't accept it as a path argument. `\\?\UNC\srv\share` becomes `\\srv\share`.
pub fn strip_verbatim(p: &str) -> String {
    if let Some(rest) = p.strip_prefix("\\\\?\\UNC\\") {
        format!("\\\\{rest}")
    } else if let Some(rest) = p.strip_prefix("\\\\?\\") {
        rest.to_string()
    } else {
        p.to_string()
    }
}

/// Windows reserved device names (`CON`, `NUL`, `COM1`, ...), which can't be file names, with or without an extension.
pub fn is_windows_reserved(name: &str) -> bool {
    let stem = name.split('.').next().unwrap_or("").to_ascii_uppercase();
    matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        || (stem.len() == 4 && (stem.starts_with("COM") || stem.starts_with("LPT")) && stem.as_bytes()[3].is_ascii_digit() && stem.as_bytes()[3] != b'0')
}

/// Keeps a console window from flashing up for every child process of a GUI app on Windows.
pub fn no_window(cmd: &mut tokio::process::Command) -> &mut tokio::process::Command {
    #[cfg(windows)]
    {
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd
}

/// Recursively deletes a directory. On Windows, files git writes (pack/objects) are read-only
/// and `remove_dir_all` fails on them, so clear the flag and retry once.
pub fn remove_dir_all_force(p: &Path) -> std::io::Result<()> {
    match std::fs::remove_dir_all(p) {
        Ok(()) => Ok(()),
        Err(first) => {
            if clear_readonly(p).is_err() {
                return Err(first);
            }
            std::fs::remove_dir_all(p)
        }
    }
}

fn clear_readonly(p: &Path) -> std::io::Result<()> {
    let meta = std::fs::symlink_metadata(p)?;
    if meta.file_type().is_symlink() {
        return Ok(());
    }
    let mut perms = meta.permissions();
    if perms.readonly() {
        #[allow(clippy::permissions_set_readonly_false)]
        perms.set_readonly(false);
        std::fs::set_permissions(p, perms)?;
    }
    if meta.is_dir() {
        for e in std::fs::read_dir(p)?.flatten() {
            let _ = clear_readonly(&e.path());
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    fn env(pairs: &[(&str, &str)]) -> impl Fn(&str) -> Option<String> {
        let m: HashMap<String, String> = pairs.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect();
        move |k| m.get(k).cloned()
    }

    #[test]
    fn windows_tool_dirs_cover_common_installs() {
        let e = env(&[("USERPROFILE", "C:\\Users\\me"), ("APPDATA", "C:\\Users\\me\\AppData\\Roaming"), ("LOCALAPPDATA", "C:\\Users\\me\\AppData\\Local"), ("NVM_SYMLINK", "C:\\nvm4w\\nodejs")]);
        let dirs = tool_dirs(true, &e);
        let has = |p: PathBuf| assert!(dirs.contains(&p), "missing {}", p.display());
        has(PathBuf::from("C:\\Users\\me\\AppData\\Roaming").join("npm"));
        has(PathBuf::from("C:\\nvm4w\\nodejs"));
        has(PathBuf::from("C:\\Program Files").join("Git").join("cmd"));
        has(PathBuf::from("C:\\Program Files").join("GitHub CLI"));
        has(PathBuf::from("C:\\Users\\me\\AppData\\Local").join("Volta").join("bin"));
        has(PathBuf::from("C:\\Users\\me").join("scoop").join("shims"));
        has(PathBuf::from("C:\\Users\\me").join(".local").join("bin"));
        assert!(!dirs.iter().any(|d| d.starts_with("/opt")));
    }

    #[test]
    fn windows_tool_dirs_honour_overrides() {
        let e = env(&[("USERPROFILE", "C:\\U"), ("VOLTA_HOME", "D:\\volta"), ("SCOOP", "D:\\scoop"), ("ProgramFiles", "D:\\PF")]);
        let dirs = tool_dirs(true, &e);
        assert!(dirs.contains(&PathBuf::from("D:\\volta").join("bin")));
        assert!(dirs.contains(&PathBuf::from("D:\\scoop").join("shims")));
        assert!(dirs.contains(&PathBuf::from("D:\\PF").join("Git").join("cmd")));
        // Without USERPROFILE/APPDATA nothing panics and fixed locations remain.
        assert!(!tool_dirs(true, &env(&[])).is_empty());
    }

    #[test]
    fn unix_tool_dirs_use_home() {
        let dirs = tool_dirs(false, &env(&[("HOME", "/home/me")]));
        assert!(dirs.contains(&PathBuf::from("/opt/homebrew/bin")));
        assert!(dirs.contains(&PathBuf::from("/home/me").join(".bun").join("bin")));
        assert!(!dirs.iter().any(|d| d.to_string_lossy().contains("AppData")));
    }

    #[test]
    fn file_names_skip_extensionless_on_windows() {
        assert_eq!(candidate_file_names("npx", false), vec!["npx"]);
        let w = candidate_file_names("npx", true);
        assert_eq!(w, vec!["npx.exe", "npx.cmd", "npx.bat", "npx.com"]);
        assert_eq!(candidate_file_names("Gemini.CMD", true), vec!["Gemini.CMD"]);
    }

    #[test]
    fn tilde_expansion() {
        let h = PathBuf::from("/h/me");
        assert_eq!(expand_tilde("~/bin/x", Some(&h)), h.join("bin/x"));
        assert_eq!(expand_tilde("~\\bin\\x", Some(&h)), h.join("bin\\x"));
        assert_eq!(expand_tilde("~", Some(&h)), h);
        assert_eq!(expand_tilde("~other/x", Some(&h)), PathBuf::from("~other/x"));
        assert_eq!(expand_tilde("C:\\tools\\x.exe", Some(&h)), PathBuf::from("C:\\tools\\x.exe"));
        assert_eq!(expand_tilde("~/x", None), PathBuf::from("~/x"));
    }

    #[test]
    fn build_path_dedupes() {
        let sep = if cfg!(windows) { ";" } else { ":" };
        let existing = OsString::from(format!("{a}{sep}{b}", a = if cfg!(windows) { "C:\\Tools" } else { "/a" }, b = if cfg!(windows) { "C:\\Bin" } else { "/b" }));
        let (dup, new) = if cfg!(windows) { ("c:\\tools\\", "C:\\New") } else { ("/a", "/new") };
        let out = build_path(&existing, &[PathBuf::from(dup), PathBuf::from(new)], cfg!(windows));
        let parts: Vec<_> = std::env::split_paths(&out).collect();
        assert_eq!(parts.len(), 3);
        assert_eq!(parts[2], PathBuf::from(new));
    }

    #[test]
    fn windows_style_dedupe_is_case_insensitive() {
        // Uses the Unix separator so this runs on any host; only the comparison rule differs.
        let existing = OsString::from("/Tools/");
        let out = build_path(&existing, &[PathBuf::from("/tools")], true);
        assert_eq!(std::env::split_paths(&out).count(), 1);
    }

    #[test]
    fn batch_and_verbatim() {
        assert!(is_batch_script(Path::new("C:\\x\\npx.CMD")));
        assert!(is_batch_script(Path::new("a.bat")));
        assert!(!is_batch_script(Path::new("a.exe")));
        assert_eq!(strip_verbatim("\\\\?\\C:\\a\\b"), "C:\\a\\b");
        assert_eq!(strip_verbatim("\\\\?\\UNC\\srv\\share\\x"), "\\\\srv\\share\\x");
        assert_eq!(strip_verbatim("/unix/path"), "/unix/path");
    }

    #[test]
    fn reserved_names() {
        for n in ["con", "NUL", "aux.txt", "COM1", "lpt9", "Prn"] {
            assert!(is_windows_reserved(n), "{n}");
        }
        for n in ["console", "com0", "com10", "repo", "lpt"] {
            assert!(!is_windows_reserved(n), "{n}");
        }
    }

    #[test]
    fn force_remove_handles_readonly_files() {
        let d = std::env::temp_dir().join(format!("sr-plat-ro-{}", std::process::id()));
        let _ = remove_dir_all_force(&d);
        std::fs::create_dir_all(d.join("objects/ab")).unwrap();
        let f = d.join("objects/ab/pack");
        std::fs::write(&f, b"x").unwrap();
        let mut p = std::fs::metadata(&f).unwrap().permissions();
        p.set_readonly(true);
        std::fs::set_permissions(&f, p).unwrap();
        remove_dir_all_force(&d).unwrap();
        assert!(!d.exists());
    }
}
