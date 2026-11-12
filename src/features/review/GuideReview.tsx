// The guide on the review page: the one-line guide row in the brief card, the Focus checklist in
// the sidebar, and the label row that opens each focus range in the diff.

import { useEffect, useRef, useState } from "react";
import { rangeLabel } from "../../lib/diff";
import { rankLabel, TIER_WORD, type FocusArea, type LayerGuide } from "../../lib/guide";
import { TierLabel } from "../../ui/guide";

export type FocusItem = FocusArea & { n: number; done: boolean };

const base = (p: string) => p.split("/").pop() ?? p;
export const focusWhere = (f: FocusArea) => `${base(f.path)} ${rangeLabel(f.line, f.startLine)}`;

/** One guide line in the brief card: tier, rank, reason, skim files and the author questions. */
export function GuideLine({ guide, rank, stale, onSkim, questions, askedQuestions, onAsk }: {
  guide: LayerGuide;
  rank: { rank: number; of: number } | null;
  stale: boolean;
  onSkim: (path: string) => void;
  questions: string[];
  askedQuestions: Set<string>;
  onAsk: (q: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const pop = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!open) return;
    const key = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    const click = (e: MouseEvent) => !pop.current?.contains(e.target as Node) && setOpen(false);
    window.addEventListener("keydown", key);
    window.addEventListener("mousedown", click);
    return () => { window.removeEventListener("keydown", key); window.removeEventListener("mousedown", click); };
  }, [open]);
  const skim = guide.skim.slice(0, 3);
  return (
    <div role="group" aria-label="Guide" style={{ position: "relative", display: "flex", flexWrap: "wrap", gap: "4px 12px", alignItems: "center", padding: "7px 10px", borderRadius: 8, border: "1px solid var(--agent-bd)", background: "var(--agent-bg)" }}>
      <TierLabel tier={guide.tier} rank={rank} stale={stale} word={false} />
      <strong style={{ color: "var(--agent)", fontWeight: 600 }}>{TIER_WORD[guide.tier]}{rank ? ` · ${rank.rank === 1 ? `hardest of ${rank.of}` : rankLabel(rank)}` : ""}</strong>
      <span style={{ color: "var(--text-2)", minWidth: 0, flex: "1 1 240px" }}>{guide.tierReason}</span>
      {skim.length > 0 && (
        <span style={{ display: "inline-flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
          <span className="muted">Skim</span>
          {skim.map((s) => <button key={s.path} className="btn btn-chip mono" style={{ padding: "1px 8px" }} title={`${s.path}: ${s.why}`} onClick={() => onSkim(s.path)}>{base(s.path)}</button>)}
          {guide.skim.length > skim.length && <span className="muted">+{guide.skim.length - skim.length}</span>}
        </span>
      )}
      {questions.length > 0 && (
        <span ref={pop} style={{ position: "relative" }}>
          <button className="btn btn-sm btn-agent" aria-expanded={open} onClick={() => setOpen((o) => !o)}>{questions.length} {questions.length === 1 ? "question" : "questions"} for the author</button>
          {open && (
            <div role="dialog" aria-label="Questions for the author" style={{ position: "absolute", top: "calc(100% + 6px)", left: 0, zIndex: 15, width: 420, maxWidth: "80vw", padding: 12, display: "flex", flexDirection: "column", gap: 10, borderRadius: 10, border: "1px solid var(--agent-bd)", background: "var(--surface)", boxShadow: "0 12px 32px rgba(0,0,0,.45)" }}>
              <span className="label" style={{ color: "var(--agent)" }}>Questions the diff doesn't answer</span>
              {questions.map((q) => (
                <div key={q} style={{ display: "flex", gap: 10, alignItems: "flex-start" }}>
                  <span style={{ flex: "1 1 auto", lineHeight: 1.5, color: "var(--text-2)" }}>{q}</span>
                  <button className="btn btn-sm" disabled={askedQuestions.has(q)} onClick={() => onAsk(q)} title="Adds the question to your pending review summary (nothing is posted until you submit)">{askedQuestions.has(q) ? "Added ✓" : "Ask in a comment"}</button>
                </div>
              ))}
              <span className="faint" style={{ fontSize: 12 }}>Adds a draft to your pending review. Nothing is posted until you submit.</span>
              <button className="btn btn-sm" style={{ alignSelf: "flex-end" }} onClick={() => setOpen(false)}>Close</button>
            </div>
          )}
        </span>
      )}
    </div>
  );
}

/** The sidebar checklist between the stack rail and the file list. */
export function FocusChecklist({ items, stale, onJump, onTick }: { items: FocusItem[]; stale: boolean; onJump: (f: FocusItem) => void; onTick: (f: FocusItem) => void }) {
  const done = items.filter((i) => i.done).length;
  return (
    <section aria-label="Focus areas" style={{ flex: "0 1 auto", maxHeight: "32%", minHeight: 0, display: "flex", flexDirection: "column", borderTop: "1px solid var(--border)" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", padding: "10px 14px 4px" }}>
        <span className="label" style={{ color: "var(--agent)" }}>Focus{stale ? " · out of date" : ""}</span>
        <span className="muted" style={{ fontSize: 12 }}>{done} of {items.length}</span>
      </div>
      <div className="scroll" style={{ display: "flex", flexDirection: "column", gap: 1, padding: "0 8px 8px" }}>
        {items.map((f) => (
          <div key={f.id} style={{ display: "flex", alignItems: "flex-start", gap: 8, padding: "4px 6px", borderRadius: 6 }}>
            <input type="checkbox" checked={f.done} onChange={() => onTick(f)} aria-label={`Tick focus area: ${f.title}`} style={{ accentColor: "var(--agent)", margin: "3px 0 0" }} />
            <button onClick={() => onJump(f)} title={`${f.title}: ${f.why}`} style={{ flex: "1 1 auto", minWidth: 0, textAlign: "left", padding: 0, border: 0, background: "transparent", display: "flex", flexDirection: "column", color: f.done ? "var(--muted)" : "var(--text)" }}>
              <span style={{ textDecoration: f.done ? "line-through" : undefined, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{f.title}</span>
              <span className="mono faint" style={{ fontSize: 11, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{focusWhere(f)}</span>
            </button>
          </div>
        ))}
      </div>
    </section>
  );
}

/** Opens each focus range in the diff: "Focus N", the title, the why, and a Tick. */
export function FocusLabelRow({ f, indent, onTick }: { f: FocusItem; indent: number; onTick: (id: string) => void }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10, padding: `5px 14px 5px ${indent}px`, background: "var(--agent-bg)", borderTop: "1px solid var(--agent-bd)", borderBottom: "1px solid var(--agent-bd)", fontFamily: "var(--sans)", fontSize: 12.5, lineHeight: 1.4, opacity: f.done ? 0.6 : 1 }}>
      <span className="pill" style={{ background: "transparent", border: "1px solid var(--agent-bd)", color: "var(--agent)", fontWeight: 600, fontSize: 11 }}>Focus {f.n}</span>
      <strong style={{ color: "var(--agent)", fontWeight: 600, flex: "0 0 auto", textDecoration: f.done ? "line-through" : undefined }}>{f.title}</strong>
      <span style={{ color: "var(--text-2)", flex: "1 1 auto", minWidth: 0 }}>— {f.why}</span>
      <button className="btn btn-sm" style={f.done ? undefined : { borderColor: "var(--agent-bd)", color: "var(--agent)" }} aria-pressed={f.done} onClick={() => onTick(f.id)}>{f.done ? "Ticked ✓" : "Tick"}</button>
    </div>
  );
}

