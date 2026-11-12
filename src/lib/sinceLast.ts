// "Since you last looked": diff the stacks in the inbox against what was seen when each was opened.
import type { ChecksState, Stack } from "./model";
import { repoKey } from "./model";

export type StackSeen = {
  heads: Record<number, string>; // PR number -> head SHA
  checks: Record<number, ChecksState>;
  needed: boolean; // did it need my review when seen
  at: string;
};
export type SeenMap = Record<string, StackSeen>;

export const stackId = (s: { repo: { owner: string; repo: string }; key: string }) => `${repoKey(s.repo)}#${s.key}`;

export const needsMyReview = (s: Stack) => s.layers.some((l) => l.mine === "turn" || l.mine === "stale");

export function snapshotStack(s: Stack, needed = needsMyReview(s), at = new Date().toISOString()): StackSeen {
  return {
    heads: Object.fromEntries(s.layers.map((l) => [l.pr.number, l.pr.headSha])),
    checks: Object.fromEntries(s.layers.map((l) => [l.pr.number, l.pr.checks])),
    needed,
    at,
  };
}

export type Change =
  | { kind: "new"; id: string; stack: Stack }
  | { kind: "commits"; id: string; stack: Stack; layers: number[] }
  | { kind: "failing"; id: string; stack: Stack; layers: number[] };

/**
 * Compare current stacks with the last-seen map. `needsReview` holds the ids of stacks in the
 * "Needs my review" inbox. Stacks never opened only count as new if they need review; commits and
 * check changes are reported only for stacks that were opened before.
 */
export function diffSince(seen: SeenMap, stacks: Stack[], needsReview: Set<string>): Change[] {
  const out: Change[] = [];
  for (const s of stacks) {
    const id = stackId(s);
    const was = seen[id];
    if (!was) {
      if (needsReview.has(id)) out.push({ kind: "new", id, stack: s });
      continue;
    }
    if (!was.needed && needsReview.has(id)) out.push({ kind: "new", id, stack: s });
    const commits = s.layers.filter((l) => was.heads[l.pr.number] !== undefined && was.heads[l.pr.number] !== l.pr.headSha).map((l) => l.index);
    if (commits.length) out.push({ kind: "commits", id, stack: s, layers: commits });
    const failing = s.layers.filter((l) => l.pr.state === "OPEN" && l.pr.checks === "fail" && was.checks[l.pr.number] !== "fail").map((l) => l.index);
    if (failing.length) out.push({ kind: "failing", id, stack: s, layers: failing });
  }
  return out;
}

/** Snapshot every given stack, keeping the rest of the map. */
export function markAllSeen(seen: SeenMap, stacks: Stack[], needsReview: Set<string>, at = new Date().toISOString()): SeenMap {
  const next = { ...seen };
  for (const s of stacks) next[stackId(s)] = snapshotStack(s, needsReview.has(stackId(s)), at);
  return next;
}
