import { useMemo } from "react";
import type { GuidePermission } from "../../agent/guideRun";
import { guideTargets, TIER_WORD, type GuideDoc } from "../../lib/guide";
import type { Stack } from "../../lib/model";
import { timeAgo } from "../../ui/bits";
import { amberBox, GuideIcon, TierMeter } from "../../ui/guide";
import { InlineText } from "./InlineText";

type Props = {
  stack: Stack;
  doc: GuideDoc;
  compact: boolean;
  collapsed: boolean;
  onCollapse: (c: boolean) => void;
  onLayer: (index: number) => void;
  onViewChat: () => void;
  onStop: () => void;
  onContinue: () => void;
  onRerun: () => void;
  onRefresh: () => void;
  preparing: string | null;
  /** A question the running guide's agent is waiting on, shown here because the chat is usually hidden. */
  permission?: GuidePermission | null;
};

const head: React.CSSProperties = { display: "inline-flex", alignItems: "center", gap: 6, color: "var(--agent)", fontWeight: 600, fontSize: 11, letterSpacing: "0.08em", textTransform: "uppercase" };
const sub: React.CSSProperties = { flex: "0 0 auto", color: "var(--agent)", fontSize: 11, fontWeight: 600, letterSpacing: "0.06em", textTransform: "uppercase" };

export function GuideCard(p: Props) {
  const { stack, doc } = p;
  const run = doc.run;
  const byPr = useMemo(() => new Map(stack.layers.map((l) => [l.pr.number, l.index])), [stack]);
  const open = stack.layers.filter((l) => l.pr.state === "OPEN");
  if (run?.status === "running") return <RunningCard {...p} />;
  if (!doc.stack && !Object.keys(doc.layers).length) return null;
  const guided = open.filter((l) => doc.layers[l.pr.number]).length;
  if (!doc.stack || (run && run.status !== "done" && run.pending.length)) return <PartialCard {...p} guided={guided} total={open.length} />;

  const t = guideTargets(doc, stack.layers);
  const changed = new Set([...t.stale, ...t.missing, ...t.removed]).size;
  const ranking = doc.stack.ranking;
  const when = `${doc.stack.agent} · ${timeAgo(new Date(doc.stack.createdAt).toISOString())}`;
  const link = (text: string) => <InlineText text={text} layers={byPr} onLayer={p.onLayer} />;
  const staleBadge = changed > 0 && (
    <span className="pill" style={{ background: "var(--warn-bg)", border: "1px solid var(--warn-bd)", color: "var(--warn-fg)" }}>{changed} {changed === 1 ? "layer" : "layers"} out of date</span>
  );

  if (p.collapsed) {
    const heavy = ranking.slice(0, 3);
    return (
      <section aria-label="Stack guide" style={{ ...amberBox, flex: "0 0 auto", display: "flex", alignItems: "center", gap: 10, padding: "8px 14px", minWidth: 0 }}>
        <span style={head}><GuideIcon />Guide</span>
        <span style={{ flex: "1 1 auto", minWidth: 0, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", color: "var(--text-2)" }} title={doc.stack.plan.replace(/[*`]/g, "")}>
          <span className="muted">Heaviest: </span>
          {heavy.map((n, i) => <span key={n}>{i > 0 && ", "}<a href="#layer" onClick={(e) => { e.preventDefault(); p.onLayer(byPr.get(n) ?? 1); }}>#{n}</a></span>)}
          <span className="muted"> · </span>{link(doc.stack.plan)}
        </span>
        {staleBadge}
        {changed > 0 && <button className="btn btn-sm btn-agent" onClick={p.onRefresh}>Refresh guide</button>}
        <button className="btn btn-sm" aria-expanded={false} onClick={() => p.onCollapse(false)}>Expand</button>
      </section>
    );
  }

  return (
    <section aria-label="Stack guide" style={{ ...amberBox, flex: "0 0 auto", padding: "14px 16px", display: "flex", flexDirection: "column", gap: 12, minWidth: 0 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <span style={head}><GuideIcon />Guide</span>
        <span className="faint">{when}</span>
        {staleBadge}
        <span className="spacer" />
        {changed > 0 && <button className="btn btn-sm btn-agent" onClick={p.onRefresh}>Refresh guide</button>}
        <button className="btn btn-sm" onClick={p.onViewChat}>View chat</button>
        <button className="btn btn-sm" onClick={p.onRerun}>Re-run…</button>
        <button className="btn btn-sm" aria-expanded onClick={() => p.onCollapse(true)}>Collapse</button>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1.5fr) minmax(0, 1fr)", gap: 28 }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 10, minWidth: 0 }}>
          <p style={{ margin: 0, lineHeight: 1.55, color: "var(--text)", maxWidth: 760 }}>{link(doc.stack.summary)}</p>
          <div style={{ display: "flex", gap: 8, alignItems: "baseline", lineHeight: 1.55 }}>
            <span style={sub}>Plan</span>
            <span style={{ color: "var(--text-2)" }}>{link(doc.stack.plan)}</span>
          </div>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 4, minWidth: 0 }}>
          <span className="label" style={{ fontSize: 10.5 }}>Hardest first</span>
          <div className="scroll" style={{ maxHeight: 156 }}>
            {ranking.map((n, i) => {
              const l = stack.layers.find((x) => x.pr.number === n);
              const g = doc.layers[n];
              if (!l || !g) return null;
              return (
                <button key={n} onClick={() => p.onLayer(l.index)} style={{ display: "flex", alignItems: "center", gap: 10, padding: "3px 6px", margin: "0 -6px", border: 0, background: "transparent", borderRadius: 6, color: "var(--text-2)", textAlign: "left", width: "calc(100% + 12px)" }}>
                  <span className="mono faint" style={{ width: 14, textAlign: "right", fontSize: 11 }}>{i + 1}</span>
                  <TierMeter tier={g.tier} />
                  <span style={{ width: 62, color: "var(--agent)", fontSize: 12 }}>{TIER_WORD[g.tier]}</span>
                  <span className="mono muted" style={{ fontSize: 12 }}>#{n}</span>
                  <span style={{ flex: "1 1 auto", minWidth: 0, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{l.pr.title}</span>
                </button>
              );
            })}
          </div>
        </div>
      </div>
    </section>
  );
}

function PermissionAsk({ p }: { p: GuidePermission }) {
  return (
    <div role="alert" style={{ padding: 10, borderRadius: 10, border: "1px solid #3a3328", background: "#18160f", display: "flex", flexDirection: "column", gap: 8 }}>
      <span style={{ color: "var(--warn-fg)" }}>{p.agentName} is waiting for your permission to continue the guide</span>
      <code style={{ fontSize: 12, whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{p.title}</code>
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
        {p.options.map((o) => (
          <button key={o.optionId} className={o.kind === "allow_once" ? "btn btn-sm btn-soft" : "btn btn-sm"} style={{ whiteSpace: "normal", textAlign: "left", maxWidth: "100%", lineHeight: 1.35 }} onClick={() => p.answer(o.optionId)}>{o.name}</button>
        ))}
      </div>
    </div>
  );
}

function RunningCard({ stack, doc, onViewChat, onStop, preparing, permission }: Props) {
  const run = doc.run!;
  const done = run.total - run.pending.length;
  const reading = run.reading != null ? stack.layers.find((l) => l.pr.number === run.reading) : undefined;
  const finishing = run.pending.length === 0;
  return (
    <section aria-label="Stack guide" aria-live="polite" style={{ ...amberBox, flex: "0 0 auto", padding: "14px 16px", display: "flex", flexDirection: "column", gap: 10 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <span style={head}><GuideIcon />Guide</span>
        <strong style={{ fontWeight: 600 }}>{finishing ? "Writing the stack summary" : `Guiding layer ${Math.min(done + 1, run.total)} of ${run.total}`}</strong>
        <span className="faint">· {run.agent} · {timeAgo(new Date(run.startedAt).toISOString())}</span>
        <span className="spacer" />
        <button className="btn btn-sm" onClick={onViewChat}>View chat</button>
        <button className="btn btn-sm" onClick={onStop}>Stop</button>
      </div>
      <div role="progressbar" aria-valuemin={0} aria-valuemax={run.total} aria-valuenow={done} aria-label="Guide progress" style={{ display: "flex", gap: 3 }}>
        {Array.from({ length: run.total }, (_, i) => (
          <span key={i} style={{ flex: "1 1 0", height: 6, borderRadius: 3, background: i < done ? "var(--agent)" : i === done && !finishing ? "var(--agent-bd)" : "var(--border-strong)", opacity: i < done ? 1 : 0.9 }} />
        ))}
      </div>
      {permission && <PermissionAsk p={permission} />}
      <span className="muted" style={{ lineHeight: 1.5 }}>
        {preparing ?? (reading ? <>Reading <span className="mono">#{reading.pr.number}</span> {reading.pr.title}. </> : finishing ? "Ranking the layers against each other. " : "Starting. ")}
        The stack summary, plan and ranking appear after the last layer. Layers fill in below as they're done; you can start reviewing at any time.
      </span>
    </section>
  );
}

function PartialCard({ doc, guided, total, onViewChat, onContinue, onRerun }: Props & { guided: number; total: number }) {
  const run = doc.run;
  return (
    <section aria-label="Stack guide" style={{ ...amberBox, flex: "0 0 auto", padding: "12px 16px", display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
      <span style={head}><GuideIcon />Guide</span>
      <strong style={{ fontWeight: 600 }}>Guided {guided} of {total}</strong>
      <span style={{ color: run?.status === "error" ? "var(--bad-fg)" : "var(--muted)" }}>
        {run?.status === "error" ? run.error ?? "The run failed." : "Stopped before the last layer."} The layers already guided keep their guides.
      </span>
      <span className="spacer" />
      <button className="btn btn-sm" onClick={onViewChat}>View chat</button>
      <button className="btn btn-sm" onClick={onRerun}>Start over…</button>
      <button className="btn btn-sm btn-agent" style={{ fontWeight: 600 }} onClick={onContinue}>Continue</button>
    </section>
  );
}

