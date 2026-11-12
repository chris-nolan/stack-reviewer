// Parses the unified-diff `patch` GitHub returns for each file into renderable rows.

export type DiffRow =
  | { kind: "hunk"; header: string; oldStart: number; newStart: number; section: string }
  | { kind: "add" | "del" | "ctx"; oldLine: number | null; newLine: number | null; text: string }
  | { kind: "note"; text: string };

const HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@ ?(.*)$/;

export function parsePatch(patch: string | undefined): DiffRow[] {
  if (!patch) return [];
  const rows: DiffRow[] = [];
  let oldLine = 0;
  let newLine = 0;
  const lines = patch.split("\n");
  if (lines.at(-1) === "") lines.pop(); // trailing newline is not a context line
  for (const raw of lines) {
    const m = HUNK.exec(raw);
    if (m) {
      oldLine = Number(m[1]);
      newLine = Number(m[3]);
      rows.push({ kind: "hunk", header: raw, oldStart: oldLine, newStart: newLine, section: m[5] ?? "" });
      continue;
    }
    if (raw.startsWith("\\")) {
      rows.push({ kind: "note", text: raw.slice(1).trim() });
      continue;
    }
    const sign = raw.charAt(0);
    const text = raw.slice(1);
    if (sign === "+") rows.push({ kind: "add", oldLine: null, newLine: newLine++, text });
    else if (sign === "-") rows.push({ kind: "del", oldLine: oldLine++, newLine: null, text });
    else if (sign === " " || raw === "") {
      rows.push({ kind: "ctx", oldLine: oldLine++, newLine: newLine++, text });
    }
  }
  return rows;
}

/** New-side line numbers that appear in the diff (where GitHub accepts RIGHT-side comments). */
export function commentableLines(rows: DiffRow[]): Set<number> {
  const s = new Set<number>();
  for (const r of rows) if ((r.kind === "add" || r.kind === "ctx") && r.newLine != null) s.add(r.newLine);
  return s;
}

/** New-side line numbers where each run of changes starts (for next/previous change). */
export function changeStarts(rows: DiffRow[]): number[] {
  const out: number[] = [];
  let inRun = false;
  let lastNew = 0;
  for (const r of rows) {
    if (r.kind === "add" || r.kind === "del") {
      if (!inRun) out.push(r.kind === "add" ? r.newLine! : lastNew + 1);
      inRun = true;
      if (r.kind === "add") lastNew = r.newLine!;
    } else {
      inRun = false;
      if (r.kind === "ctx") lastNew = r.newLine!;
      if (r.kind === "hunk") lastNew = r.newStart - 1;
    }
  }
  return out;
}

/** Side-by-side pairing: deletions and additions in the same block share rows. */
export type SplitRow =
  | { kind: "hunk"; header: string }
  | {
      kind: "pair";
      left: { line: number; text: string; kind: "del" | "ctx" } | null;
      right: { line: number; text: string; kind: "add" | "ctx" } | null;
    };

export function toSplit(rows: DiffRow[]): SplitRow[] {
  const out: SplitRow[] = [];
  let dels: { line: number; text: string }[] = [];
  let adds: { line: number; text: string }[] = [];
  const flush = () => {
    const n = Math.max(dels.length, adds.length);
    for (let i = 0; i < n; i++) {
      const d = dels[i];
      const a = adds[i];
      out.push({
        kind: "pair",
        left: d ? { line: d.line, text: d.text, kind: "del" } : null,
        right: a ? { line: a.line, text: a.text, kind: "add" } : null,
      });
    }
    dels = [];
    adds = [];
  };
  for (const r of rows) {
    if (r.kind === "del") dels.push({ line: r.oldLine!, text: r.text });
    else if (r.kind === "add") adds.push({ line: r.newLine!, text: r.text });
    else {
      flush();
      if (r.kind === "hunk") out.push({ kind: "hunk", header: r.header });
      else if (r.kind === "ctx")
        out.push({
          kind: "pair",
          left: { line: r.oldLine!, text: r.text, kind: "ctx" },
          right: { line: r.newLine!, text: r.text, kind: "ctx" },
        });
    }
  }
  flush();
  return out;
}
