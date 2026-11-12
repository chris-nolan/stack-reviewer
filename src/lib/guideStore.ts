// Durable storage for guides ("guide" namespace, one row per stack) and the run state.
// Ticks are not here: they live in reviewStore so a refresh never wipes the reviewer's own state.

import { useSyncExternalStore } from "react";
import { durable } from "./durable";
import { EMPTY_DOC, type GuideDoc, type GuideRun, type LayerGuide, type StackGuideBody } from "./guide";

const listeners = new Set<() => void>();
const deadViews = new WeakMap<GuideDoc, GuideDoc>();
const empties = new Map<string, GuideDoc>();
const doc = (stackId: string): GuideDoc => durable.get<GuideDoc | null>("guide", stackId, null) ?? emptyFor(stackId);
function emptyFor(stackId: string): GuideDoc {
  let e = empties.get(stackId);
  if (!e) empties.set(stackId, (e = EMPTY_DOC(stackId)));
  return e;
}

function commit(stackId: string, next: GuideDoc) {
  durable.set("guide", stackId, next);
  listeners.forEach((l) => l());
}

/** Stacks whose run is live in this process; a "running" row that isn't in here died with the app. */
const g = globalThis as typeof globalThis & { __srGuideLive?: Set<string> };
const live = (g.__srGuideLive ??= new Set<string>());

export const guideStore = {
  get: doc,
  /** The doc with a dead "running" run shown as stopped (the app quit or the agent died mid-run). */
  view(stackId: string): GuideDoc {
    const d = doc(stackId);
    if (d.run?.status !== "running" || live.has(stackId)) return d;
    let v = deadViews.get(d);
    if (!v) deadViews.set(d, (v = { ...d, run: { ...d.run, status: "stopped" } }));
    return v;
  },
  isLive: (stackId: string) => live.has(stackId),

  startRun(stackId: string, run: Omit<GuideRun, "status" | "startedAt">) {
    live.add(stackId);
    commit(stackId, { ...doc(stackId), run: { ...run, status: "running", startedAt: Date.now() } });
  },
  markReading(stackId: string, pr: number) {
    const d = doc(stackId);
    if (d.run?.status === "running" && d.run.reading !== pr) commit(stackId, { ...d, run: { ...d.run, reading: pr } });
  },
  /** Stores a layer's guide (replacing any earlier one) and takes it off the run's pending list. */
  setLayer(stackId: string, guide: LayerGuide) {
    const d = doc(stackId);
    const run = d.run && { ...d.run, pending: d.run.pending.filter((n) => n !== guide.pr), reading: d.run.reading === guide.pr ? undefined : d.run.reading };
    commit(stackId, { ...d, layers: { ...d.layers, [guide.pr]: guide }, run });
  },
  setStack(stackId: string, body: StackGuideBody) {
    const d = doc(stackId);
    commit(stackId, { ...d, stack: body, run: d.run?.status === "running" && !d.run.pending.length ? { ...d.run, status: "done", reading: undefined } : d.run });
    if (!doc(stackId).run || doc(stackId).run!.status !== "running") live.delete(stackId);
  },
  finishRun(stackId: string, status: GuideRun["status"], error?: string) {
    const d = doc(stackId);
    live.delete(stackId);
    if (!d.run || d.run.status !== "running") return;
    commit(stackId, { ...d, run: { ...d.run, status, error, reading: undefined } });
  },
  /** Drop layer guides that no longer apply (the layer left the stack). */
  prune(stackId: string, keep: number[]) {
    const d = doc(stackId);
    const layers = Object.fromEntries(Object.entries(d.layers).filter(([n]) => keep.includes(Number(n))));
    commit(stackId, { ...d, layers });
  },
  clear(stackId: string) {
    live.delete(stackId);
    durable.delete("guide", stackId);
    listeners.forEach((l) => l());
  },
  /** Replace the whole doc (demo seeding). */
  replace(stackId: string, d: GuideDoc) {
    commit(stackId, d);
  },
};

export function useGuide(stackId: string): GuideDoc {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => guideStore.view(stackId),
  );
}
