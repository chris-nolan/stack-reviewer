import { useEffect, useRef, useState } from "react";
import { useSession } from "../app/session";
import { deviceStart, devicePoll, importGhToken, isTauri, openUrl, type DeviceCode } from "../lib/platform";
import { LogoMark } from "../ui/bits";

const CLIENT_ID = (import.meta.env.VITE_GITHUB_CLIENT_ID as string | undefined) ?? "";

export function SignIn() {
  const { signInWithToken, useDemo, error: startupError } = useSession();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(startupError);
  const [pat, setPat] = useState("");
  const [device, setDevice] = useState<DeviceCode | null>(null);
  const cancelled = useRef(false);
  const desktop = isTauri();

  useEffect(() => () => { cancelled.current = true; }, []);

  const run = async (label: string, fn: () => Promise<void>) => {
    setBusy(label);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
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
        if (res.status === "done") return signInWithToken(res.token, false);
        if (res.status === "slow_down") interval += 5;
        if (res.status === "failed") throw new Error(res.message);
      }
      throw new Error("The sign-in code expired. Try again.");
    }).finally(() => setDevice(null));

  return (
    <div style={{ minHeight: "100%", display: "grid", placeItems: "center", padding: 24 }}>
      <main className="card" style={{ width: "min(460px, 100%)", padding: 28, display: "flex", flexDirection: "column", gap: 18 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, fontWeight: 600, fontSize: 16 }}>
          <LogoMark /> Stack Reviewer
        </div>
        <div>
          <h1 style={{ margin: "0 0 6px", fontSize: 22 }}>Sign in to GitHub</h1>
          <p className="muted" style={{ margin: 0, lineHeight: 1.5 }}>
            Your token stays on this machine{desktop ? ", in the system keychain" : " for this browser tab only"}.
          </p>
        </div>

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
            {desktop && (
              <button
                className={CLIENT_ID ? "btn" : "btn btn-primary"}
                style={{ justifyContent: "center", padding: "10px 14px" }}
                disabled={!!busy}
                onClick={() => run("gh", async () => signInWithToken(await importGhToken(), false))}
              >
                {busy === "gh" ? "Reading gh login…" : "Use my GitHub CLI (gh) login"}
              </button>
            )}
          </div>
        )}

        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (pat.trim()) run("pat", () => signInWithToken(pat));
          }}
          style={{ display: "flex", flexDirection: "column", gap: 8 }}
        >
          <label htmlFor="pat" className="muted">Or paste a personal access token (needs <code>repo</code> and <code>read:org</code>)</label>
          <div style={{ display: "flex", gap: 8 }}>
            <input id="pat" className="input" type="password" autoComplete="off" value={pat} onChange={(e) => setPat(e.target.value)} placeholder="ghp_… or github_pat_…" />
            <button className="btn" type="submit" disabled={!!busy || !pat.trim()}>{busy === "pat" ? "Checking…" : "Continue"}</button>
          </div>
        </form>

        <div style={{ borderTop: "1px solid var(--border)", paddingTop: 14, display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
          <span className="muted">Just looking around?</span>
          <button className="btn btn-sm" onClick={() => run("demo", useDemo)}>Try with demo data</button>
        </div>
      </main>
    </div>
  );
}
