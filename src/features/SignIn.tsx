import { useState } from "react";
import { useSession } from "../app/session";
import { isTauri, viaLabel } from "../lib/platform";
import { LogoMark } from "../ui/bits";
import { AddAccountForm } from "./AddAccount";

export function SignIn() {
  const { switchAccount, accounts, useDemo, error: startupError } = useSession();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const desktop = isTauri();

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  return (
    <div style={{ minHeight: "100%", display: "grid", placeItems: "center", padding: 24 }}>
      <main className="card" style={{ width: "min(460px, 100%)", padding: 28, display: "flex", flexDirection: "column", gap: 18 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, fontWeight: 600, fontSize: 16 }}>
          <LogoMark /> Stack Reviewer
        </div>
        <div>
          <h1 style={{ margin: "0 0 6px", fontSize: 22 }}>Sign in to GitHub</h1>
          <p className="muted" style={{ margin: 0, lineHeight: 1.5 }}>
            Your token stays on this machine{desktop ? ", in the system keychain" : " for this browser tab only"}. You can add more than one account later.
          </p>
        </div>

        {(error ?? startupError) && <div className="error-box" role="alert">{error ?? startupError}</div>}

        {accounts.length > 0 && (
          <div role="group" aria-label="Saved accounts" style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <span className="label">Saved accounts</span>
            {accounts.map((a) => (
              <button key={a.login} className="btn" style={{ justifyContent: "space-between", padding: "8px 14px" }} disabled={busy} onClick={() => run(() => switchAccount(a.login))}>
                <span>{a.login}</span><span className="muted" style={{ fontSize: 12 }}>{viaLabel(a.via)}</span>
              </button>
            ))}
          </div>
        )}

        <AddAccountForm exclude={accounts.map((a) => a.login)} />

        <div style={{ borderTop: "1px solid var(--border)", paddingTop: 14, display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
          <span className="muted">Just looking around?</span>
          <button className="btn btn-sm" onClick={() => run(useDemo)}>Try with demo data</button>
        </div>
      </main>
    </div>
  );
}
