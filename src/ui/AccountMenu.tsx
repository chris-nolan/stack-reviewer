import { useCallback, useEffect, useRef, useState } from "react";
import { useSession } from "../app/session";
import { viaLabel, type StoredAccount } from "../lib/platform";
import { AddAccountForm } from "../features/AddAccount";
import { Modal } from "../features/review/Dialogs";

/** Fired by the palette's "Switch account…" to open the menu. */
export const OPEN_ACCOUNT_MENU = "stack-reviewer:open-account-menu";

export function Avatar({ login, size = 26 }: { login: string; size?: number }) {
  const { viewer, source } = useSession();
  const [failed, setFailed] = useState(false);
  // Real accounts use GitHub's public avatar URL; the demo's made-up logins stay offline.
  const url = viewer?.login === login && viewer.avatarUrl ? viewer.avatarUrl : source?.kind === "github" ? `https://github.com/${encodeURIComponent(login)}.png?size=${size * 2}` : "";
  if (url && !failed) return <img src={url} alt="" width={size} height={size} onError={() => setFailed(true)} style={{ borderRadius: "50%", flex: "none" }} />;
  return (
    <span aria-hidden="true" style={{ flex: "none", width: size, height: size, borderRadius: "50%", background: "#2b3a52", display: "grid", placeItems: "center", fontSize: size * 0.42, fontWeight: 600 }}>
      {login.slice(0, 2).toUpperCase()}
    </span>
  );
}

/** Opens the "add account" dialog. */
export function AddAccountDialog({ onClose }: { onClose: () => void }) {
  const { accounts } = useSession();
  return (
    <Modal label="Add account" onClose={onClose} width={460}>
      <h2 style={{ margin: 0, fontSize: 17 }}>Add a GitHub account</h2>
      <AddAccountForm exclude={accounts.map((a) => a.login)} onDone={onClose} />
    </Modal>
  );
}

/** The account list used in Settings: each account, which is in use, how it signs in, and switch/remove. */
export function AccountsList({ onAdd }: { onAdd: () => void }) {
  const { accounts, current, switchAccount, removeAccount } = useSession();
  const [error, setError] = useState<string | null>(null);
  const act = async (fn: () => Promise<void>) => {
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  return (
    <>
      {error && <div className="error-box" role="alert">{error}</div>}
      {accounts.map((a) => (
        <div key={a.login} className="card" style={{ padding: "10px 12px", display: "flex", alignItems: "center", gap: 10 }}>
          <Avatar login={a.login} />
          <span style={{ flex: 1, minWidth: 0 }}>
            <strong>{a.login}</strong> <span className="muted">· {viaLabel(a.via)}</span>
            {a.login === current && <span className="pill" style={{ marginLeft: 8, background: "var(--accent-soft-bg)" }}>✓ current</span>}
          </span>
          {a.login !== current && <button className="btn btn-sm" onClick={() => act(() => switchAccount(a.login))}>Switch</button>}
          <button className="btn btn-sm" title="Forget this account in Stack Reviewer. GitHub and the GitHub CLI are not changed." onClick={() => act(() => removeAccount(a.login))}>Remove</button>
        </div>
      ))}
      <div><button className="btn btn-sm" onClick={onAdd}>Add account…</button></div>
    </>
  );
}

/** Sidebar footer: the current account's avatar opens a keyboard-reachable menu of accounts. */
export function AccountMenu() {
  const { accounts, current, viewer, switchAccount, removeAccount } = useSession();
  const [open, setOpen] = useState(false);
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const login = current ?? viewer?.login ?? "";

  const close = useCallback((refocus = true) => {
    setOpen(false);
    if (refocus) trigger.current?.focus();
  }, []);

  useEffect(() => {
    const h = () => setOpen(true);
    window.addEventListener(OPEN_ACCOUNT_MENU, h);
    return () => window.removeEventListener(OPEN_ACCOUNT_MENU, h);
  }, []);

  useEffect(() => {
    if (!open) return;
    const items = () => [...(menu.current?.querySelectorAll<HTMLElement>('[role^="menuitem"]') ?? [])];
    (items().find((i) => i.getAttribute("aria-checked") === "true") ?? items()[0])?.focus();
    const onDown = (e: MouseEvent) => {
      if (!menu.current?.contains(e.target as Node) && !trigger.current?.contains(e.target as Node)) close(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open, close]);

  const onKey = (e: React.KeyboardEvent) => {
    const items = [...(menu.current?.querySelectorAll<HTMLElement>('[role^="menuitem"]') ?? [])];
    const i = items.indexOf(document.activeElement as HTMLElement);
    if (e.key === "Escape") { e.preventDefault(); close(); }
    else if (e.key === "ArrowDown") { e.preventDefault(); items[(i + 1) % items.length]?.focus(); }
    else if (e.key === "ArrowUp") { e.preventDefault(); items[(i - 1 + items.length) % items.length]?.focus(); }
    else if (e.key === "Home") { e.preventDefault(); items[0]?.focus(); }
    else if (e.key === "End") { e.preventDefault(); items[items.length - 1]?.focus(); }
    else if (e.key === "Tab") close(false);
  };

  const pick = async (fn: () => Promise<void>) => {
    setError(null);
    close();
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const item: React.CSSProperties = { display: "flex", alignItems: "center", gap: 10, width: "100%", padding: "8px 10px", border: 0, borderRadius: 8, background: "transparent", color: "var(--text)", textAlign: "left" };

  return (
    <div style={{ position: "relative", flex: "1 1 auto", minWidth: 0 }}>
      <button
        ref={trigger}
        className="btn"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Account menu, signed in as ${login}`}
        onClick={() => setOpen((o) => !o)}
        onKeyDown={(e) => { if (e.key === "ArrowUp" || e.key === "ArrowDown") { e.preventDefault(); setOpen(true); } }}
        style={{ display: "flex", alignItems: "center", gap: 8, width: "100%", padding: "4px 8px", border: 0, background: "transparent", color: "var(--text)", justifyContent: "flex-start" }}
      >
        <Avatar login={login} />
        <span style={{ flex: "1 1 auto", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", textAlign: "left" }}>{login}</span>
        <span aria-hidden="true" className="muted">▴</span>
      </button>
      {error && <div className="error-box" role="alert" style={{ marginTop: 6, fontSize: 12 }}>{error}</div>}
      {open && (
        <div
          ref={menu}
          role="menu"
          aria-label="Accounts"
          onKeyDown={onKey}
          style={{ position: "absolute", bottom: "calc(100% + 6px)", left: 0, minWidth: 250, padding: 6, borderRadius: 12, border: "1px solid var(--border-strong)", background: "var(--surface-3)", boxShadow: "0 12px 40px rgba(0,0,0,.5)", zIndex: 20, display: "flex", flexDirection: "column", gap: 2 }}
        >
          {accounts.map((a: StoredAccount) => (
            <button key={a.login} role="menuitemradio" aria-checked={a.login === current} tabIndex={-1} style={item} onClick={() => pick(() => switchAccount(a.login))}>
              <Avatar login={a.login} size={22} />
              <span style={{ flex: 1, minWidth: 0 }}>
                <span style={{ display: "block", overflow: "hidden", textOverflow: "ellipsis" }}>{a.login}</span>
                <span className="muted" style={{ display: "block", fontSize: 12 }}>{viaLabel(a.via)}</span>
              </span>
              <span aria-hidden="true" style={{ width: 16, color: "var(--accent)" }}>{a.login === current ? "✓" : ""}</span>
            </button>
          ))}
          <div role="separator" style={{ height: 1, background: "var(--border)", margin: "4px 0" }} />
          <button role="menuitem" tabIndex={-1} style={item} onClick={() => { close(false); setAdding(true); }}>Add account…</button>
          {login && <button role="menuitem" tabIndex={-1} style={item} onClick={() => pick(() => removeAccount(login))}>Sign out of {login}</button>}
        </div>
      )}
      {adding && <AddAccountDialog onClose={() => setAdding(false)} />}
    </div>
  );
}
