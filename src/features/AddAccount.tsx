import { useEffect, useRef, useState } from "react";
import { useSession } from "../app/session";
import { deviceStart, devicePoll, ghAccounts, isTauri, openUrl, type DeviceCode, type GhAccount } from "../lib/platform";

const CLIENT_ID = (import.meta.env.VITE_GITHUB_CLIENT_ID as string | undefined) ?? "";

/**
 * The ways to add a GitHub account: a GitHub CLI (gh) login picked from the list gh reports (never just
 * gh's active one), the device flow, or a pasted token. Shared by the sign-in screen, the account menu
 * and Settings. `exclude` hides logins the app already has.
 */
export function AddAccountForm({ exclude = [], onDone, initialError = null }: { exclude?: string[]; onDone?: () => void; initialError?: string | null }) {
  const { addAccount } = useSession();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(initialError);
  const [pat, setPat] = useState("");
  const [device, setDevice] = useState<DeviceCode | null>(null);
  const [gh, setGh] = useState<GhAccount[]>([]);
  const [ghLoaded, setGhLoaded] = useState(false);
  const cancelled = useRef(false);
  const desktop = isTauri();
  const skip = new Set(exclude.map((l) => l.toLowerCase()));

  useEffect(() => {
    cancelled.current = false;
    return () => { cancelled.current = true; };
  }, []);
  useEffect(() => {
    if (!desktop) return;
    void ghAccounts().then((l) => {
      if (cancelled.current) return;
      setGh(l.filter((a) => a.ok));
      setGhLoaded(true);
    });
  }, [desktop]);

  const run = async (label: string, fn: () => Promise<void>) => {
    setBusy(label);
    setError(null);
    try {
      await fn();
      if (!cancelled.current) onDone?.();
    } catch (e) {
      if (!cancelled.current) setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (!cancelled.current) setBusy(null);
    }
  };

  const startDevice = () =>
    run("device", async () => {
      const code = await deviceStart(CLIENT_ID);
      setDevice(code);
      await openUrl(code.verification_uri);
      let interval = code.interval;
      const deadline = Date.now() + code.expires_in * 1000;
      while (!cancelled.current && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, interval * 1000));
        const res = await devicePoll(CLIENT_ID, code.device_code);
        if (res.status === "done") return addAccount({ via: "device", token: res.token });
        if (res.status === "slow_down") interval += 5;
        if (res.status === "failed") throw new Error(res.message);
      }
      throw new Error("The sign-in code expired. Try again.");
    }).finally(() => setDevice(null));

  const choices = gh.filter((a) => !skip.has(a.login.toLowerCase()));

  return (
    <>
      {error && <div className="error-box" role="alert">{error}</div>}

      {device ? (
        <div className="card" style={{ padding: 16, background: "var(--surface-2)", display: "flex", flexDirection: "column", gap: 8 }}>
          <span className="muted">Enter this code on GitHub:</span>
          <span className="mono" style={{ fontSize: 26, letterSpacing: "0.15em" }}>{device.user_code}</span>
          <button className="btn" onClick={() => openUrl(device.verification_uri)}>Open {device.verification_uri}</button>
          <span className="muted" style={{ display: "flex", gap: 8, alignItems: "center" }}><span className="spinner" aria-hidden="true" /> Waiting for you to approve…</span>
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {desktop && CLIENT_ID && (
            <button className="btn btn-primary" style={{ justifyContent: "center", padding: "10px 14px" }} disabled={!!busy} onClick={startDevice}>
              Sign in with GitHub
            </button>
          )}
          {desktop && ghLoaded && gh.length === 0 && (
            <p className="muted" style={{ margin: 0, fontSize: 12 }}>No GitHub CLI (gh) login found. Run <code>gh auth login</code> to use one, or sign in another way.</p>
          )}
          {choices.length > 0 && (
            <div role="group" aria-label="GitHub CLI accounts" style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              <span className="label">{choices.length === 1 ? "Use your GitHub CLI (gh) login" : "Choose a GitHub CLI (gh) account"}</span>
              {choices.map((a) => (
                <button
                  key={a.login}
                  className={CLIENT_ID || choices.length > 1 ? "btn" : "btn btn-primary"}
                  style={{ justifyContent: "space-between", padding: "10px 14px" }}
                  disabled={!!busy}
                  onClick={() => run(`gh:${a.login}`, () => addAccount({ via: "gh", login: a.login }))}
                >
                  <span>{busy === `gh:${a.login}` ? "Reading gh login…" : a.login}</span>
                  {a.active && <span className="muted" style={{ fontSize: 12 }}>gh's active account</span>}
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (pat.trim()) run("pat", () => addAccount({ via: "token", token: pat }));
        }}
        style={{ display: "flex", flexDirection: "column", gap: 8 }}
      >
        <label htmlFor="pat" className="muted">Or paste a personal access token (needs <code>repo</code> and <code>read:org</code>)</label>
        <div style={{ display: "flex", gap: 8 }}>
          <input id="pat" className="input" type="password" autoComplete="off" value={pat} onChange={(e) => setPat(e.target.value)} placeholder="ghp_… or github_pat_…" />
          <button className="btn" type="submit" disabled={!!busy || !pat.trim()}>{busy === "pat" ? "Checking…" : "Continue"}</button>
        </div>
      </form>
    </>
  );
}
