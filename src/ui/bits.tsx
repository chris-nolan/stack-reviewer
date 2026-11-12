import type { CheckRun, ChecksState, Layer, MyLayerState, Severity } from "../lib/model";

export const LAYER_STYLE: Record<MyLayerState, { glyph: string; word: string; fg: string; bg: string; bd: string; ring: string; fill: string }> = {
  approved: { glyph: "✓", word: "Approved by you", fg: "var(--ok-fg)", bg: "var(--ok-bg)", bd: "var(--ok-bd)", ring: "var(--ok)", fill: "var(--ok)" },
  commented: { glyph: "✓", word: "Reviewed by you", fg: "var(--ok-fg)", bg: "var(--ok-bg)", bd: "var(--ok-bd)", ring: "var(--ok)", fill: "transparent" },
  changes: { glyph: "✕", word: "You requested changes", fg: "var(--bad-fg)", bg: "var(--del-bg)", bd: "var(--bad-bd)", ring: "var(--bad)", fill: "transparent" },
  stale: { glyph: "!", word: "New commits since your review", fg: "var(--warn-fg)", bg: "#2f2914", bd: "var(--warn-bd)", ring: "var(--warn)", fill: "transparent" },
  turn: { glyph: "●", word: "Your review requested", fg: "var(--accent-soft-fg)", bg: "#1b2636", bd: "var(--accent-soft-bd)", ring: "var(--accent)", fill: "transparent" },
  waiting: { glyph: "…", word: "Waiting for reviewers", fg: "#b9c7d8", bg: "#1a2029", bd: "#2b3442", ring: "#6b7a8f", fill: "transparent" },
  todo: { glyph: "", word: "Not reviewed", fg: "var(--muted)", bg: "var(--surface-2)", bd: "#252a31", ring: "#4a525d", fill: "transparent" },
  merged: { glyph: "⇡", word: "Merged", fg: "#c9b6ff", bg: "#1d1830", bd: "#3a2f5c", ring: "#a48bff", fill: "#a48bff" },
  closed: { glyph: "–", word: "Closed", fg: "var(--muted)", bg: "var(--surface-2)", bd: "#252a31", ring: "#4a525d", fill: "transparent" },
};

export const CHECK_STYLE: Record<ChecksState, { glyph: string; word: string; color: string }> = {
  pass: { glyph: "✓", word: "Checks pass", color: "var(--ok)" },
  fail: { glyph: "✕", word: "Checks failing", color: "var(--bad)" },
  pending: { glyph: "●", word: "Checks running", color: "var(--warn)" },
  none: { glyph: "·", word: "No checks", color: "var(--muted)" },
};

export const SEVERITY_STYLE: Record<Severity, { fg: string; bg: string; bd: string }> = {
  High: { fg: "#ffb4aa", bg: "#3a1d1a", bd: "#5a2c27" },
  Medium: { fg: "#f5c77e", bg: "#352816", bd: "#4e3a1e" },
  Low: { fg: "#b9c7d8", bg: "#1e2733", bd: "#2e3a4a" },
};

export function checkRunState(c: CheckRun): ChecksState {
  if (c.status !== "completed") return "pending";
  if (["success", "neutral", "skipped"].includes(c.conclusion ?? "")) return "pass";
  return "fail";
}

export function LayerRing({ layer, size = 24, outline }: { layer: Layer; size?: number; outline?: boolean }) {
  const s = LAYER_STYLE[layer.mine];
  const filled = s.fill !== "transparent";
  return (
    <span
      aria-hidden="true"
      style={{
        flex: `0 0 ${size}px`, width: size, height: size, borderRadius: "50%",
        border: `2px solid ${s.ring}`, background: s.fill, color: filled ? "var(--accent-ink)" : "var(--text)",
        display: "grid", placeItems: "center", fontSize: size > 22 ? 12 : 11, fontWeight: 700,
        outline: outline ? "2px solid var(--accent-soft-fg)" : undefined, outlineOffset: 2,
      }}
    >
      {layer.index}
    </span>
  );
}

export function LayerStrip({ layers }: { layers: Layer[] }) {
  const label = "Layers: " + layers.map((l) => `${l.index} ${LAYER_STYLE[l.mine].word.toLowerCase()}`).join(", ");
  return (
    <span role="img" aria-label={label} style={{ display: "flex", gap: 3, minWidth: 0 }}>
      {layers.map((l) => {
        const s = LAYER_STYLE[l.mine];
        return (
          <span
            key={l.pr.number}
            title={`#${l.pr.number} ${l.pr.title} — ${s.word}`}
            style={{
              flex: "1 1 0", minWidth: 6, maxWidth: 44, height: 22, borderRadius: 5, background: s.bg,
              border: `1px solid ${s.bd}`, color: s.fg, display: "grid", placeItems: "center", fontSize: 11, fontWeight: 700,
            }}
          >
            {layers.length <= 10 ? s.glyph : ""}
          </span>
        );
      })}
    </span>
  );
}

export function ChecksLabel({ state, text }: { state: ChecksState; text?: string }) {
  const s = CHECK_STYLE[state];
  return (
    <span style={{ color: s.color }}>
      <span aria-hidden="true">{s.glyph}</span> {text ?? s.word}
    </span>
  );
}

export function AgentDot({ ok = true }: { ok?: boolean }) {
  return <span className="dot" aria-hidden="true" style={ok ? { background: "var(--ok)" } : { border: "2px solid #5a626d" }} />;
}

export function LogoMark() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 3 3 8l9 5 9-5-9-5Z" />
      <path d="m3 13 9 5 9-5" />
    </svg>
  );
}

export function ChevronLeft() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
      <path d="m15 18-6-6 6-6" />
    </svg>
  );
}

export function timeAgo(iso: string): string {
  if (!iso) return "";
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 172800) return "yesterday";
  return `${Math.floor(s / 86400)} days ago`;
}

export function Spinner({ label = "Loading" }: { label?: string }) {
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 8, color: "var(--muted)" }}>
      <span className="spinner" aria-hidden="true" /> {label}
    </span>
  );
}

export function ErrorBox({ error }: { error: unknown }) {
  const e = error as { message?: string; ssoUrl?: string };
  return (
    <div className="error-box" role="alert">
      {e?.message ?? String(error)}
      {e?.ssoUrl && (
        <>
          {" "}
          This org uses SAML single sign-on. <a href={e.ssoUrl} target="_blank" rel="noreferrer">Authorise your token</a>, then retry.
        </>
      )}
    </div>
  );
}
