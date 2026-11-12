// "Guide me": the agent's orientation of a stack. Pure logic (types, validation, staleness,
// ranking). Storage is in guideStore.ts; ticks live in reviewStore (`focusDone`).

import { parsePatch, validRange, type DiffRow } from "./diff";
import { formatRanges } from "./stacks";

export type Tier = "light" | "moderate" | "heavy";
export const TIERS: Tier[] = ["light", "moderate", "heavy"];
export const TIER_WORD: Record<Tier, string> = { light: "Light", moderate: "Moderate", heavy: "Heavy" };
export const TIER_BARS: Record<Tier, number> = { light: 1, moderate: 2, heavy: 3 };

export type FocusArea = { id: string; path: string; startLine?: number; line: number; title: string; why: string };

export type LayerGuide = {
  pr: number;
  /** Head the agent read; the guide is stale when the layer's head moves. */
  headSha: string;
  agent: string;
  createdAt: number;
  tier: Tier;
  tierReason: string;
  focus: FocusArea[];
  skim: { path: string; why: string }[];
  questions: string[];
};

export type StackGuideBody = {
  agent: string;
  createdAt: number;
  summary: string;
  layerRoles: { pr: number; role: string }[];
  crossLayer: { text: string; prs: number[] }[];
  plan: string;
  /** Every guided PR number, hardest first. */
  ranking: number[];
};

export type GuideRun = {
  status: "running" | "stopped" | "done" | "error";
  /** Layers still to be guided, in the order the agent was asked to do them. */
  pending: number[];
  /** Layers this run set out to guide (for "Guiding layer 3 of 5"). */
  total: number;
  /** The layer the agent last read (`get_review_context`). */
  reading?: number;
  kind: "all" | "refresh" | "continue";
  agent: string;
  startedAt: number;
  error?: string;
};

/** Everything stored for one stack. `stack` appears when set_stack_guide lands (it comes last). */
export type GuideDoc = {
  stackKey: string;
  layers: Record<number, LayerGuide>;
  stack?: StackGuideBody;
  run?: GuideRun;
};

export const EMPTY_DOC = (stackKey: string): GuideDoc => ({ stackKey, layers: {} });

// ---- focus ids ---------------------------------------------------------------------------

/** Stable id for a focus area: a refresh that keeps the same path + title keeps its tick. */
export function focusId(path: string, title: string): string {
  const s = `${path}\n${title.trim().toLowerCase().replace(/\s+/g, " ")}`;
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = (Math.imul(h2, 31) + c) >>> 0;
  }
  return h1.toString(16).padStart(8, "0") + h2.toString(16).padStart(8, "0");
}

export function focusProgress(focus: { id: string }[], done: readonly string[] | undefined): { done: number; total: number } {
  const d = new Set(done ?? []);
  return { done: focus.filter((f) => d.has(f.id)).length, total: focus.length };
}

// ---- staleness and ranking ---------------------------------------------------------------

export const isStale = (g: LayerGuide | undefined, headSha: string): boolean => !!g && g.headSha !== headSha;

export type GuideTargets = {
  /** Open layers whose guide was written against an older head. */
  stale: number[];
  /** Open layers that have no guide yet (added after the guide ran, or an unfinished run). */
  missing: number[];
  /** Guided layers that are no longer open (merged, closed or removed). */
  removed: number[];
};

type LayerLike = { pr: { number: number; headSha: string; state: string } };

export function guideTargets(doc: GuideDoc, layers: LayerLike[]): GuideTargets {
  const open = layers.filter((l) => l.pr.state === "OPEN");
  const openNums = new Set(open.map((l) => l.pr.number));
  return {
    stale: open.filter((l) => isStale(doc.layers[l.pr.number], l.pr.headSha)).map((l) => l.pr.number),
    missing: open.filter((l) => !doc.layers[l.pr.number]).map((l) => l.pr.number),
    removed: Object.keys(doc.layers).map(Number).filter((n) => !openNums.has(n)),
  };
}

/** The stack guide is stale when any layer is stale or the set of open layers changed. */
export function stackGuideStale(doc: GuideDoc, layers: LayerLike[]): boolean {
  if (!doc.stack) return false;
  const t = guideTargets(doc, layers);
  return t.stale.length + t.missing.length + t.removed.length > 0;
}

export function ordinal(n: number): string {
  const s = ["th", "st", "nd", "rd"];
  const v = n % 100;
  return n + (s[(v - 20) % 10] ?? s[v] ?? s[0]);
}

/** "2nd of 5" (hardest = 1st), or null when the PR isn't in the ranking. */
export function rankOf(ranking: number[] | undefined, pr: number): { rank: number; of: number } | null {
  const i = ranking?.indexOf(pr) ?? -1;
  return i < 0 ? null : { rank: i + 1, of: ranking!.length };
}
export const rankLabel = (r: { rank: number; of: number } | null) => (r ? `${ordinal(r.rank)} of ${r.of}` : "");

// ---- validation --------------------------------------------------------------------------

type PatchFile = { path: string; patch?: string };
type Result<T> = { ok: true; value: T } | { ok: false; error: string };

const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** New-side line ranges that are valid for a comment/focus, one per hunk, as "30–38, 80–95". */
export function validHunks(rows: DiffRow[]): string {
  const out: number[][] = [];
  let cur: number[] = [];
  for (const r of rows) {
    if (r.kind === "hunk") {
      if (cur.length) out.push(cur);
      cur = [];
    } else if ((r.kind === "add" || r.kind === "ctx") && r.newLine != null) cur.push(r.newLine);
  }
  if (cur.length) out.push(cur);
  return out.map((h) => formatRanges(h)).join(" | ") || "(none)";
}

export type LayerGuideInput = Omit<LayerGuide, "agent" | "createdAt"> & { summary: string };

/** Validates a set_layer_guide call against the layer's diff. All problems are reported together so the agent can retry once. */
export function validateLayerGuide(raw: unknown, pr: number, headSha: string, files: PatchFile[]): Result<LayerGuideInput> {
  if (!isObj(raw)) return { ok: false, error: "Expected an object with summary, tier, tier_reason, focus_areas, skim and questions." };
  const errors: string[] = [];
  const summary = str(raw.summary);
  if (!summary) errors.push("`summary` is required (2-3 sentences on what the layer does).");
  const tier = str(raw.tier).toLowerCase() as Tier;
  if (!TIERS.includes(tier)) errors.push("`tier` must be one of light, moderate, heavy.");
  const tierReason = str(raw.tier_reason ?? raw.tierReason);
  if (!tierReason) errors.push("`tier_reason` is required (one line).");

  const byPath = new Map(files.map((f) => [f.path, f]));
  const focusRaw = raw.focus_areas ?? raw.focusAreas;
  const focus: FocusArea[] = [];
  if (!Array.isArray(focusRaw) || focusRaw.length < 1 || focusRaw.length > 5) {
    errors.push("`focus_areas` must have 1-5 items.");
  } else {
    focusRaw.forEach((f, i) => {
      const at = `focus_areas[${i}]`;
      if (!isObj(f)) return errors.push(`${at} must be an object.`);
      const path = str(f.path);
      const line = Number(f.line);
      const start = f.start_line == null && f.startLine == null ? line : Number(f.start_line ?? f.startLine);
      const title = str(f.title);
      const why = str(f.why);
      if (!title || !why) errors.push(`${at} needs a title and a why.`);
      const file = byPath.get(path);
      if (!file) return errors.push(`${at}: ${path || "(no path)"} is not changed in #${pr}. Changed files: ${files.map((x) => x.path).join(", ") || "(none)"}`);
      const rows = parsePatch(file.patch);
      if (!validRange(rows, start, line)) {
        return errors.push(`${at}: ${start === line ? `line ${line}` : `lines ${start}–${line}`} of ${path} ${start === line ? "is" : "are"} not a valid range in #${pr}'s diff (a range must be new-side lines inside one hunk). Valid ranges: ${validHunks(rows)}`);
      }
      let id = focusId(path, title);
      for (let n = 2; focus.some((x) => x.id === id); n++) id = focusId(path, `${title} ${n}`);
      focus.push({ id, path, ...(start < line ? { startLine: start } : {}), line, title: title.slice(0, 140), why });
    });
  }

  const skim: LayerGuide["skim"] = [];
  const skimRaw = raw.skim;
  if (skimRaw != null && !Array.isArray(skimRaw)) errors.push("`skim` must be an array of { path, why }.");
  else
    (skimRaw as unknown[] | undefined)?.forEach((s, i) => {
      const path = isObj(s) ? str(s.path) : "";
      if (!byPath.has(path)) return errors.push(`skim[${i}]: ${path || "(no path)"} is not changed in #${pr}. Changed files: ${files.map((x) => x.path).join(", ") || "(none)"}`);
      if (!skim.some((x) => x.path === path)) skim.push({ path, why: str((s as Record<string, unknown>).why) });
    });
  // A file with a focus area isn't safe to skim; drop the skim entry rather than make the agent retry.
  const focusPaths = new Set(focus.map((f) => f.path));
  const skimKept = skim.filter((s) => !focusPaths.has(s.path));

  const qRaw = raw.questions;
  if (qRaw != null && !Array.isArray(qRaw)) errors.push("`questions` must be an array of strings.");
  const questions = ((qRaw as unknown[] | undefined) ?? []).map(str).filter(Boolean).slice(0, 4);

  if (errors.length) return { ok: false, error: `Guide for #${pr} not saved. Fix and call set_layer_guide again:\n- ${errors.join("\n- ")}` };
  return { ok: true, value: { pr, headSha, summary, tier, tierReason, focus, skim: skimKept, questions } };
}

export type StackGuideInput = Omit<StackGuideBody, "agent" | "createdAt">;

/** Validates set_stack_guide: the ranking must contain each guided (open) PR exactly once. */
export function validateStackGuide(raw: unknown, openPrs: number[], guidedPrs: number[]): Result<StackGuideInput> {
  if (!isObj(raw)) return { ok: false, error: "Expected an object with summary, layer_roles, cross_layer, plan and ranking." };
  const errors: string[] = [];
  const summary = str(raw.summary);
  const plan = str(raw.plan);
  if (!summary) errors.push("`summary` is required.");
  if (!plan) errors.push("`plan` is required.");

  const open = new Set(openPrs);
  const unguided = openPrs.filter((n) => !guidedPrs.includes(n));
  if (unguided.length) errors.push(`These open layers have no guide yet: ${unguided.map((n) => `#${n}`).join(", ")}. Call set_layer_guide for them first.`);

  const ranking = Array.isArray(raw.ranking) ? raw.ranking.map(Number) : null;
  if (!ranking) errors.push("`ranking` must be an array of PR numbers, hardest first.");
  else {
    const seen = new Set<number>();
    const dup = new Set<number>();
    for (const n of ranking) (seen.has(n) ? dup : seen).add(n);
    const unknown = ranking.filter((n) => !open.has(n));
    const missing = guidedPrs.filter((n) => open.has(n) && !seen.has(n));
    if (dup.size) errors.push(`ranking repeats ${[...dup].map((n) => `#${n}`).join(", ")}.`);
    if (unknown.length) errors.push(`ranking has PRs that aren't open layers of this stack: ${unknown.map((n) => `#${n}`).join(", ")}.`);
    if (missing.length) errors.push(`ranking is missing ${missing.map((n) => `#${n}`).join(", ")}. It must list every guided PR exactly once (${guidedPrs.length} expected).`);
  }

  const layerRoles: StackGuideInput["layerRoles"] = [];
  for (const r of Array.isArray(raw.layer_roles ?? raw.layerRoles) ? ((raw.layer_roles ?? raw.layerRoles) as unknown[]) : []) {
    if (isObj(r) && open.has(Number(r.pr)) && str(r.role)) layerRoles.push({ pr: Number(r.pr), role: str(r.role) });
  }
  const crossLayer: StackGuideInput["crossLayer"] = [];
  for (const c of Array.isArray(raw.cross_layer ?? raw.crossLayer) ? ((raw.cross_layer ?? raw.crossLayer) as unknown[]) : []) {
    if (!isObj(c) || !str(c.text)) continue;
    const prs = (Array.isArray(c.prs) ? c.prs : []).map(Number).filter((n) => open.has(n));
    crossLayer.push({ text: str(c.text), prs });
  }

  if (errors.length) return { ok: false, error: `Stack guide not saved. Fix and call set_stack_guide again:\n- ${errors.join("\n- ")}` };
  return { ok: true, value: { summary, plan, layerRoles, crossLayer, ranking: ranking! } };
}
