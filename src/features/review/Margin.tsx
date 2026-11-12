import { useState } from "react";
import type { DraftComment, Finding, ReviewThread } from "../../lib/model";
import { SEVERITY_STYLE, timeAgo } from "../../ui/bits";
import { Markdown } from "../../ui/Markdown";

type Props = {
  findings: Finding[];
  threads: ReviewThread[];
  drafts: DraftComment[];
  focusLine: number | null;
  onFocus: (line: number) => void;
  onFinding: (id: string, status: Finding["status"]) => void;
  onEditDraft: (id: string, body: string) => void;
  onRemoveDraft: (id: string) => void;
  onReply: (threadId: string, body: string) => Promise<void>;
  onResolve: (threadId: string, resolved: boolean) => Promise<void>;
};

type Note =
  | { kind: "finding"; line: number; f: Finding }
  | { kind: "thread"; line: number; t: ReviewThread }
  | { kind: "draft"; line: number; d: DraftComment };

export function Margin(p: Props) {
  const notes: Note[] = [
    ...p.findings.map((f) => ({ kind: "finding" as const, line: f.line, f })),
    ...p.threads.map((t) => ({ kind: "thread" as const, line: t.line ?? 0, t })),
    ...p.drafts.filter((d) => d.source === "me").map((d) => ({ kind: "draft" as const, line: d.line, d })),
  ].sort((a, b) => a.line - b.line);

  return (
    <aside aria-label="Notes on this file" className="scroll" style={{ height: "100%", padding: 10, display: "flex", flexDirection: "column", gap: 8 }}>
      <span className="label">In the margin</span>
      {notes.length === 0 && (
        <p className="muted" style={{ margin: 0, lineHeight: 1.5 }}>
          Nothing here yet. Click a line number, or press <span className="kbd">c</span> on a focused line, to comment.
        </p>
      )}
      {notes.map((n) =>
        n.kind === "finding" ? <FindingCard key={n.f.id} f={n.f} focused={p.focusLine === n.line} {...p} />
          : n.kind === "thread" ? <ThreadCard key={n.t.id} t={n.t} {...p} />
          : <DraftCard key={n.d.id} d={n.d} {...p} />,
      )}
    </aside>
  );
}

function LineButton({ line, onFocus, children }: { line: number; onFocus: (l: number) => void; children: React.ReactNode }) {
  return (
    <button onClick={() => onFocus(line)} style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap", padding: 0, border: 0, background: "transparent", textAlign: "left" }}>
      {children}
    </button>
  );
}

function FindingCard({ f, focused, onFocus, onFinding }: Props & { f: Finding; focused: boolean }) {
  const s = SEVERITY_STYLE[f.severity];
  return (
    <article style={{ padding: 10, borderRadius: 10, border: `1px solid ${focused ? s.fg : s.bd}`, background: focused ? "#1c1a17" : "#17181b", display: "flex", flexDirection: "column", gap: 6, opacity: f.status === "dismissed" ? 0.55 : 1 }}>
      <LineButton line={f.line} onFocus={onFocus}>
        <span className="pill" style={{ background: s.bg, color: s.fg, fontWeight: 600, fontSize: 11 }}>{f.severity}</span>
        <span className="mono muted" style={{ fontSize: 12 }}>L{f.line}</span>
        <span className="muted" style={{ fontSize: 12 }}>{f.agent}</span>
      </LineButton>
      <strong style={{ fontWeight: 600, lineHeight: 1.35 }}>{f.title}</strong>
      <Markdown text={f.body} compact />
      {f.suggestion && <div className="mono" style={{ fontSize: 11.5, padding: "6px 8px", borderRadius: 6, background: "var(--add-bg)", color: "var(--add-fg)", whiteSpace: "pre-wrap", wordBreak: "break-word" }}>+ {f.suggestion}</div>}
      {f.status === "open" ? (
        <div style={{ display: "flex", gap: 6 }}>
          <button className="btn btn-primary btn-sm" onClick={() => onFinding(f.id, "drafted")}>Draft</button>
          <button className="btn btn-sm" onClick={() => onFinding(f.id, "dismissed")}>Dismiss</button>
        </div>
      ) : (
        <div style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 12 }} className="muted">
          <span>{f.status === "drafted" ? "Draft comment added" : "Dismissed"}</span>
          <button className="btn btn-sm" onClick={() => onFinding(f.id, "open")}>Undo</button>
        </div>
      )}
    </article>
  );
}

function ThreadCard({ t, onFocus, onReply, onResolve }: Props & { t: ReviewThread }) {
  const [reply, setReply] = useState("");
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    try { await fn(); } finally { setBusy(false); }
  };
  return (
    <article style={{ padding: 10, borderRadius: 10, border: "1px solid #2a3a52", background: "#151a22", display: "flex", flexDirection: "column", gap: 6, lineHeight: 1.5, opacity: t.isResolved ? 0.6 : 1 }}>
      <LineButton line={t.line ?? 0} onFocus={onFocus}>
        <span className="mono muted" style={{ fontSize: 12 }}>L{t.line ?? "?"} · {t.isResolved ? "resolved" : t.isOutdated ? "outdated" : "open"} thread</span>
      </LineButton>
      {t.comments.map((c) => (
        <div key={c.id}>
          <strong>{c.author}</strong> <span className="muted" style={{ fontSize: 12 }}>{timeAgo(c.createdAt)}</span>
          <Markdown text={c.body} compact />
        </div>
      ))}
      {open && (
        <textarea className="input" rows={2} value={reply} onChange={(e) => setReply(e.target.value)} placeholder="Reply…" autoFocus aria-label="Reply" />
      )}
      <div style={{ display: "flex", gap: 6 }}>
        {open ? (
          <button className="btn btn-primary btn-sm" disabled={busy || !reply.trim()} onClick={() => run(async () => { await onReply(t.id, reply.trim()); setReply(""); setOpen(false); })}>Send reply</button>
        ) : (
          <button className="btn btn-sm" onClick={() => setOpen(true)}>Reply</button>
        )}
        <button className="btn btn-sm" disabled={busy} onClick={() => run(() => onResolve(t.id, !t.isResolved))}>{t.isResolved ? "Unresolve" : "Resolve"}</button>
      </div>
    </article>
  );
}

function DraftCard({ d, onFocus, onEditDraft, onRemoveDraft }: Props & { d: DraftComment }) {
  const [editing, setEditing] = useState(false);
  const [body, setBody] = useState(d.body);
  return (
    <article style={{ padding: 10, borderRadius: 10, border: "1px solid var(--accent-soft-bd)", background: "#141b26", display: "flex", flexDirection: "column", gap: 6 }}>
      <LineButton line={d.line} onFocus={onFocus}>
        <span className="mono muted" style={{ fontSize: 12 }}>L{d.line} · your draft</span>
      </LineButton>
      {editing ? (
        <textarea className="input" rows={3} value={body} onChange={(e) => setBody(e.target.value)} aria-label="Edit draft" />
      ) : (
        <Markdown text={d.body} compact />
      )}
      <div style={{ display: "flex", gap: 6 }}>
        {editing ? (
          <button className="btn btn-sm btn-primary" onClick={() => { onEditDraft(d.id, body); setEditing(false); }}>Save</button>
        ) : (
          <button className="btn btn-sm" onClick={() => setEditing(true)}>Edit</button>
        )}
        <button className="btn btn-sm" onClick={() => onRemoveDraft(d.id)}>Delete</button>
      </div>
    </article>
  );
}
