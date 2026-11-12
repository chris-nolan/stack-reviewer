// Thin wrapper over Tauri commands with browser fallbacks, so the UI also runs in a plain
// browser (fixture mode, or a pasted token for development).

import { invoke as tauriInvoke } from "@tauri-apps/api/core";

export const isTauri = (): boolean => typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

export async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  if (!isTauri()) throw new Error(`"${cmd}" needs the desktop app`);
  return tauriInvoke<T>(cmd, args);
}

const DEV_TOKEN_KEY = "stack-reviewer.dev-token";

export async function getToken(): Promise<string | null> {
  if (isTauri()) return invoke<string | null>("auth_get_token");
  try {
    return sessionStorage.getItem(DEV_TOKEN_KEY);
  } catch {
    return null;
  }
}

export async function saveToken(token: string): Promise<void> {
  if (isTauri()) return invoke("auth_save_token", { token });
  try {
    sessionStorage.setItem(DEV_TOKEN_KEY, token.trim());
  } catch {
    /* storage unavailable */
  }
}

export async function clearToken(): Promise<void> {
  if (isTauri()) return invoke("auth_clear_token");
  try {
    sessionStorage.removeItem(DEV_TOKEN_KEY);
  } catch {
    /* storage unavailable */
  }
}

export const importGhToken = () => invoke<string>("auth_import_gh_token");

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
