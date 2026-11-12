import { describe, expect, it } from "vitest";
import { buildStacks, myLayerState, resumeLayer, type NativeStack } from "./stacks";
import { parsePatch, toSplit, commentableLines } from "./diff";
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
