import { memo, useEffect, useMemo, useRef, useState } from "react";
import { parsePatch, toSplit, type DiffRow } from "../../lib/diff";
import type { DraftComment, FileChange, Finding, ReviewThread } from "../../lib/model";
import { SEVERITY_STYLE } from "../../ui/bits";

type Marks = { findings: Finding[]; threads: ReviewThread[]; drafts: DraftComment[] };

type Props = {
  file: FileChange;
  layout: "unified" | "split";
  marks: Marks;
  focusLine: number | null;
  composerLine: number | null;
  onFocusLine: (line: number) => void;
  onOpenComposer: (line: number) => void;
  onCloseComposer: () => void;
  onSaveComment: (line: number, body: string) => void;
};

const BIG = 2500;

function markColor(line: number | null, m: Marks): string | null {
  if (line == null) return null;
  const f = m.findings.find((x) => x.line === line && x.status !== "dismissed");
  if (f) return SEVERITY_STYLE[f.severity].fg;
  if (m.drafts.some((d) => d.line === line)) return "var(--accent)";
  if (m.threads.some((t) => t.line === line && !t.isResolved)) return "var(--accent-soft-fg)";
  return null;
}

export function DiffView(p: Props) {
  const rows = useMemo(() => parsePatch(p.file.patch), [p.file.patch]);
  const [showBig, setShowBig] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);

  useEffect(() => setShowBig(false), [p.file.path]);
  useEffect(() => {
    if (p.focusLine == null) return;
    const el = scroller.current?.querySelector(`[data-line="${p.focusLine}"]`);
    el?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [p.focusLine, p.file.path]);

  if (!p.file.patch) {
    return (
      <div className="empty">
        {p.file.status === "removed" ? "File deleted." : p.file.status === "renamed" && !p.file.additions && !p.file.deletions ? `Renamed from ${p.file.previousPath}.` : "No text diff (binary or too large for GitHub to show)."}
      </div>
    );
  }
  if (rows.length > BIG && !showBig) {
    return (
      <div className="empty">
        This diff has {rows.length.toLocaleString()} lines. <button className="btn btn-sm" onClick={() => setShowBig(true)}>Show it anyway</button>
      </div>
    );
  }
  return (
    <div ref={scroller} className="scroll" style={{ height: "100%", padding: "6px 0 24px", fontFamily: "var(--mono)", fontSize: 12.5, lineHeight: "21px" }}>
      {p.layout === "split" ? <Split rows={rows} {...p} /> : <Unified rows={rows} {...p} />}
    </div>
  );
}

const lineNo: React.CSSProperties = { flex: "0 0 46px", textAlign: "right", paddingRight: 8, color: "var(--faint)", userSelect: "none", border: 0, background: "transparent", font: "inherit", cursor: "pointer" };

const Unified = memo(function Unified({ rows, marks, focusLine, composerLine, onFocusLine, onOpenComposer, onCloseComposer, onSaveComment }: Props & { rows: DiffRow[] }) {
  return (
    <>
      {rows.map((r, i) => {
        if (r.kind === "hunk") return <div key={i} style={{ background: "var(--hunk-bg)", color: "var(--hunk-fg)", padding: "0 12px 0 108px", whiteSpace: "pre", overflow: "hidden", textOverflow: "ellipsis" }}>{r.header}</div>;
        if (r.kind === "note") return <div key={i} style={{ color: "var(--faint)", paddingLeft: 108 }}>{r.text}</div>;
        const bg = r.kind === "add" ? "var(--add-bg)" : r.kind === "del" ? "var(--del-bg)" : "transparent";
        const fg = r.kind === "add" ? "var(--add-fg)" : r.kind === "del" ? "var(--del-fg)" : "var(--text-2)";
        const focused = r.newLine != null && r.newLine === focusLine;
        const mark = markColor(r.newLine, marks);
        return (
          <div key={i}>
            <div
              data-line={r.newLine ?? undefined}
              onClick={() => r.newLine != null && onFocusLine(r.newLine)}
              style={{ display: "flex", background: focused ? "#2a2414" : bg, boxShadow: focused ? "inset 3px 0 0 var(--agent)" : undefined }}
            >
              <span style={lineNo}>{r.oldLine ?? ""}</span>
              <button
                style={lineNo}
                disabled={r.newLine == null}
                aria-label={r.newLine != null ? `Comment on line ${r.newLine}` : undefined}
                title={r.newLine != null ? "Comment on this line (c)" : undefined}
                onClick={(e) => { e.stopPropagation(); if (r.newLine != null) onOpenComposer(r.newLine); }}
              >
                {r.newLine ?? ""}
              </button>
              <span style={{ flex: "0 0 14px", color: mark ?? "transparent" }} aria-hidden="true">●</span>
              <span style={{ flex: "0 0 16px", color: r.kind === "add" ? "var(--ok)" : r.kind === "del" ? "var(--bad)" : "transparent" }} aria-hidden="true">{r.kind === "add" ? "+" : r.kind === "del" ? "−" : " "}</span>
              <span style={{ flex: "1 1 auto", whiteSpace: "pre", color: fg, paddingRight: 16 }}>{r.text}</span>
            </div>
            {composerLine != null && r.newLine === composerLine && <Composer line={composerLine} onCancel={onCloseComposer} onSave={onSaveComment} indent={108} />}
          </div>
        );
      })}
    </>
  );
});

const Split = memo(function Split({ rows, marks, focusLine, composerLine, onFocusLine, onOpenComposer, onCloseComposer, onSaveComment }: Props & { rows: DiffRow[] }) {
  const split = useMemo(() => toSplit(rows), [rows]);
  return (
    <>
      {split.map((r, i) => {
        if (r.kind === "hunk") return <div key={i} style={{ background: "var(--hunk-bg)", color: "var(--hunk-fg)", padding: "0 12px 0 60px", whiteSpace: "pre", overflow: "hidden" }}>{r.header}</div>;
        const right = r.right;
        const focused = right != null && right.line === focusLine;
        const mark = markColor(right?.line ?? null, marks);
        return (
          <div key={i}>
            <div data-line={right?.line} style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) minmax(0,1fr)", boxShadow: focused ? "inset 3px 0 0 var(--agent)" : undefined }}>
              <div style={{ display: "flex", background: r.left?.kind === "del" ? "var(--del-bg)" : "transparent", borderRight: "1px solid var(--border)", overflow: "hidden" }}>
                <span style={lineNo}>{r.left?.line ?? ""}</span>
                <span style={{ flex: "1 1 auto", whiteSpace: "pre", color: r.left?.kind === "del" ? "var(--del-fg)" : "var(--text-2)", overflow: "hidden" }}>{r.left?.text ?? ""}</span>
              </div>
              <div onClick={() => right && onFocusLine(right.line)} style={{ display: "flex", background: focused ? "#2a2414" : right?.kind === "add" ? "var(--add-bg)" : "transparent", overflow: "hidden" }}>
                <button style={lineNo} disabled={!right} onClick={(e) => { e.stopPropagation(); if (right) onOpenComposer(right.line); }} aria-label={right ? `Comment on line ${right.line}` : undefined}>{right?.line ?? ""}</button>
                <span style={{ flex: "0 0 12px", color: mark ?? "transparent" }} aria-hidden="true">●</span>
                <span style={{ flex: "1 1 auto", whiteSpace: "pre", color: right?.kind === "add" ? "var(--add-fg)" : "var(--text-2)", overflow: "hidden" }}>{right?.text ?? ""}</span>
              </div>
            </div>
            {composerLine != null && right?.line === composerLine && <Composer line={composerLine} onCancel={onCloseComposer} onSave={onSaveComment} indent={60} />}
          </div>
        );
      })}
    </>
  );
});

function Composer({ line, onCancel, onSave, indent }: { line: number; onCancel: () => void; onSave: (line: number, body: string) => void; indent: number }) {
  const [body, setBody] = useState("");
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => ref.current?.focus(), []);
  const save = () => body.trim() && onSave(line, body.trim());
  return (
    <div style={{ margin: `6px 16px 10px ${indent}px`, padding: 12, borderRadius: 10, border: "1px solid var(--accent-soft-bd)", background: "var(--surface-2)", fontFamily: "var(--sans)", display: "flex", flexDirection: "column", gap: 8 }}>
      <label htmlFor={`c-${line}`} className="muted" style={{ fontSize: 12 }}>Comment on line {line} · added to your pending review</label>
      <textarea
        id={`c-${line}`}
        ref={ref}
        className="input"
        rows={3}
        value={body}
        onChange={(e) => setBody(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") onCancel();
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) save();
        }}
        placeholder="Markdown supported. Use ```suggestion to propose a change."
      />
      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <button className="btn btn-primary btn-sm" onClick={save} disabled={!body.trim()}>Add draft</button>
        <button className="btn btn-sm" onClick={onCancel}>Cancel</button>
        <button className="btn btn-sm" onClick={() => setBody((b) => `${b}${b ? "\n" : ""}\`\`\`suggestion\n\n\`\`\``)}>Insert suggestion</button>
        <span className="muted" style={{ fontSize: 12 }}><span className="kbd">⌘↵</span> to add</span>
      </div>
    </div>
  );
}
