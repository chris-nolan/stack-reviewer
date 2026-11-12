// Builds stacks from GitHub native stack records plus base→head inference.

import type { ChecksState, ConversationEntry, Layer, MyLayerState, PullRequest, RepoRef, Stack } from "./model";

/** A native stack as returned by GET /repos/{owner}/{repo}/stacks (public preview). */
export type NativeStack = {
  number: number;
  open: boolean;
  base: { ref: string };
  pull_requests: { number: number; state: string; merged_at: string | null; head: { ref: string; sha: string } }[];
};

export function myLayerState(pr: PullRequest, me: string, myTeams: string[]): MyLayerState {
  if (pr.state === "MERGED") return "merged";
  if (pr.state === "CLOSED") return "closed";
  if (pr.author.toLowerCase() === me.toLowerCase()) {
    // On my own PRs, show where the reviewers stand rather than my (impossible) review.
    if (pr.reviewDecision === "APPROVED") return "approved";
    if (pr.reviewDecision === "CHANGES_REQUESTED") return "changes";
    return "waiting";
  }
  const mine = pr.latestReviews.find((r) => r.author.toLowerCase() === me.toLowerCase());
  if (mine && mine.state !== "PENDING" && mine.state !== "DISMISSED") {
    if (mine.commit && mine.commit !== pr.headSha) return "stale";
    if (mine.state === "APPROVED") return "approved";
    if (mine.state === "CHANGES_REQUESTED") return "changes";
    return "commented";
  }
  const requested = pr.requestedReviewers.some(
    (r) => r.toLowerCase() === me.toLowerCase() || myTeams.includes(r.toLowerCase()),
  );
  return requested ? "turn" : "todo";
}

export function rollupChecks(states: ChecksState[]): ChecksState {
  if (states.includes("fail")) return "fail";
  if (states.includes("pending")) return "pending";
  if (states.length && states.every((s) => s === "none")) return "none";
  return states.length ? "pass" : "none";
}

function toStack(
  key: string,
  source: Stack["source"],
  repo: RepoRef,
  prs: PullRequest[],
  me: string,
  myTeams: string[],
): Stack {
  const layers: Layer[] = prs.map((pr, i) => ({ pr, index: i + 1, mine: myLayerState(pr, me, myTeams) }));
  const open = prs.filter((p) => p.state === "OPEN");
  return {
    key,
    source,
    repo,
    title: stackTitle(prs),
    author: prs[0]?.author ?? "",
    baseRef: prs[0]?.baseRef ?? "main",
    layers,
    updatedAt: prs.reduce((m, p) => (p.updatedAt > m ? p.updatedAt : m), ""),
    checks: rollupChecks(open.map((p) => p.checks)),
  };
}

/** Name a stack after its root PR, dropping a conventional-commit prefix. */
export function stackTitle(prs: PullRequest[]): string {
  const root = prs[0]?.title ?? "Untitled stack";
  const t = root.replace(/^\w+(\([^)]*\))?!?:\s*/, "");
  return t.charAt(0).toUpperCase() + t.slice(1);
}

/**
 * Combine native stacks and open PRs into a list of stacks for one repo.
 * - Native stacks are authoritative for the PRs they contain (closed/merged layers kept for context).
 * - Remaining open PRs are chained when a PR's base branch is another open PR's head branch.
 * - Anything left over becomes a single-PR "stack" (callers can filter these out).
 */
export function buildStacks(
  repo: RepoRef,
  openPrs: PullRequest[],
  native: NativeStack[],
  me: string,
  myTeams: string[] = [],
  extraPrs: PullRequest[] = [],
): Stack[] {
  const byNumber = new Map<number, PullRequest>();
  for (const p of [...extraPrs, ...openPrs]) byNumber.set(p.number, p);
  const claimed = new Set<number>();
  const stacks: Stack[] = [];

  for (const ns of native) {
    if (!ns.open) continue;
    const prs = ns.pull_requests.map((p) => byNumber.get(p.number)).filter((p): p is PullRequest => !!p);
    if (!prs.some((p) => p.state === "OPEN")) continue;
    prs.forEach((p) => claimed.add(p.number));
    stacks.push(toStack(`n${ns.number}`, "native", repo, prs, me, myTeams));
  }

  const rest = openPrs.filter((p) => !claimed.has(p.number));
  const byHead = new Map<string, PullRequest>();
  for (const p of rest) byHead.set(p.headRef, p);
  const childrenOf = new Map<string, PullRequest[]>();
  for (const p of rest) {
    if (byHead.has(p.baseRef)) {
      const list = childrenOf.get(p.baseRef) ?? [];
      list.push(p);
      childrenOf.set(p.baseRef, list);
    }
  }
  const roots = rest.filter((p) => !byHead.has(p.baseRef));
  for (const root of roots.sort((a, b) => a.number - b.number)) {
    // Walk upward. If a layer has several children the stack forks; follow the oldest
    // child and let the others start their own chains.
    const chain: PullRequest[] = [root];
    const seen = new Set([root.number]);
    let cur = root;
    for (;;) {
      const kids = (childrenOf.get(cur.headRef) ?? []).filter((k) => !seen.has(k.number)).sort((a, b) => a.number - b.number);
      if (!kids.length) break;
      cur = kids[0];
      seen.add(cur.number);
      chain.push(cur);
      for (const other of kids.slice(1)) {
        roots.push(other);
      }
    }
    chain.forEach((p) => claimed.add(p.number));
    stacks.push(toStack(`i${root.number}`, chain.length > 1 ? "inferred" : "single", repo, chain, me, myTeams));
  }

  return stacks.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
}

/** The layer to resume at: the lowest open layer that still needs something from me. */
export function resumeLayer(stack: Stack): Layer {
  const open = stack.layers.filter((l) => l.pr.state === "OPEN");
  return (
    open.find((l) => l.mine === "turn" || l.mine === "stale" || l.mine === "todo") ??
    open.find((l) => l.mine === "changes" || l.mine === "waiting") ??
    open[open.length - 1] ??
    stack.layers[stack.layers.length - 1]
  );
}

export function reviewedCount(stack: Stack): number {
  return stack.layers.filter((l) => ["approved", "changes", "commented", "merged"].includes(l.mine)).length;
}

/** "2, 3, 4, 7" → "2–4, 7" */
export function formatRanges(nums: number[]): string {
  const sorted = [...new Set(nums)].sort((a, b) => a - b);
  const parts: string[] = [];
  for (let i = 0; i < sorted.length; i++) {
    let j = i;
    while (j + 1 < sorted.length && sorted[j + 1] === sorted[j] + 1) j++;
    parts.push(j - i >= 2 ? `${sorted[i]}–${sorted[j]}` : j > i ? `${sorted[i]}, ${sorted[j]}` : `${sorted[i]}`);
    i = j;
  }
  return parts.join(", ");
}

/** Short progress line for a stack row, from the reviewer's or the author's point of view. */
export function progressLabel(stack: Stack, me: string): string {
  const mine = stack.author.toLowerCase() === me.toLowerCase();
  const n = stack.layers.length;
  if (mine) {
    const approved = stack.layers.filter((l) => l.mine === "approved" || l.mine === "merged").length;
    const changes = stack.layers.filter((l) => l.mine === "changes").length;
    return `${approved} of ${n} approved${changes ? ` · changes requested on ${changes}` : ""}`;
  }
  return `${reviewedCount(stack)} of ${n} reviewed · resume at #${resumeLayer(stack).pr.number}`;
}

export function needsMe(stack: Stack): boolean {
  return stack.layers.some((l) => l.pr.state === "OPEN" && (l.mine === "turn" || l.mine === "stale"));
}

/** Pairs to compare to find layers that don't contain the head of the layer below (open layers above the first). */
export function restackPairs(stack: Stack): { layer: number; lowerSha: string; upperSha: string }[] {
  const out: { layer: number; lowerSha: string; upperSha: string }[] = [];
  stack.layers.forEach((l, i) => {
    const lower = stack.layers[i - 1];
    if (lower && l.pr.state === "OPEN" && lower.pr.state === "OPEN") out.push({ layer: l.index, lowerSha: lower.pr.headSha, upperSha: l.pr.headSha });
  });
  return out;
}

export type Mergeability = { label: string; tone: "ok" | "warn" | "bad" | "muted"; hint: string };

/** Short label for GitHub's mergeable/mergeStateStatus, or null when unknown or not applicable. */
export function mergeability(pr: Pick<PullRequest, "state" | "isDraft" | "mergeable" | "mergeStateStatus">): Mergeability | null {
  if (pr.state !== "OPEN") return null;
  if (pr.mergeable === "CONFLICTING" || pr.mergeStateStatus === "DIRTY") return { label: "Conflicts", tone: "bad", hint: "This branch has merge conflicts with its base." };
  switch (pr.mergeStateStatus) {
    case "BLOCKED": return { label: "Blocked", tone: "warn", hint: "Required reviews or checks are missing." };
    case "BEHIND": return { label: "Behind base", tone: "warn", hint: "The base branch has new commits." };
    case "DRAFT": return { label: "Draft", tone: "muted", hint: "Draft pull requests can't be merged." };
    case "UNSTABLE": return { label: "Checks failing", tone: "warn", hint: "Mergeable, but some non-required checks fail." };
    case "CLEAN": case "HAS_HOOKS": return { label: "Ready", tone: "ok", hint: "No conflicts and requirements are met." };
    default: return pr.mergeable === "MERGEABLE" ? { label: "No conflicts", tone: "ok", hint: "No conflicts." } : null;
  }
}

/** Merge top-level comments and review summaries (skipping empty review bodies), oldest first. */
export function mergeConversation(
  comments: { id: string; author: string; body: string; createdAt: string }[],
  reviews: { id: string; author: string; state: string; body: string; createdAt: string }[],
): ConversationEntry[] {
  const all: ConversationEntry[] = [
    ...comments.map((c) => ({ ...c, kind: "comment" as const, state: null })),
    ...reviews.map((r) => ({ ...r, kind: "review" as const })),
  ];
  return all.filter((e) => e.body?.trim()).sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));
}
