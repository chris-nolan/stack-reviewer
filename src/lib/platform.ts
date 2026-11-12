// Thin wrapper over Tauri commands with browser fallbacks, so the UI also runs in a plain
// browser (fixture mode, or a pasted token for development).

import { invoke as tauriInvoke } from "@tauri-apps/api/core";

export const isTauri = (): boolean => typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

export async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  if (!isTauri()) throw new Error(`"${cmd}" needs the desktop app`);
  return tauriInvoke<T>(cmd, args);
}

/** How an account signs in: via the GitHub CLI (token read fresh from gh each time), device flow, or a pasted token. */
export type Via = "gh" | "device" | "token";
export type StoredAccount = { login: string; via: Via };
export type AccountIndex = { accounts: StoredAccount[]; current: string | null };
export type GhAccount = { login: string; active: boolean; ok: boolean };

export const viaLabel = (via: Via): string => (via === "gh" ? "via GitHub CLI" : via === "device" ? "via device sign-in" : "via token");

// Browser (dev) fallback: the same shape kept in sessionStorage so a pasted token still works without the desktop app.
const DEV_KEY = "stack-reviewer.dev-accounts";
type DevState = { index: AccountIndex; tokens: Record<string, string> };
function devRead(): DevState {
  try {
    const raw = sessionStorage.getItem(DEV_KEY);
    if (raw) return JSON.parse(raw) as DevState;
  } catch {
    /* storage unavailable */
  }
  return { index: { accounts: [], current: null }, tokens: {} };
}
function devWrite(s: DevState) {
  try {
    sessionStorage.setItem(DEV_KEY, JSON.stringify(s));
  } catch {
    /* storage unavailable */
  }
}

/** The app's accounts (the desktop app migrates a pre-accounts token here on first call). */
export async function accountsLoad(): Promise<AccountIndex> {
  return isTauri() ? invoke<AccountIndex>("auth_accounts") : devRead().index;
}

/** The token for one account. gh accounts get a fresh token from gh every time. */
export async function accountToken(login: string): Promise<string | null> {
  return isTauri() ? invoke<string | null>("auth_account_token", { login }) : (devRead().tokens[login] ?? null);
}

/** Remember an account and make it current. `token` is required unless `via` is "gh". */
export async function accountSave(login: string, via: Via, token?: string): Promise<AccountIndex> {
  if (isTauri()) return invoke<AccountIndex>("auth_account_save", { login, via, token: token ?? null });
  const s = devRead();
  if (via !== "gh") s.tokens[login] = (token ?? "").trim();
  s.index.accounts = [...s.index.accounts.filter((a) => a.login !== login), { login, via }];
  s.index.current = login;
  devWrite(s);
  return s.index;
}

export async function accountSelect(login: string): Promise<AccountIndex> {
  if (isTauri()) return invoke<AccountIndex>("auth_account_select", { login });
  const s = devRead();
  s.index.current = login;
  devWrite(s);
  return s.index;
}

/** Forget an account in this app only (never touches gh). */
export async function accountRemove(login: string): Promise<AccountIndex> {
  if (isTauri()) return invoke<AccountIndex>("auth_account_remove", { login });
  const s = devRead();
  delete s.tokens[login];
  s.index.accounts = s.index.accounts.filter((a) => a.login !== login);
  if (s.index.current === login) s.index.current = s.index.accounts[0]?.login ?? null;
  devWrite(s);
  return s.index;
}

/** Accounts logged in to the GitHub CLI (read-only; empty without the desktop app or gh). */
export async function ghAccounts(): Promise<GhAccount[]> {
  if (!isTauri()) return [];
  try {
    return await invoke<GhAccount[]>("auth_gh_accounts");
  } catch {
    return [];
  }
}

export const ghToken = (login: string) => invoke<string>("auth_gh_token", { login });

export type DeviceCode = { device_code: string; user_code: string; verification_uri: string; interval: number; expires_in: number };
export type DevicePoll = { status: "pending" | "slow_down" } | { status: "done"; token: string } | { status: "failed"; message: string };

export const deviceStart = (clientId: string) => invoke<DeviceCode>("auth_device_start", { clientId });
export const devicePoll = (clientId: string, deviceCode: string) => invoke<DevicePoll>("auth_device_poll", { clientId, deviceCode });

export async function openUrl(url: string): Promise<void> {
  if (isTauri()) {
    const { openUrl: open } = await import("@tauri-apps/plugin-opener");
    await open(url);
  } else {
    window.open(url, "_blank", "noopener");
  }
}

/** Fetch text through the Rust side (follows redirects without CORS, strips auth on cross-host hops). */
export async function httpGetText(url: string, token: string): Promise<string> {
  if (isTauri()) return invoke<string>("http_get_text", { url, token });
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

/** Small persisted key/value store for per-user conveniences (review drafts, UI prefs). */
export const local = {
  get<T>(key: string, fallback: T): T {
    try {
      const raw = localStorage.getItem(`stack-reviewer.${key}`);
      return raw ? (JSON.parse(raw) as T) : fallback;
    } catch {
      return fallback;
    }
  },
  set(key: string, value: unknown): void {
    try {
      localStorage.setItem(`stack-reviewer.${key}`, JSON.stringify(value));
    } catch {
      /* storage unavailable */
    }
  },
};
