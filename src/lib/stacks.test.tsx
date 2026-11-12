import { describe, expect, it } from "vitest";
import { buildStacks, mergeability, mergeConversation, myLayerState, restackPairs, resumeLayer, type NativeStack } from "./stacks";
import { parsePatch, toSplit, commentableLines, validRange, clampRange, newSideLines, suggestionBlock, rangeLabel } from "./diff";
import type { PullRequest } from "./model";

const repo = { owner: "acme", repo: "api" };

function pr(number: number, baseRef: string, headRef: string, extra: Partial<PullRequest> = {}): PullRequest {
  return {
    id: `PR_${number}`, number, title: `PR ${number}`, body: "", url: "", author: "alex",
    isDraft: false, state: "OPEN", baseRef, headRef, headSha: `sha${number}`,
    additions: 1, deletions: 0, changedFiles: 1, updatedAt: `2026-11-0${number % 9}T00:00:00Z`,
    createdAt: "2026-11-01T00:00:00Z", reviewDecision: null, checks: "pass",
    requestedReviewers: [], latestReviews: [], assignees: [], ...extra,
  };
}

describe("buildStacks", () => {
  it("chains PRs whose base is another PR's head", () => {
    const prs = [pr(3, "b", "c"), pr(1, "main", "a"), pr(2, "a", "b"), pr(9, "main", "solo")];
    const stacks = buildStacks(repo, prs, [], "me");
    const chain = stacks.find((s) => s.key === "i1")!;
    expect(chain.source).toBe("inferred");
    expect(chain.layers.map((l) => l.pr.number)).toEqual([1, 2, 3]);
    expect(chain.layers.map((l) => l.index)).toEqual([1, 2, 3]);
    expect(stacks.find((s) => s.key === "i9")!.source).toBe("single");
  });

  it("prefers native stacks and keeps their order", () => {
    const prs = [pr(5, "main", "x"), pr(6, "x", "y"), pr(7, "y", "z")];
    const native: NativeStack[] = [
      { number: 100, open: true, base: { ref: "main" }, pull_requests: [5, 6, 7].map((n) => ({ number: n, state: "open", merged_at: null, head: { ref: "", sha: "" } })) },
    ];
    const stacks = buildStacks(repo, prs, native, "me");
    expect(stacks).toHaveLength(1);
    expect(stacks[0].key).toBe("n100");
    expect(stacks[0].source).toBe("native");
  });

  it("ignores closed native stacks", () => {
    const prs = [pr(5, "main", "x")];
    const native: NativeStack[] = [{ number: 1, open: false, base: { ref: "main" }, pull_requests: [{ number: 5, state: "closed", merged_at: "x", head: { ref: "x", sha: "" } }] }];
    expect(buildStacks(repo, prs, native, "me")[0].key).toBe("i5");
  });

  it("splits forks into separate chains", () => {
    const prs = [pr(1, "main", "a"), pr(2, "a", "b"), pr(3, "a", "c")];
    const stacks = buildStacks(repo, prs, [], "me");
    expect(stacks.map((s) => s.layers.map((l) => l.pr.number)).sort()).toEqual([[1, 2], [3]]);
  });
});

describe("myLayerState", () => {
  it("marks a review on an older commit as stale", () => {
    const p = pr(1, "main", "a", { latestReviews: [{ author: "Me", state: "APPROVED", commit: "old" }] });
    expect(myLayerState(p, "me", [])).toBe("stale");
  });
  it("detects team review requests", () => {
    const p = pr(1, "main", "a", { requestedReviewers: ["platform"] });
    expect(myLayerState(p, "me", ["platform"])).toBe("turn");
  });
  it("resumes at the first layer needing me", () => {
    const prs = [
      pr(1, "main", "a", { latestReviews: [{ author: "me", state: "APPROVED", commit: "sha1" }] }),
      pr(2, "a", "b", { requestedReviewers: ["me"] }),
    ];
    expect(resumeLayer(buildStacks(repo, prs, [], "me")[0]).pr.number).toBe(2);
  });
});

describe("parsePatch", () => {
  const patch = "@@ -10,3 +10,4 @@ fn main() {\n a\n-b\n+B\n+C\n c\n\\ No newline at end of file";
  it("numbers lines on both sides", () => {
    const rows = parsePatch(patch);
    expect(rows[0]).toMatchObject({ kind: "hunk", oldStart: 10, newStart: 10, section: "fn main() {" });
    expect(rows[1]).toMatchObject({ kind: "ctx", oldLine: 10, newLine: 10, text: "a" });
    expect(rows[2]).toMatchObject({ kind: "del", oldLine: 11, newLine: null });
    expect(rows[3]).toMatchObject({ kind: "add", oldLine: null, newLine: 11, text: "B" });
    expect(rows[5]).toMatchObject({ kind: "ctx", oldLine: 12, newLine: 13 });
    expect(rows[6]).toMatchObject({ kind: "note" });
    expect([...commentableLines(rows)]).toEqual([10, 11, 12, 13]);
  });
  it("pairs deletions and additions for split view", () => {
    const split = toSplit(parsePatch(patch));
    const pairs = split.filter((r) => r.kind === "pair");
    expect(pairs[1]).toMatchObject({ left: { line: 11, kind: "del" }, right: { line: 11, kind: "add" } });
    expect(pairs[2]).toMatchObject({ left: null, right: { line: 12, kind: "add" } });
  });
});

import { failureExcerpt } from "./logs";
import { parseFindingBlocks } from "../agent/bridge";

describe("failureExcerpt", () => {
  it("keeps the region around errors and strips timestamps", () => {
    const log = [
      ...Array.from({ length: 40 }, (_, i) => `2026-11-12T12:00:00.0000000Z noise ${i}`),
      "2026-11-12T12:01:10.2000000Z FAIL test/a.test.ts",
      "2026-11-12T12:01:10.2000000Z   expected 429",
      "2026-11-12T12:01:11.0000000Z ##[error]Process completed with exit code 1.",
    ].join("\n");
    const { lines, truncated } = failureExcerpt(log);
    expect(lines[0]).toBe("noise 25");
    expect(lines).toContain("FAIL test/a.test.ts");
    expect(lines.at(-1)).toBe("##[error]Process completed with exit code 1.");
    expect(truncated).toBe(true);
  });
});

describe("parseFindingBlocks", () => {
  it("reads fenced findings JSON", () => {
    const text = 'Here:\n```findings\n[{"path":"a.ts","line":3,"severity":"High","title":"Bug","body":"x"},{"path":"b.ts","title":"no line"}]\n```';
    expect(parseFindingBlocks(text)).toEqual([{ path: "a.ts", line: 3, severity: "High", title: "Bug", body: "x", suggestion: undefined }]);
  });
});

import { changeStarts } from "./diff";
describe("changeStarts", () => {
  it("finds the first new-side line of each change run", () => {
    const rows = parsePatch("@@ -1,6 +1,6 @@\n a\n-b\n+B\n c\n d\n-e\n f");
    expect(changeStarts(rows)).toEqual([2, 5]);
  });
});

import { summarize, splitConventional } from "./markdown";
import { formatRanges, progressLabel } from "./stacks";
describe("summaries and labels", () => {
  it("strips gh-stack boilerplate and markdown", () => {
    const body = "Part 1 of 5 in [stack #12](https://github.com/o/r/stack/12), which replaces #9 with small reviewable steps. This PR is the bottom of the stack, based on `main`.\n\n## What this changes\n\nThe **TokenBucket** class refills on a [fixed](https://x) schedule, so the limiter now refills lazily on each take.";
    expect(summarize(body)).toBe("The TokenBucket class refills on a fixed schedule, so the limiter now refills lazily on each take.");
  });
  it("keeps normal descriptions", () => {
    expect(summarize("Adds a TokenBucket class.\n\nMore.")).toBe("Adds a TokenBucket class.");
  });
  it("splits conventional commit titles", () => {
    expect(splitConventional("feat(limiter): add TokenBucket")).toEqual({ tag: "feat(limiter)", text: "add TokenBucket" });
    expect(splitConventional("Plain title")).toEqual({ tag: null, text: "Plain title" });
  });
  it("formats layer ranges", () => {
    expect(formatRanges([6, 7, 8, 9, 2, 4, 5])).toBe("2, 4–9");
    expect(formatRanges([1, 2])).toBe("1, 2");
  });
  it("shows reviewer state on my own stacks", () => {
    const prs = [pr(1, "main", "a", { author: "me", reviewDecision: "APPROVED" }), pr(2, "a", "b", { author: "me" })];
    const s = buildStacks(repo, prs, [], "me")[0];
    expect(s.layers.map((l) => l.mine)).toEqual(["approved", "waiting"]);
    expect(progressLabel(s, "me")).toBe("1 of 2 approved");
  });
});

import { readSettings } from "../agent/settings";
describe("readSettings", () => {
  it("reads Claude-style config options, flattening groups", () => {
    const s = readSettings({
      configOptions: [
        { id: "mode", name: "Mode", category: "mode", type: "select", currentValue: "auto", options: [{ value: "default", name: "Default" }] },
        { id: "effort", name: "Effort", category: "thought_level", type: "select", currentValue: "high", options: [{ value: "low", name: "Low" }, { value: "high", name: "High" }] },
        { id: "model", name: "Model", category: "model", type: "select", currentValue: "opus", options: [{ group: "g", name: "Latest", options: [{ value: "opus", name: "Opus" }, { value: "sonnet", name: "Sonnet" }] }] },
      ] as never,
    });
    expect(s.map((x) => [x.kind, x.id, x.current, x.options.map((o) => o.value).join(",")])).toEqual([
      ["model", "model", "opus", "opus,sonnet"],
      ["effort", "effort", "high", "low,high"],
    ]);
  });
  it("falls back to the legacy models list (Gemini)", () => {
    const s = readSettings({ models: { currentModelId: "auto", availableModels: [{ modelId: "auto", name: "Auto" }, { modelId: "pro", name: "Pro" }] } });
    expect(s).toEqual([{ kind: "model", id: "model", via: "models", name: "Model", current: "auto", options: [{ value: "auto", name: "Auto", description: undefined }, { value: "pro", name: "Pro", description: undefined }] }]);
  });
});

import { isOwnTool, toolLabel } from "../agent/session";
describe("tool labels", () => {
  it("recognises and names Stack Reviewer's own tools", () => {
    expect(isOwnTool("mcp__stack-reviewer__get_review_context")).toBe(true);
    expect(isOwnTool("Bash")).toBe(false);
    expect(isOwnTool("mcp__github__create_issue")).toBe(false);
    expect(toolLabel("mcp__stack-reviewer__add_finding")).toBe("Recorded a finding");
    expect(toolLabel("mcp__github__create_issue")).toBe("github: create issue");
    expect(toolLabel("npm test")).toBe("npm test");
  });
});

import { AgentSession } from "../agent/session";
describe("AgentSession layer handoff", () => {
  const L = (index: number, pr: number, headSha = `sha${pr}`) => ({ index, total: 3, pr, title: `PR ${pr}`, headSha });
  it("adds a divider only once the conversation has history", () => {
    const s = new AgentSession("claude", "Claude Code", "acme/api#n1");
    s.moveTo(L(1, 10));
    expect(s.getSnapshot().items).toEqual([]);
    expect(s.getSnapshot().layer?.pr).toBe(10);
    // simulate an earlier exchange
    (s as unknown as { push: (i: unknown) => void }).push({ kind: "user", id: "u1", text: "hi" });
    s.moveTo(L(2, 11));
    const items = s.getSnapshot().items;
    expect(items.at(-1)).toMatchObject({ kind: "divider", text: "Layer 2 of 3 · #11 PR 11" });
    s.moveTo(L(2, 11)); // same layer: nothing new
    expect(s.getSnapshot().items).toHaveLength(items.length);
    s.moveTo(L(2, 11, "newsha"));
    expect(s.getSnapshot().items.at(-1)).toMatchObject({ kind: "divider", text: "Layer 2 of 3 · #11 PR 11 · new commits" });
  });
});

import { renderToStaticMarkup } from "react-dom/server";
import { Markdown } from "../ui/Markdown";
describe("Markdown", () => {
  it("renders agent-style markdown and drops raw HTML", () => {
    const html = renderToStaticMarkup(
      <Markdown text={"**What it does:** sets `RateLimit:Capacity`.\n\n- one\n- two\n\n1. **Is it right?** Yes.\n\n<script>alert(1)</script>\n\nSee [docs](https://example.com) and <b onclick=\"x()\">raw</b>.\n\n| a | b |\n|---|---|\n| 1 | 2 |"} />,
    );
    expect(html).toContain("<strong>What it does:</strong>");
    expect(html).toContain("<code>RateLimit:Capacity</code>");
    expect(html).toContain("<li>one</li>");
    expect(html).toContain("<ol>");
    expect(html).toContain('href="https://example.com"');
    expect(html).toContain("<table>");
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("onclick");
  });
});

import { buildDisplayRows, segments, toSplitRows } from "./diffModel";
describe("diff display model", () => {
  const patch = "@@ -3,3 +3,3 @@ fn\n c3\n-const a = 1;\n+const a = 2;\n c5\n@@ -20,2 +20,3 @@\n c20\n+added\n c21";
  const file = Array.from({ length: 30 }, (_, i) => `c${i + 1}`);
  it("adds expandable gaps when the full file is known", () => {
    const rows = buildDisplayRows(parsePatch(patch), file);
    const gaps = rows.filter((r) => r.kind === "gap");
    expect(gaps.map((g) => g.kind === "gap" && [g.position, g.newFrom, g.newTo])).toEqual([["top", 1, 2], ["middle", 6, 19], ["bottom", 23, 30]]);
  });
  it("expands from either edge and keeps old line numbers aligned", () => {
    const rows = buildDisplayRows(parsePatch(patch), file, { "middle:6": { fromTop: 2, fromBottom: 1 } });
    const shown = rows.filter((r) => r.kind === "ctx" && r.expanded);
    expect(shown.map((r) => r.kind === "ctx" && [r.oldLine, r.newLine, r.text])).toEqual([[6, 6, "c6"], [7, 7, "c7"], [19, 19, "c19"]]);
    const gap = rows.find((r) => r.kind === "gap" && r.position === "middle");
    expect(gap).toMatchObject({ newFrom: 8, newTo: 18 });
  });
  it("drops the hunk header once its gap is fully open", () => {
    const rows = buildDisplayRows(parsePatch(patch), file, { "middle:6": { fromTop: 99, fromBottom: 0 } });
    expect(rows.filter((r) => r.kind === "hunk")).toHaveLength(1);
  });
  it("shows non-expandable gaps without the file", () => {
    const rows = buildDisplayRows(parsePatch(patch), null);
    expect(rows.filter((r) => r.kind === "gap").map((g) => g.kind === "gap" && g.expandable)).toEqual([false, false]);
  });
  it("marks changed words in paired lines", () => {
    const rows = buildDisplayRows(parsePatch(patch), null);
    const del = rows.find((r) => r.kind === "del");
    const add = rows.find((r) => r.kind === "add");
    expect(del && del.kind === "del" && del.changes).toEqual([[10, 11]]);
    expect(add && add.kind === "add" && add.changes).toEqual([[10, 11]]);
  });
  it("merges syntax colours with change ranges", () => {
    const segs = segments("const a = 2;", [{ content: "const", color: "#f00" }, { content: " a = 2;", color: "#fff" }], [[10, 11]]);
    expect(segs).toEqual([
      { text: "const", color: "#f00", changed: undefined },
      { text: " a = ", color: "#fff", changed: undefined },
      { text: "2", color: "#fff", changed: true },
      { text: ";", color: "#fff", changed: undefined },
    ]);
  });
  it("pairs deletions and additions for split view", () => {
    const split = toSplitRows(buildDisplayRows(parsePatch(patch), null));
    const pairs = split.filter((r) => r.kind === "pair");
    expect(pairs[1]).toMatchObject({ left: { kind: "del" }, right: { kind: "add" } });
  });
});

import { languageFor, tokenize } from "./highlight";
describe("highlight", () => {
  it("maps paths to languages", () => {
    expect(languageFor("src/a.ts")).toBe("ts");
    expect(languageFor("Acme.Limiter/Thing.cs")).toBe("cs");
    expect(languageFor("Api.csproj")).toBe("xml");
    expect(languageFor("deploy/Dockerfile")).toBe("docker");
    expect(languageFor("README")).toBeNull();
  });
  it("tokenizes with colours, line by line", async () => {
    const t = await tokenize("const a = 1;\nreturn a;", "x.ts");
    expect(t).toHaveLength(2);
    expect(t![0].map((x) => x.content).join("")).toBe("const a = 1;");
    expect(new Set(t![0].map((x) => x.color)).size).toBeGreaterThan(1);
  });
});

import { pushRoute, upRoute, type Route } from "../app/nav";
describe("navigation history", () => {
  const r = { owner: "o", repo: "r" };
  const home: Route = { name: "home", section: "mine" };
  const ov: Route = { name: "overview", repo: r, stackKey: "n1" };
  const rev = (layer: number): Route => ({ name: "review", repo: r, stackKey: "n1", layer });
  it("Inbox from the overview after a review goes home, not back to the review", () => {
    let h: Route[] = [home];
    h = pushRoute(h, ov);
    h = pushRoute(h, rev(1));
    h = upRoute(h, ov); // review's Overview button
    expect(h).toEqual([home, ov]);
    h = upRoute(h, { name: "home" }); // overview's Inbox button
    expect(h).toEqual([home]); // keeps the section you were on
  });
  it("switching layers replaces rather than piling up history", () => {
    let h = pushRoute(pushRoute([home], ov), rev(1));
    h = pushRoute(h, rev(2));
    h = pushRoute(h, rev(3));
    expect(h).toEqual([home, ov, rev(3)]);
  });
  it("going up to a screen that isn't in history opens it", () => {
    const h = upRoute([home, rev(2)], ov); // e.g. opened a review from Recent
    expect(h).toEqual([home, rev(2), ov]);
    expect(upRoute(h, { name: "home" })).toEqual([home]);
    expect(upRoute([rev(1)], { name: "home" })).toEqual([{ name: "home" }]);
  });
});

import { findingDraftBody, reviewStore } from "./reviewStore";
describe("review store: findings to drafts", () => {
  const key = "t/t#1";
  const base = { pr: 1, path: "a.ts", line: 4, severity: "High" as const, title: "Unbounded map", body: "Never evicts.", agent: "Claude Code" };
  it("drafts with the default text or edited text, and undo restores the finding", () => {
    const f = reviewStore.addFinding(key, { ...base, suggestion: "const m = new LRU();" });
    reviewStore.setFindingStatus(key, f.id, "drafted");
    let st = reviewStore.get(key);
    expect(st.drafts.find((d) => d.findingId === f.id)?.body).toBe(findingDraftBody(f));
    expect(findingDraftBody(f)).toContain("```suggestion\nconst m = new LRU();\n```");

    reviewStore.setFindingStatus(key, f.id, "open");
    expect(reviewStore.get(key).drafts.some((d) => d.findingId === f.id)).toBe(false);

    reviewStore.setFindingStatus(key, f.id, "drafted", "Please bound this map.");
    st = reviewStore.get(key);
    const d = st.drafts.find((x) => x.findingId === f.id)!;
    expect(d.body).toBe("Please bound this map.");
    reviewStore.editDraft(key, d.id, "Please bound this map (LRU?).");
    expect(reviewStore.get(key).drafts.find((x) => x.id === d.id)?.body).toBe("Please bound this map (LRU?).");

    reviewStore.removeDraft(key, d.id); // removing the comment puts the finding back to open
    expect(reviewStore.get(key).findings.find((x) => x.id === f.id)?.status).toBe("open");
  });
});

describe("mergeability", () => {
  const base = { state: "OPEN" as const, isDraft: false };
  it("maps GitHub merge states to labels", () => {
    expect(mergeability({ ...base, mergeable: "CONFLICTING", mergeStateStatus: "DIRTY" })?.label).toBe("Conflicts");
    expect(mergeability({ ...base, mergeable: "MERGEABLE", mergeStateStatus: "BLOCKED" })?.label).toBe("Blocked");
    expect(mergeability({ ...base, mergeable: "MERGEABLE", mergeStateStatus: "BEHIND" })?.label).toBe("Behind base");
    expect(mergeability({ ...base, mergeable: "MERGEABLE", mergeStateStatus: "CLEAN" })?.label).toBe("Ready");
  });
  it("is null when unknown, missing or not open", () => {
    expect(mergeability({ ...base, mergeable: "UNKNOWN", mergeStateStatus: "UNKNOWN" })).toBeNull();
    expect(mergeability(base)).toBeNull();
    expect(mergeability({ state: "MERGED", isDraft: false, mergeable: "MERGEABLE", mergeStateStatus: "CLEAN" })).toBeNull();
  });
});

describe("restackPairs", () => {
  it("pairs each open layer with the head of the layer below", () => {
    const [stack] = buildStacks(repo, [pr(1, "main", "a"), pr(2, "a", "b"), pr(3, "b", "c")], [], "me");
    expect(restackPairs(stack)).toEqual([
      { layer: 2, lowerSha: "sha1", upperSha: "sha2" },
      { layer: 3, lowerSha: "sha2", upperSha: "sha3" },
    ]);
  });
  it("skips layers whose lower or own PR isn't open", () => {
    const [stack] = buildStacks(repo, [pr(1, "main", "a"), pr(2, "a", "b"), pr(3, "b", "c")], [], "me");
    stack.layers[0].pr.state = "MERGED";
    expect(restackPairs(stack).map((p) => p.layer)).toEqual([3]);
  });
});

describe("mergeConversation", () => {
  it("drops empty review bodies and sorts oldest first", () => {
    const out = mergeConversation(
      [{ id: "c", author: "a", body: "late", createdAt: "2026-11-03T00:00:00Z" }],
      [
        { id: "r1", author: "b", state: "APPROVED", body: "", createdAt: "2026-11-01T00:00:00Z" },
        { id: "r2", author: "b", state: "COMMENTED", body: "early", createdAt: "2026-11-02T00:00:00Z" },
      ],
    );
    expect(out.map((e) => e.id)).toEqual(["r2", "c"]);
    expect(out[1].kind).toBe("comment");
  });
});

describe("range comments", () => {
  const patch = "@@ -1,3 +1,4 @@\n a\n-b\n+B\n+B2\n c\n@@ -20,2 +21,2 @@\n x\n y";
  const rows = parsePatch(patch);
  it("accepts ranges inside one hunk, even across deleted lines", () => {
    expect(validRange(rows, 1, 4)).toBe(true);
    expect(validRange(rows, 2, 2)).toBe(true);
  });
  it("rejects ranges that span hunks, miss the diff or run backwards", () => {
    expect(validRange(rows, 3, 21)).toBe(false);
    expect(validRange(rows, 4, 6)).toBe(false);
    expect(validRange(rows, 9, 10)).toBe(false);
    expect(validRange(rows, 3, 2)).toBe(false);
  });
  it("clamps an invalid span to the clicked line", () => {
    expect(clampRange(rows, 4, 2)).toEqual({ start: 2, end: 4 });
    expect(clampRange(rows, 2, 21)).toEqual({ start: 21, end: 21 });
  });
  it("pre-fills suggestions with the new-side text", () => {
    expect(newSideLines(rows, 2, 3)).toEqual(["B", "B2"]);
    expect(newSideLines(rows, 4, 5)).toBeNull();
    expect(suggestionBlock(["B", "B2"])).toBe("```suggestion\nB\nB2\n```");
    expect(suggestionBlock(["```x```"])).toBe("````suggestion\n```x```\n````");
  });
  it("labels ranges", () => {
    expect(rangeLabel(9, 4)).toBe("L4–9");
    expect(rangeLabel(9)).toBe("L9");
    expect(rangeLabel(9, 9, ":")).toBe(":9");
  });
});
