// Builds what the diff view renders: code lines (with syntax colours and word-level change
// ranges), hunk headers, and expandable gaps of unchanged lines between hunks.

import { diffWordsWithSpace } from "diff";
import type { DiffRow } from "./diff";

export type Seg = { text: string; color?: string; changed?: boolean };

export type CodeRow = {
  kind: "add" | "del" | "ctx";
  oldLine: number | null;
  newLine: number | null;
  text: string;
  /** Character ranges that differ from the paired line (word-level highlight). */
  changes?: [number, number][];
  /** True for unchanged lines revealed by expanding a gap. */
  expanded?: boolean;
};

export type GapRow = {
  kind: "gap";
  id: string;
  /** Hidden new-side line range (inclusive), and how old-side numbers relate to it. */
  newFrom: number;
  newTo: number;
  oldOffset: number;
  position: "top" | "middle" | "bottom";
  /** False when we don't have the file's full text, so the lines can't be shown. */
  expandable: boolean;
};

export type DisplayRow = CodeRow | GapRow | { kind: "hunk"; header: string } | { kind: "note"; text: string };

export type Expansion = { fromTop: number; fromBottom: number };
export type Expansions = Record<string, Expansion>;

const lastIndex = (lines: string[]) => (lines.length && lines[lines.length - 1] === "" ? lines.length - 1 : lines.length);

/**
 * @param rows       parsed patch rows
 * @param newLines   the whole new-side file split into lines, if known (enables expanding)
 * @param expansions how far each gap has been opened, keyed by gap id
 */
export function buildDisplayRows(rows: DiffRow[], newLines: string[] | null, expansions: Expansions = {}): DisplayRow[] {
  const out: DisplayRow[] = [];
  const total = newLines ? lastIndex(newLines) : null;
  let lastNew = 0; // last new-side line shown by the previous hunk
  let offset = 0; // oldLine - newLine for unchanged lines at the current position
  let seenHunk = false;

  const pushGap = (from: number, to: number, oldOffset: number, position: GapRow["position"], header?: string) => {
    const id = `${position}:${from}`;
    if (to < from) {
      if (header && position !== "middle") out.push({ kind: "hunk", header });
      return;
    }
    const exp = expansions[id] ?? { fromTop: 0, fromBottom: 0 };
    const canExpand = !!newLines;
    const top = canExpand ? Math.min(exp.fromTop, to - from + 1) : 0;
    const bottom = canExpand ? Math.min(exp.fromBottom, to - from + 1 - top) : 0;
    const line = (n: number): CodeRow => ({ kind: "ctx", oldLine: n + oldOffset, newLine: n, text: newLines![n - 1] ?? "", expanded: true });
    for (let n = from; n < from + top; n++) out.push(line(n));
    const hiddenFrom = from + top;
    const hiddenTo = to - bottom;
    if (hiddenTo >= hiddenFrom) out.push({ kind: "gap", id, newFrom: hiddenFrom, newTo: hiddenTo, oldOffset, position, expandable: canExpand });
    for (let n = hiddenTo + 1; n <= to; n++) out.push(line(n));
    // Keep the hunk header only while something above it is still hidden.
    if (header && hiddenTo >= hiddenFrom) out.push({ kind: "hunk", header });
  };

  for (const r of rows) {
    if (r.kind === "hunk") {
      const hunkOffset = r.oldStart - r.newStart;
      // Lines before this hunk: from the end of the last one (or the top of the file).
      pushGap(lastNew + 1, r.newStart - 1, hunkOffset, seenHunk ? "middle" : "top", r.header);
      seenHunk = true;
      offset = hunkOffset;
      lastNew = r.newStart - 1;
      continue;
    }
    if (r.kind === "note") {
      out.push(r);
      continue;
    }
    out.push({ kind: r.kind, oldLine: r.oldLine, newLine: r.newLine, text: r.text });
    if (r.newLine != null) lastNew = r.newLine;
    if (r.kind === "ctx" && r.oldLine != null && r.newLine != null) offset = r.oldLine - r.newLine;
    if (r.kind === "del") offset++;
  }
  if (seenHunk && total != null) pushGap(lastNew + 1, total, offset, "bottom");
  pairWordChanges(out);
  return out;
}

/** Pairs runs of deleted and added lines and marks the words that changed between them. */
export function pairWordChanges(rows: DisplayRow[]) {
  let i = 0;
  while (i < rows.length) {
    if (rows[i].kind !== "del") {
      i++;
      continue;
    }
    const dels: CodeRow[] = [];
    const adds: CodeRow[] = [];
    while (i < rows.length && rows[i].kind === "del") dels.push(rows[i++] as CodeRow);
    while (i < rows.length && rows[i].kind === "add") adds.push(rows[i++] as CodeRow);
    const n = Math.min(dels.length, adds.length);
    for (let k = 0; k < n; k++) markPair(dels[k], adds[k]);
  }
}

function markPair(del: CodeRow, add: CodeRow) {
  if (del.text.length > 500 || add.text.length > 500) return;
  const parts = diffWordsWithSpace(del.text, add.text);
  const same = parts.filter((p) => !p.added && !p.removed).reduce((n, p) => n + p.value.trim().length, 0);
  const longest = Math.max(del.text.trim().length, add.text.trim().length, 1);
  if (same / longest < 0.35) return; // too different: highlighting words would be noise
  const d: [number, number][] = [];
  const a: [number, number][] = [];
  let di = 0;
  let ai = 0;
  for (const p of parts) {
    const len = p.value.length;
    if (p.removed) {
      d.push([di, di + len]);
      di += len;
    } else if (p.added) {
      a.push([ai, ai + len]);
      ai += len;
    } else {
      di += len;
      ai += len;
    }
  }
  if (d.length) del.changes = d;
  if (a.length) add.changes = a;
}

/** Splits a line into segments by syntax colour and word-change ranges. */
export function segments(text: string, colors: { content: string; color?: string }[] | undefined, changes: [number, number][] | undefined): Seg[] {
  const tokens = colors?.length ? colors : [{ content: text }];
  if (!changes?.length) return tokens.map((t) => ({ text: t.content, color: t.color }));
  const cuts = new Set<number>([0, text.length]);
  for (const [s, e] of changes) {
    cuts.add(s);
    cuts.add(e);
  }
  let pos = 0;
  for (const t of tokens) {
    cuts.add(pos);
    pos += t.content.length;
  }
  const points = [...cuts].filter((c) => c >= 0 && c <= text.length).sort((x, y) => x - y);
  const colorAt = (at: number) => {
    let p = 0;
    for (const t of tokens) {
      if (at < p + t.content.length) return t.color;
      p += t.content.length;
    }
    return undefined;
  };
  const changedAt = (at: number) => changes.some(([s, e]) => at >= s && at < e);
  const out: Seg[] = [];
  for (let k = 0; k < points.length - 1; k++) {
    const [s, e] = [points[k], points[k + 1]];
    if (e <= s) continue;
    out.push({ text: text.slice(s, e), color: colorAt(s), changed: changedAt(s) || undefined });
  }
  return out;
}

/** Side-by-side rows from display rows. Gaps and headers span both sides. */
export type SplitDisplayRow =
  | { kind: "pair"; left: CodeRow | null; right: CodeRow | null }
  | Exclude<DisplayRow, CodeRow>;

export function toSplitRows(rows: DisplayRow[]): SplitDisplayRow[] {
  const out: SplitDisplayRow[] = [];
  let dels: CodeRow[] = [];
  let adds: CodeRow[] = [];
  const flush = () => {
    for (let k = 0; k < Math.max(dels.length, adds.length); k++) out.push({ kind: "pair", left: dels[k] ?? null, right: adds[k] ?? null });
    dels = [];
    adds = [];
  };
  for (const r of rows) {
    if (r.kind === "del") dels.push(r);
    else if (r.kind === "add") adds.push(r);
    else {
      flush();
      if (r.kind === "ctx") out.push({ kind: "pair", left: r, right: r });
      else out.push(r as Exclude<DisplayRow, CodeRow>);
    }
  }
  flush();
  return out;
}

/** Text of each side reconstructed from the patch, for highlighting when the full file isn't available. */
export function sidesFromPatch(rows: DiffRow[]): { newText: string; newIndex: Map<number, number>; oldText: string; oldIndex: Map<number, number> } {
  const n: string[] = [];
  const o: string[] = [];
  const newIndex = new Map<number, number>();
  const oldIndex = new Map<number, number>();
  for (const r of rows) {
    if (r.kind === "add" || r.kind === "ctx") {
      newIndex.set(r.newLine!, n.length);
      n.push(r.text);
    }
    if (r.kind === "del" || r.kind === "ctx") {
      oldIndex.set(r.oldLine!, o.length);
      o.push(r.text);
    }
  }
  return { newText: n.join("\n"), newIndex, oldText: o.join("\n"), oldIndex };
}
