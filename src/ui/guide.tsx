// Small pieces shared by every place the guide shows up. Everything the guide produces is amber
// (`--agent*`) so the agent's opinion stays visibly apart from GitHub state and finding severity.

import { TIER_BARS, TIER_WORD, rankLabel, type Tier } from "../lib/guide";

/** The 3-bar tier meter: shape carries the tier, so colour isn't needed. */
export function TierMeter({ tier, size = 11, dim }: { tier: Tier; size?: number; dim?: boolean }) {
  const n = TIER_BARS[tier];
  return (
    <span role="img" aria-label={`${TIER_WORD[tier]} complexity`} title={`${TIER_WORD[tier]} complexity`} style={{ display: "inline-flex", gap: 2, alignItems: "flex-end", flex: "0 0 auto", opacity: dim ? 0.55 : 1 }}>
      {[1, 2, 3].map((i) => (
        <span key={i} style={{ width: Math.max(3, Math.round(size / 3)), height: Math.round(size * (0.55 + i * 0.15)), borderRadius: 1, background: i <= n ? "var(--agent)" : "var(--border-strong)" }} />
      ))}
    </span>
  );
}

/** Meter, tier word and rank: "▮▮▮ Heavy · 1st of 5". */
export function TierLabel({ tier, rank, word = true, stale }: { tier: Tier; rank?: { rank: number; of: number } | null; word?: boolean; stale?: boolean }) {
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 6, whiteSpace: "nowrap", color: "var(--agent)", fontSize: 12 }}>
      <TierMeter tier={tier} dim={stale} />
      {word && <span>{TIER_WORD[tier]}{rank ? ` · ${rankLabel(rank)}` : ""}</span>}
      {stale && <span className="pill" style={{ fontSize: 10.5, padding: "0 6px", background: "var(--warn-bg)", border: "1px solid var(--warn-bd)", color: "var(--warn-fg)" }} title="The layer has new commits since this was written">out of date</span>}
    </span>
  );
}

export function GuideIcon({ size = 13 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="9" />
      <path d="m15.5 8.5-2 5-5 2 2-5z" />
    </svg>
  );
}

export const amberBox: React.CSSProperties = { border: "1px solid var(--agent-bd)", background: "var(--agent-bg)", borderRadius: "var(--radius-lg)" };
