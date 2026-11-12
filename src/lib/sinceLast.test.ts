import { describe, expect, it } from "vitest";
import type { Layer, MyLayerState, Stack } from "./model";
import { diffSince, markAllSeen, snapshotStack, stackId } from "./sinceLast";

const repo = { owner: "acme", repo: "api" };

function layer(index: number, sha: string, checks: "pass" | "fail" | "pending" | "none" = "pass", mine: MyLayerState = "todo"): Layer {
  return { index, mine, pr: { number: 100 + index, headSha: sha, checks, state: "OPEN" } as Layer["pr"] };
}
const stack = (key: string, layers: Layer[]): Stack => ({ key, source: "native", repo, title: key, author: "a", baseRef: "main", layers, updatedAt: "", checks: "pass" });

describe("diffSince", () => {
  const s = stack("n1", [layer(1, "a"), layer(2, "b")]);
  const id = stackId(s);

  it("flags unseen stacks only when they need review", () => {
    expect(diffSince({}, [s], new Set([id])).map((c) => c.kind)).toEqual(["new"]);
    expect(diffSince({}, [s], new Set())).toEqual([]);
  });

  it("reports nothing when nothing changed", () => {
    expect(diffSince({ [id]: snapshotStack(s, true) }, [s], new Set([id]))).toEqual([]);
  });

  it("reports layers with new head commits", () => {
    const seen = { [id]: snapshotStack(s, true) };
    const now = stack("n1", [layer(1, "a"), layer(2, "c")]);
    const c = diffSince(seen, [now], new Set([id]));
    expect(c).toHaveLength(1);
    expect(c[0]).toMatchObject({ kind: "commits", layers: [2] });
  });

  it("reports checks that newly fail, not ones that already failed", () => {
    const before = stack("n1", [layer(1, "a", "fail"), layer(2, "b", "pass")]);
    const seen = { [id]: snapshotStack(before, true) };
    const now = stack("n1", [layer(1, "a", "fail"), layer(2, "b", "fail")]);
    expect(diffSince(seen, [now], new Set([id]))).toMatchObject([{ kind: "failing", layers: [2] }]);
  });

  it("flags a seen stack that newly needs review", () => {
    const seen = { [id]: snapshotStack(s, false) };
    expect(diffSince(seen, [s], new Set([id])).map((c) => c.kind)).toEqual(["new"]);
  });

  it("ignores layers added since (no baseline sha) for commits", () => {
    const seen = { [id]: snapshotStack(s, true) };
    const now = stack("n1", [layer(1, "a"), layer(2, "b"), layer(3, "z")]);
    expect(diffSince(seen, [now], new Set([id]))).toEqual([]);
  });

  it("markAllSeen clears every change", () => {
    const now = stack("n1", [layer(1, "x", "fail", "turn")]);
    const needs = new Set([stackId(now)]);
    const seen = markAllSeen({}, [now], needs);
    expect(diffSince(seen, [now], needs)).toEqual([]);
  });
});
