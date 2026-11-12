// Shared pieces for review notes: the draft editor and the agent finding card. Used in the margin,
// the findings list and the finish dialog.

import { useEffect, useRef, useState } from "react";
import type { DraftComment, Finding } from "../../lib/model";
import { findingDraftBody } from "../../lib/reviewStore";
import { SEVERITY_STYLE } from "../../ui/bits";
import { Markdown } from "../../ui/Markdown";

export function DraftEditor({ initial, saveLabel = "Save", onSave, onCancel }: { initial: string; saveLabel?: string; onSave: (body: string) => void; onCancel: () => void }) {
  const [body, setBody] = useState(initial);
  const [preview, setPreview] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const t = ref.current;
    if (!t) return;
    t.focus();
    t.setSelectionRange(t.value.length, t.value.length);
  }, []);
  const save = () => body.trim() && onSave(body.trim());
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <div role="tablist" aria-label="Editor mode" style={{ display: "flex", gap: 2 }}>
        {(["Write", "Preview"] as const).map((m) => {
          const sel = (m === "Preview") === preview;
          return (
            <button key={m} role="tab" aria-selected={sel} onClick={() => setPreview(m === "Preview")} style={{ padding: "2px 8px", borderRadius: 6, border: 0, fontSize: 12, background: sel ? "#232a35" : "transparent", color: sel ? "var(--text)" : "var(--muted)" }}>{m}</button>
          );
        })}
      </div>
      {preview ? (
        <div style={{ minHeight: 70, padding: "6px 8px", borderRadius: 8, border: "1px solid var(--border-strong)", background: "var(--surface-2)" }}>
          {body.trim() ? <Markdown text={body} compact /> : <span className="muted">Nothing to preview.</span>}
        </div>
      ) : (
        <textarea
          ref={ref}
          className="input"
          rows={Math.min(12, Math.max(4, body.split("\n").length + 1))}
          value={body}
          onChange={(e) => setBody(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") onCancel();
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) save();
          }}
          aria-label="Comment text"
          style={{ fontSize: 12.5 }}
        />
      )}
      <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
        <button className="btn btn-sm btn-primary" disabled={!body.trim()} onClick={save}>{saveLabel}</button>
        <button className="btn btn-sm" onClick={onCancel}>Cancel</button>
        <span className="muted" style={{ fontSize: 11 }}><span className="kbd">⌘↵</span> save</span>
      </div>
    </div>
  );
}

type FindingCardProps = {
  f: Finding;
  /** The pending comment this finding became, if drafted. */
  draft?: DraftComment;
  focused?: boolean;
  /** Show the file path (in lists that span files). */
  showPath?: boolean;
  onJump: () => void;
  onDraft: (body?: string) => void;
  onDismiss: () => void;
  onReopen: () => void;
  onEditDraft: (draftId: string, body: string) => void;
};

export function FindingCard({ f, draft, focused, showPath, onJump, onDraft, onDismiss, onReopen, onEditDraft }: FindingCardProps) {
  const s = SEVERITY_STYLE[f.severity];
  const [editing, setEditing] = useState(false);
  return (
    <article style={{ padding: 10, borderRadius: 10, border: `1px solid ${focused ? s.fg : s.bd}`, background: focused ? "#1c1a17" : "#17181b", display: "flex", flexDirection: "column", gap: 6, opacity: f.status === "dismissed" ? 0.55 : 1 }}>
      <button onClick={onJump} title="Show in the diff" style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap", padding: 0, border: 0, background: "transparent", textAlign: "left" }}>
        <span className="pill" style={{ background: s.bg, color: s.fg, fontWeight: 600, fontSize: 11 }}>{f.severity}</span>
        <span className="mono muted" style={{ fontSize: 12 }}>{showPath ? `${f.path.split("/").pop()}:${f.line}` : `L${f.line}`}</span>
        <span className="muted" style={{ fontSize: 12 }}>{f.agent}</span>
        {f.status === "drafted" && <span className="pill" style={{ fontSize: 11, background: "var(--accent-soft-bg)", color: "var(--accent-soft-fg)" }}>drafted</span>}
      </button>
      <strong style={{ fontWeight: 600, lineHeight: 1.35 }}>{f.title}</strong>

      {editing ? (
        <DraftEditor
          initial={draft?.body ?? findingDraftBody(f)}
          saveLabel={draft ? "Save draft" : "Save as draft"}
          onCancel={() => setEditing(false)}
          onSave={(body) => {
            if (draft) onEditDraft(draft.id, body);
            else onDraft(body);
            setEditing(false);
          }}
        />
      ) : f.status === "drafted" && draft ? (
        <div style={{ padding: "6px 8px", borderRadius: 8, border: "1px solid var(--accent-soft-bd)", background: "#141b26" }}>
          <span className="label" style={{ fontSize: 10 }}>Pending comment</span>
          <Markdown text={draft.body} compact />
        </div>
      ) : (
        <>
          <Markdown text={f.body} compact />
          {f.suggestion && <div className="mono" style={{ fontSize: 11.5, padding: "6px 8px", borderRadius: 6, background: "var(--add-bg)", color: "var(--add-fg)", whiteSpace: "pre-wrap", wordBreak: "break-word" }}>+ {f.suggestion}</div>}
        </>
      )}

      {!editing && (
        <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
          {f.status === "open" && (
            <>
              <button className="btn btn-primary btn-sm" onClick={() => onDraft()}>Draft</button>
              <button className="btn btn-sm" onClick={() => setEditing(true)}>Edit…</button>
              <button className="btn btn-sm" onClick={onDismiss}>Dismiss</button>
            </>
          )}
          {f.status === "drafted" && (
            <>
              <button className="btn btn-sm" onClick={() => setEditing(true)}>Edit</button>
              <button className="btn btn-sm" onClick={onReopen} title="Remove the pending comment and put the finding back">Undo</button>
            </>
          )}
          {f.status === "dismissed" && (
            <>
              <span className="muted" style={{ fontSize: 12 }}>Dismissed</span>
              <button className="btn btn-sm" onClick={onReopen}>Undo</button>
            </>
          )}
        </div>
      )}
    </article>
  );
}
