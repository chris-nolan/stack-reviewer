import { memo, useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useSource } from "../../app/session";
import { clampRange, newSideLines, parsePatch, suggestionBlock, type DiffRow } from "../../lib/diff";
import { buildDisplayRows, segments, sidesFromPatch, toSplitRows, type CodeRow, type DisplayRow, type Expansions, type GapRow, type SplitDisplayRow } from "../../lib/diffModel";
import { tokenize, type LineTokens } from "../../lib/highlight";
import type { DraftComment, FileChange, Finding, RepoRef, ReviewThread } from "../../lib/model";
import { repoKey } from "../../lib/model";
import { SEVERITY_STYLE } from "../../ui/bits";
import { DraftEditor } from "./Notes";

type Marks = { findings: Finding[]; threads: ReviewThread[]; drafts: DraftComment[] };

type Props = {
  repo: RepoRef;
  file: FileChange;
  /** Commits the diff is between: the new side at `newRef`, the old side at `oldRef`. */
  newRef: string;
  oldRef?: string;
  layout: "unified" | "split";
  marks: Marks;
  focusLine: number | null;
  /** The lines the open composer is commenting on. */
  composer: { start: number; end: number } | null;
  /** Line that starts a range when shift-clicking (the last plainly-selected line). */
  anchorLine: number | null;
  onFocusLine: (line: number) => void;
  onOpenComposer: (start: number, end: number) => void;
  onCloseComposer: () => void;
  onSaveComment: (start: number, end: number, body: string) => void;
};

const ROW = 21;
const GUTTER = 46;

function markColor(line: number | null, m: Marks): string | null {
  if (line == null) return null;
  const f = m.findings.find((x) => x.line === line && x.status !== "dismissed");
  if (f) return SEVERITY_STYLE[f.severity].fg;
  if (m.drafts.some((d) => line >= (d.startLine ?? d.line) && line <= d.line)) return "var(--accent)";
  if (m.threads.some((t) => t.line === line && !t.isResolved)) return "var(--accent-soft-fg)";
  return null;
}

/** Full file text for each side (when available) plus syntax colours for both sides. */
function useSides(repo: RepoRef, file: FileChange, newRef: string, oldRef: string | undefined) {
  const source = useSource();
  const rows = useMemo(() => parsePatch(file.patch), [file.patch]);
  const newPath = file.path;
  const oldPath = file.previousPath ?? file.path;
  const newText = useQuery({
    queryKey: ["fileText", source.kind, repoKey(repo), newRef, newPath],
    queryFn: () => (file.status === "removed" ? null : source.fileText(repo, newRef, newPath)),
    staleTime: Infinity,
    enabled: !!file.patch,
  });
  const oldText = useQuery({
    queryKey: ["fileText", source.kind, repoKey(repo), oldRef, oldPath],
    queryFn: () => (file.status === "added" || !oldRef ? null : source.fileText(repo, oldRef, oldPath)),
    staleTime: Infinity,
    enabled: !!file.patch,
  });

  // Only trust a fetched file if it agrees with the patch (the old side may be at a different
  // commit than the PR's merge base if the base branch moved).
  const newLines = useMemo(() => {
    const lines = newText.data?.split(/\r?\n/) ?? null;
    if (!lines) return null;
    const ok = rows.every((r) => !(r.kind === "add" || r.kind === "ctx") || lines[r.newLine! - 1] === r.text);
    return ok ? lines : null;
  }, [newText.data, rows]);
  const oldLines = useMemo(() => {
    const lines = oldText.data?.split(/\r?\n/) ?? null;
    if (!lines) return null;
    const ok = rows.every((r) => !(r.kind === "del" || r.kind === "ctx") || lines[r.oldLine! - 1] === r.text);
    return ok ? lines : null;
  }, [oldText.data, rows]);

  const colours = useQuery({
    queryKey: ["tokens", file.path, file.patch?.length, !!newLines, !!oldLines, newRef, oldRef],
    enabled: !!file.patch && !newText.isPending && !oldText.isPending,
    staleTime: Infinity,
    queryFn: async () => {
      const fromPatch = sidesFromPatch(rows);
      const [n, o] = await Promise.all([
        tokenize(newLines ? newLines.join("\n") : fromPatch.newText, file.path),
        tokenize(oldLines ? oldLines.join("\n") : fromPatch.oldText, oldPath),
      ]);
      const pick = (tokens: LineTokens[] | null, full: boolean, index: Map<number, number>) => (line: number | null) =>
        line == null || !tokens ? undefined : full ? tokens[line - 1] : tokens[index.get(line) ?? -1];
      return { newAt: pick(n, !!newLines, fromPatch.newIndex), oldAt: pick(o, !!oldLines, fromPatch.oldIndex) };
    },
  });
  return { rows, newLines, colours: colours.data };
}

export function DiffView(p: Props) {
  const { rows, newLines, colours } = useSides(p.repo, p.file, p.newRef, p.oldRef);
  const [expansions, setExpansions] = useState<Expansions>({});
  useEffect(() => setExpansions({}), [p.file.path, p.newRef]);
  const display = useMemo(() => buildDisplayRows(rows, newLines, expansions), [rows, newLines, expansions]);

  // Dragging across line numbers previews a range; releasing opens the composer on it.
  const [drag, setDrag] = useState<{ anchor: number; end: number } | null>(null);
  const dragRef = useRef(drag);
  dragRef.current = drag;
  const latest = useRef(p);
  latest.current = p;
  const rowsRef = useRef(rows);
  rowsRef.current = rows;
  useEffect(() => {
    const up = () => {
      const d = dragRef.current;
      if (!d) return;
      setDrag(null);
      if (d.anchor !== d.end) {
        const r = clampRange(rowsRef.current, d.anchor, d.end);
        latest.current.onOpenComposer(r.start, r.end);
      }
    };
    window.addEventListener("mouseup", up);
    return () => window.removeEventListener("mouseup", up);
  }, []);
  const dragHandlers = {
    onLineDown: (line: number) => setDrag({ anchor: line, end: line }),
    onLineEnter: (line: number) => setDrag((d) => (d && d.end !== line ? { ...d, end: line } : d)),
    onLineClick: (line: number, shift: boolean) => {
      if (shift && p.anchorLine != null && p.anchorLine !== line) {
        const r = clampRange(rows, p.anchorLine, line);
        p.onFocusLine(line);
        p.onOpenComposer(r.start, r.end);
      } else p.onOpenComposer(line, line);
    },
  };
  const sel = drag ? clampRange(rows, drag.anchor, drag.end) : p.composer;

  if (!p.file.patch) {
    return (
      <div className="empty">
        {p.file.status === "removed" ? "File deleted." : p.file.status === "renamed" && !p.file.additions && !p.file.deletions ? `Renamed from ${p.file.previousPath}.` : "No text diff (binary or too large for GitHub to show)."}
      </div>
    );
  }
  const expand = (gap: GapRow, dir: "up" | "down" | "all") =>
    setExpansions((e) => {
      const cur = e[gap.id] ?? { fromTop: 0, fromBottom: 0 };
      const size = gap.newTo - gap.newFrom + 1;
      const next = dir === "all" ? { fromTop: cur.fromTop + size, fromBottom: cur.fromBottom } : dir === "down" ? { ...cur, fromTop: cur.fromTop + 20 } : { ...cur, fromBottom: cur.fromBottom + 20 };
      return { ...e, [gap.id]: next };
    });
  const common = { ...p, colours, expand, patchRows: rows, sel, drag, ...dragHandlers };
  // A file that was only added or only deleted has nothing to compare side by side.
  const split = p.layout === "split" && p.file.status !== "added" && p.file.status !== "removed";
  return split ? <SplitList rows={toSplitRows(display)} {...common} /> : <UnifiedList rows={display} {...common} />;
}

type ListProps = Props & {
  colours?: { newAt: (l: number | null) => LineTokens | undefined; oldAt: (l: number | null) => LineTokens | undefined };
  expand: (gap: GapRow, dir: "up" | "down" | "all") => void;
  patchRows: DiffRow[];
  /** Highlighted lines: the drag in progress, else the open composer's. */
  sel: { start: number; end: number } | null;
  drag: { anchor: number; end: number } | null;
  onLineDown: (line: number) => void;
  onLineEnter: (line: number) => void;
  onLineClick: (line: number, shift: boolean) => void;
};

type Item<R> = { kind: "row"; row: R } | { kind: "composer"; line: number };

function useList<R>(rows: R[], lineOf: (r: R) => number | null, composerEnd: number | null, focusLine: number | null, path: string) {
  const items = useMemo(() => {
    const out: Item<R>[] = [];
    for (const r of rows) {
      out.push({ kind: "row", row: r });
      if (composerEnd != null && lineOf(r) === composerEnd) out.push({ kind: "composer", line: composerEnd });
    }
    return out;
  }, [rows, composerEnd, lineOf]);
  const scroller = useRef<HTMLDivElement>(null);
  const v = useVirtualizer({
    count: items.length,
    getScrollElement: () => scroller.current,
    estimateSize: (i) => (items[i].kind === "composer" ? 150 : (items[i] as { row: { kind: string } }).row.kind === "gap" ? 30 : ROW),
    overscan: 40,
  });
  useEffect(() => {
    if (focusLine == null) return;
    const idx = items.findIndex((it) => it.kind === "row" && lineOf(it.row) === focusLine);
    if (idx >= 0) v.scrollToIndex(idx, { align: "center" });
  }, [focusLine, path]);
  useEffect(() => {
    scroller.current?.scrollTo({ top: 0 });
  }, [path]);
  return { items, scroller, v };
}

const SEL_BG = "rgba(90, 140, 255, .16)";

const lineNoStyle: React.CSSProperties = { flex: `0 0 ${GUTTER}px`, textAlign: "right", paddingRight: 8, color: "var(--faint)", userSelect: "none", border: 0, background: "transparent", font: "inherit", cursor: "pointer" };

function Code({ row, tokens }: { row: CodeRow; tokens?: LineTokens }) {
  const segs = segments(row.text, tokens, row.changes);
  const fallback = row.kind === "add" ? "var(--add-fg)" : row.kind === "del" ? "var(--del-fg)" : "var(--text-2)";
  const changedBg = row.kind === "add" ? "rgba(70, 190, 110, .32)" : "rgba(255, 110, 100, .32)";
  return (
    <>
      {segs.map((s, i) => (
        <span key={i} style={{ color: s.color ?? fallback, background: s.changed ? changedBg : undefined, borderRadius: s.changed ? 2 : undefined }}>{s.text}</span>
      ))}
    </>
  );
}

function GapLine({ gap, expand, indent }: { gap: GapRow; expand: ListProps["expand"]; indent: number }) {
  const n = gap.newTo - gap.newFrom + 1;
  return (
    <div style={{ height: 30, display: "flex", alignItems: "center", gap: 8, paddingLeft: indent, background: "#12161d", borderTop: "1px solid var(--border)", borderBottom: "1px solid var(--border)", fontFamily: "var(--sans)", fontSize: 12 }}>
      <span className="muted">⋯ {n} unchanged {n === 1 ? "line" : "lines"}</span>
      {gap.expandable ? (
        <>
          {gap.position !== "bottom" && n > 20 && <button className="btn btn-sm" onClick={() => expand(gap, "up")} title="Show 20 more lines above the next change">↑ 20</button>}
          <button className="btn btn-sm" onClick={() => expand(gap, "all")}>Show {n > 20 ? "all" : n === 1 ? "it" : "them"}</button>
          {gap.position !== "top" && n > 20 && <button className="btn btn-sm" onClick={() => expand(gap, "down")} title="Show 20 more lines below the previous change">↓ 20</button>}
        </>
      ) : (
        <span className="faint">(full file unavailable)</span>
      )}
    </div>
  );
}

const unifiedLine = (r: DisplayRow) => (r.kind === "add" || r.kind === "ctx" ? r.newLine : null);

const UnifiedList = memo(function UnifiedList(p: ListProps & { rows: DisplayRow[] }) {
  const { items, scroller, v } = useList(p.rows, unifiedLine, p.composer?.end ?? null, p.focusLine, p.file.path);
  const widthCh = useMemo(() => p.rows.reduce((m, r) => ("text" in r ? Math.max(m, r.text.length) : m), 40), [p.rows]);
  return (
    <div ref={scroller} className="scroll" style={{ height: "100%", fontFamily: "var(--mono)", fontSize: 12.5, lineHeight: `${ROW}px`, tabSize: 4 }}>
      <div style={{ height: v.getTotalSize(), position: "relative", minWidth: `calc(${widthCh + 4}ch + ${GUTTER * 2 + 32}px)` }}>
        {v.getVirtualItems().map((vi) => {
          const it = items[vi.index];
          return (
            <div key={vi.key} data-index={vi.index} ref={v.measureElement} style={{ position: "absolute", top: 0, left: 0, right: 0, transform: `translateY(${vi.start}px)` }}>
              {it.kind === "composer" ? (
                <Composer range={p.composer} rows={p.patchRows} onCancel={p.onCloseComposer} onSave={p.onSaveComment} indent={GUTTER * 2 + 16} />
              ) : (
                <UnifiedRow row={it.row} {...p} />
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
});

function UnifiedRow({ row: r, marks, focusLine, onFocusLine, sel, onLineDown, onLineEnter, onLineClick, colours, expand }: ListProps & { row: DisplayRow }) {
  if (r.kind === "hunk") return <div style={{ height: ROW, background: "var(--hunk-bg)", color: "var(--hunk-fg)", paddingLeft: GUTTER * 2 + 30, whiteSpace: "pre", overflow: "hidden", textOverflow: "ellipsis" }}>{r.header}</div>;
  if (r.kind === "note") return <div style={{ height: ROW, color: "var(--faint)", paddingLeft: GUTTER * 2 + 30 }}>{r.text}</div>;
  if (r.kind === "gap") return <GapLine gap={r} expand={expand} indent={GUTTER * 2 + 30} />;
  const bg = r.kind === "add" ? "var(--add-bg)" : r.kind === "del" ? "var(--del-bg)" : r.expanded ? "#0f1318" : "transparent";
  const focused = r.newLine != null && r.newLine === focusLine;
  const selected = r.newLine != null && sel != null && r.newLine >= sel.start && r.newLine <= sel.end;
  const mark = markColor(r.newLine, marks);
  const tokens = r.kind === "del" ? colours?.oldAt(r.oldLine) : colours?.newAt(r.newLine);
  return (
    <div onClick={() => r.newLine != null && onFocusLine(r.newLine)} style={{ height: ROW, display: "flex", background: selected ? SEL_BG : focused ? "#2a2414" : bg, boxShadow: selected ? "inset 3px 0 0 var(--accent)" : focused ? "inset 3px 0 0 var(--agent)" : undefined }}>
      <span style={lineNoStyle}>{r.oldLine ?? ""}</span>
      <button
        style={lineNoStyle}
        disabled={r.newLine == null}
        aria-label={r.newLine != null ? `Comment on line ${r.newLine}` : undefined}
        title={r.newLine != null ? "Comment on this line (c). Shift-click or drag to select several lines" : undefined}
        onMouseDown={(e) => { if (e.button === 0 && !e.shiftKey && r.newLine != null) onLineDown(r.newLine); }}
        onMouseEnter={() => r.newLine != null && onLineEnter(r.newLine)}
        onClick={(e) => { e.stopPropagation(); if (r.newLine != null) onLineClick(r.newLine, e.shiftKey); }}
      >
        {r.newLine ?? ""}
      </button>
      <span style={{ flex: "0 0 14px", color: mark ?? "transparent" }} aria-hidden="true">●</span>
      <span style={{ flex: "0 0 16px", color: r.kind === "add" ? "var(--ok)" : r.kind === "del" ? "var(--bad)" : "transparent" }} aria-hidden="true">{r.kind === "add" ? "+" : r.kind === "del" ? "−" : " "}</span>
      <span style={{ flex: "1 1 auto", whiteSpace: "pre", paddingRight: 16 }}><Code row={r} tokens={tokens} /></span>
    </div>
  );
}

const splitLine = (r: SplitDisplayRow) => (r.kind === "pair" ? r.right?.newLine ?? null : null);

const SplitList = memo(function SplitList(p: ListProps & { rows: SplitDisplayRow[] }) {
  const { items, scroller, v } = useList(p.rows, splitLine, p.composer?.end ?? null, p.focusLine, p.file.path);
  return (
    <div ref={scroller} className="scroll" style={{ height: "100%", fontFamily: "var(--mono)", fontSize: 12.5, lineHeight: `${ROW}px`, tabSize: 4 }}>
      <div style={{ height: v.getTotalSize(), position: "relative" }}>
        {v.getVirtualItems().map((vi) => {
          const it = items[vi.index];
          return (
            <div key={vi.key} data-index={vi.index} ref={v.measureElement} style={{ position: "absolute", top: 0, left: 0, right: 0, transform: `translateY(${vi.start}px)` }}>
              {it.kind === "composer" ? <Composer range={p.composer} rows={p.patchRows} onCancel={p.onCloseComposer} onSave={p.onSaveComment} indent={GUTTER + 40} /> : <SplitRow row={it.row} {...p} />}
            </div>
          );
        })}
      </div>
    </div>
  );
});

function SplitRow({ row: r, marks, focusLine, onFocusLine, sel, onLineDown, onLineEnter, onLineClick, colours, expand }: ListProps & { row: SplitDisplayRow }) {
  if (r.kind === "hunk") return <div style={{ height: ROW, background: "var(--hunk-bg)", color: "var(--hunk-fg)", paddingLeft: GUTTER + 12, whiteSpace: "pre", overflow: "hidden" }}>{r.header}</div>;
  if (r.kind === "note") return <div style={{ height: ROW, color: "var(--faint)", paddingLeft: GUTTER + 12 }}>{r.text}</div>;
  if (r.kind === "gap") return <GapLine gap={r} expand={expand} indent={GUTTER + 12} />;
  const { left, right } = r;
  const focused = right?.newLine != null && right.newLine === focusLine;
  const selected = right?.newLine != null && sel != null && right.newLine >= sel.start && right.newLine <= sel.end;
  const mark = markColor(right?.newLine ?? null, marks);
  const sideBg = (c: CodeRow | null, kind: "del" | "add") => (!c ? "#0d1014" : c.kind === kind ? (kind === "add" ? "var(--add-bg)" : "var(--del-bg)") : c.expanded ? "#0f1318" : "transparent");
  return (
    // Split view wraps long lines (rows grow; both halves share a grid row so they stay aligned).
    <div style={{ minHeight: ROW, display: "grid", gridTemplateColumns: "minmax(0,1fr) minmax(0,1fr)", boxShadow: selected ? "inset -3px 0 0 var(--accent)" : focused ? "inset 3px 0 0 var(--agent)" : undefined }}>
      <div style={{ display: "flex", alignItems: "flex-start", background: sideBg(left, "del"), borderRight: "1px solid var(--border)", minWidth: 0 }}>
        <span style={lineNoStyle}>{left?.oldLine ?? ""}</span>
        <span style={{ flex: "1 1 auto", minWidth: 0, whiteSpace: "pre-wrap", overflowWrap: "anywhere", paddingLeft: 6, paddingRight: 8 }}>{left && <Code row={left} tokens={colours?.oldAt(left.oldLine)} />}</span>
      </div>
      <div onClick={() => right?.newLine != null && onFocusLine(right.newLine)} style={{ display: "flex", alignItems: "flex-start", background: selected ? SEL_BG : focused ? "#2a2414" : sideBg(right, "add"), minWidth: 0 }}>
        <button style={lineNoStyle} disabled={!right?.newLine} title="Comment on this line (c). Shift-click or drag to select several lines" onMouseDown={(e) => { if (e.button === 0 && !e.shiftKey && right?.newLine) onLineDown(right.newLine); }} onMouseEnter={() => right?.newLine && onLineEnter(right.newLine)} onClick={(e) => { e.stopPropagation(); if (right?.newLine) onLineClick(right.newLine, e.shiftKey); }} aria-label={right?.newLine ? `Comment on line ${right.newLine}` : undefined}>{right?.newLine ?? ""}</button>
        <span style={{ flex: "0 0 12px", color: mark ?? "transparent" }} aria-hidden="true">●</span>
        <span style={{ flex: "1 1 auto", minWidth: 0, whiteSpace: "pre-wrap", overflowWrap: "anywhere", paddingRight: 8 }}>{right && <Code row={right} tokens={colours?.newAt(right.newLine)} />}</span>
      </div>
    </div>
  );
}

function Composer({ range, rows, onCancel, onSave, indent }: { range: { start: number; end: number } | null; rows: DiffRow[]; onCancel: () => void; onSave: (start: number, end: number, body: string) => void; indent: number }) {
  if (!range) return null;
  const { start, end } = range;
  const label = start === end ? `Line ${start}` : `Lines ${start}–${end}`;
  return (
    <div style={{ margin: `6px 16px 10px ${indent}px`, padding: 12, borderRadius: 10, border: "1px solid var(--accent-soft-bd)", background: "var(--surface-2)", fontFamily: "var(--sans)", display: "flex", flexDirection: "column", gap: 8, lineHeight: 1.4 }}>
      <div className="muted" style={{ fontSize: 12 }}>Comment on <strong style={{ fontWeight: 600 }}>{label}</strong> · added to your pending review</div>
      <DraftEditor
        initial=""
        saveLabel="Add draft"
        placeholder="Markdown supported. Use ```suggestion to propose a change."
        onCancel={onCancel}
        onSave={(body) => onSave(start, end, body)}
        extraActions={({ append }) => (
          <button className="btn btn-sm" title="Fill a suggestion block with the current text of the selected lines" onClick={() => append(suggestionBlock(newSideLines(rows, start, end) ?? [""]))}>Insert suggestion</button>
        )}
      />
    </div>
  );
}
