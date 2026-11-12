import { useState } from "react";
import type { DraftComment, Finding, Severity } from "../../lib/model";
import { Modal } from "./Dialogs";
import { FindingCard } from "./Notes";

type Filter = "open" | "drafted" | "dismissed" | "all";
const SEV_ORDER: Record<Severity, number> = { High: 0, Medium: 1, Low: 2 };
const STATUS_ORDER: Record<Finding["status"], number> = { open: 0, drafted: 1, dismissed: 2 };

/** Every agent finding on the layer, across files, for triage in one place. */
export function FindingsPanel({
  pr, findings, drafts, fileOrder, onJump, onStatus, onEditDraft, onClose,
}: {
  pr: number;
  findings: Finding[];
  drafts: DraftComment[];
  fileOrder: string[];
  onJump: (f: Finding) => void;
  onStatus: (id: string, status: Finding["status"], body?: string) => void;
  onEditDraft: (draftId: string, body: string) => void;
  onClose: () => void;
}) {
  const counts = {
    open: findings.filter((f) => f.status === "open").length,
    drafted: findings.filter((f) => f.status === "drafted").length,
    dismissed: findings.filter((f) => f.status === "dismissed").length,
    all: findings.length,
  };
  const [filter, setFilter] = useState<Filter>(counts.open ? "open" : "all");
  const rank = (p: string) => {
    const i = fileOrder.indexOf(p);
    return i < 0 ? 999 : i;
  };
  const shown = findings
    .filter((f) => filter === "all" || f.status === filter)
    .sort((a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status] || SEV_ORDER[a.severity] - SEV_ORDER[b.severity] || rank(a.path) - rank(b.path) || a.line - b.line);
  const openLow = findings.filter((f) => f.status === "open" && f.severity === "Low");

  return (
    <Modal label={`Findings on #${pr}`} onClose={onClose} width={720}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <strong style={{ fontSize: 15 }}>Findings on #{pr}</strong>
        <div role="tablist" aria-label="Filter findings" style={{ display: "flex", gap: 2 }}>
          {(["open", "drafted", "dismissed", "all"] as Filter[]).map((k) => (
            <button key={k} role="tab" aria-selected={filter === k} onClick={() => setFilter(k)} style={{ padding: "3px 9px", borderRadius: 6, border: 0, fontSize: 12, textTransform: "capitalize", background: filter === k ? "#232a35" : "transparent", color: filter === k ? "var(--text)" : "var(--muted)" }}>
              {k} · {counts[k]}
            </button>
          ))}
        </div>
        <span className="spacer" />
        {openLow.length > 1 && (
          <button className="btn btn-sm" onClick={() => openLow.forEach((f) => onStatus(f.id, "dismissed"))} title="Dismiss every open Low-severity finding">Dismiss {openLow.length} Low</button>
        )}
      </div>
      <p className="muted" style={{ margin: 0, fontSize: 12 }}>Open findings first, then by severity and reading order. Drafted findings become comments when you submit; the rest stay private.</p>
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {shown.length === 0 && <p className="muted" style={{ margin: 0 }}>{findings.length ? "Nothing in this view." : "The agent hasn't recorded any findings on this layer yet."}</p>}
        {shown.map((f) => (
          <FindingCard
            key={f.id}
            f={f}
            showPath
            draft={drafts.find((d) => d.findingId === f.id)}
            onJump={() => onJump(f)}
            onDraft={(body) => onStatus(f.id, "drafted", body)}
            onDismiss={() => onStatus(f.id, "dismissed")}
            onReopen={() => onStatus(f.id, "open")}
            onEditDraft={onEditDraft}
          />
        ))}
      </div>
    </Modal>
  );
}
