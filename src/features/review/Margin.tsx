import { useState } from "react";
import type { DraftComment, Finding, ReviewThread } from "../../lib/model";
import { timeAgo } from "../../ui/bits";
import { DraftEditor, FindingCard } from "./Notes";
import { Markdown } from "../../ui/Markdown";

type Props = {
  findings: Finding[];
  threads: ReviewThread[];
  drafts: DraftComment[];
  focusLine: number | null;
  onFocus: (line: number) => void;
  onFinding: (id: string, status: Finding["status"], body?: string) => void;
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
        n.kind === "finding" ? (
          <FindingCard
            key={n.f.id}
            f={n.f}
            draft={p.drafts.find((d) => d.findingId === n.f.id)}
            focused={p.focusLine === n.line}
            onJump={() => p.onFocus(n.f.line)}
            onDraft={(body) => p.onFinding(n.f.id, "drafted", body)}
            onDismiss={() => p.onFinding(n.f.id, "dismissed")}
            onReopen={() => p.onFinding(n.f.id, "open")}
            onEditDraft={p.onEditDraft}
          />
        )
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
  return (
    <article style={{ padding: 10, borderRadius: 10, border: "1px solid var(--accent-soft-bd)", background: "#141b26", display: "flex", flexDirection: "column", gap: 6 }}>
      <LineButton line={d.line} onFocus={onFocus}>
        <span className="mono muted" style={{ fontSize: 12 }}>L{d.line} · your draft</span>
      </LineButton>
      {editing ? (
        <DraftEditor initial={d.body} onCancel={() => setEditing(false)} onSave={(body) => { onEditDraft(d.id, body); setEditing(false); }} />
      ) : (
        <>
          <Markdown text={d.body} compact />
          <div style={{ display: "flex", gap: 6 }}>
            <button className="btn btn-sm" onClick={() => setEditing(true)}>Edit</button>
            <button className="btn btn-sm" onClick={() => onRemoveDraft(d.id)}>Delete</button>
          </div>
        </>
      )}
    </article>
  );
}
