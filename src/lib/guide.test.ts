import { describe, expect, it } from "vitest";
import { focusId, focusProgress, guideTargets, isStale, ordinal, rankLabel, rankOf, stackGuideStale, validateLayerGuide, validateStackGuide, type GuideDoc, type LayerGuide } from "./guide";

const patchA = "@@ -10,3 +10,5 @@\n a\n+b\n+c\n d\n e\n@@ -40,2 +42,3 @@\n x\n+y\n z";
const files = [{ path: "src/a.ts", patch: patchA }, { path: "lock.json", patch: "@@ -1 +1 @@\n-a\n+b" }, { path: "src/b.ts", patch: "@@ -0,0 +1,2 @@\n+one\n+two" }];

const base = {
  summary: "Does a thing.", tier: "heavy", tier_reason: "risky",
  focus_areas: [{ path: "src/a.ts", start_line: 10, line: 12, title: "Core change", why: "check it" }],
  skim: [{ path: "lock.json", why: "lockfile" }],
  questions: ["why?"],
};

describe("validateLayerGuide", () => {
  it("accepts a valid guide and derives focus ids", () => {
    const r = validateLayerGuide(base, 7, "sha1", files);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.focus[0]).toMatchObject({ path: "src/a.ts", startLine: 10, line: 12, title: "Core change", id: focusId("src/a.ts", "Core change") });
    expect(r.value.headSha).toBe("sha1");
  });

  it("rejects a range that isn't in the diff and names the valid hunks", () => {
    const r = validateLayerGuide({ ...base, focus_areas: [{ path: "src/a.ts", line: 30, title: "t", why: "w" }] }, 7, "s", files);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain("src/a.ts");
    expect(r.error).toMatch(/Valid ranges: 10–14 \| 42–44/);
  });

  it("rejects a range that spans two hunks", () => {
    const r = validateLayerGuide({ ...base, focus_areas: [{ path: "src/a.ts", start_line: 12, line: 43, title: "t", why: "w" }] }, 7, "s", files);
    expect(r.ok).toBe(false);
  });

  it("rejects focus or skim paths not changed in the layer", () => {
    const f = validateLayerGuide({ ...base, focus_areas: [{ path: "nope.ts", line: 1, title: "t", why: "w" }] }, 7, "s", files);
    expect(!f.ok && f.error).toContain("not changed in #7");
    const s = validateLayerGuide({ ...base, skim: [{ path: "nope.ts", why: "x" }] }, 7, "s", files);
    expect(!s.ok && s.error).toContain("skim[0]");
  });

  it("needs 1-5 focus areas, a valid tier and a reason", () => {
    expect(validateLayerGuide({ ...base, focus_areas: [] }, 7, "s", files).ok).toBe(false);
    const six = Array.from({ length: 6 }, (_, i) => ({ path: "src/a.ts", line: 10, title: `t${i}`, why: "w" }));
    expect(validateLayerGuide({ ...base, focus_areas: six }, 7, "s", files).ok).toBe(false);
    const r = validateLayerGuide({ ...base, tier: "huge", tier_reason: "" }, 7, "s", files);
    expect(!r.ok && r.error).toMatch(/tier.*\n.*tier_reason/s);
  });

  it("caps questions at 4 and drops duplicate skim paths", () => {
    const r = validateLayerGuide({ ...base, questions: ["1", "2", "3", "4", "5"], skim: [{ path: "lock.json", why: "a" }, { path: "lock.json", why: "b" }] }, 7, "s", files);
    expect(r.ok && r.value.questions.length).toBe(4);
    expect(r.ok && r.value.skim.length).toBe(1);
  });

  it("drops a skim entry for a file that also has a focus area", () => {
    const r = validateLayerGuide({ ...base, skim: [{ path: "src/a.ts", why: "x" }, { path: "lock.json", why: "y" }] }, 7, "s", files);
    expect(r.ok && r.value.skim.map((s) => s.path)).toEqual(["lock.json"]);
  });

  it("keeps ids unique when two focus areas share path and title", () => {
    const two = [{ path: "src/a.ts", line: 10, title: "Same", why: "w" }, { path: "src/a.ts", line: 11, title: "Same", why: "w" }];
    const r = validateLayerGuide({ ...base, focus_areas: two }, 7, "s", files);
    expect(r.ok && new Set(r.value.focus.map((f) => f.id)).size).toBe(2);
  });
});

describe("focusId", () => {
  it("is stable for the same path and title and ignores case/spacing", () => {
    expect(focusId("a.ts", "Retry  logic")).toBe(focusId("a.ts", " retry logic "));
    expect(focusId("a.ts", "x")).not.toBe(focusId("b.ts", "x"));
    expect(focusId("a.ts", "x")).not.toBe(focusId("a.ts", "y"));
  });

  it("keeps a tick when a refresh keeps the same focus area (and drops it for a new one)", () => {
    const before = validateLayerGuide(base, 7, "old", files);
    const refreshed = validateLayerGuide({ ...base, focus_areas: [base.focus_areas[0], { path: "src/b.ts", line: 1, title: "New area", why: "w" }] }, 7, "new", files);
    if (!before.ok || !refreshed.ok) throw new Error("setup");
    const ticked = [before.value.focus[0].id];
    expect(focusProgress(refreshed.value.focus, ticked)).toEqual({ done: 1, total: 2 });
    const changed = validateLayerGuide({ ...base, focus_areas: [{ ...base.focus_areas[0], title: "Reworded" }] }, 7, "new", files);
    expect(changed.ok && focusProgress(changed.value.focus, ticked)).toEqual({ done: 0, total: 1 });
  });
});

const lg = (pr: number, headSha: string): LayerGuide => ({ pr, headSha, agent: "a", createdAt: 1, tier: "light", tierReason: "r", focus: [], skim: [], questions: [] });
const layer = (n: number, headSha: string, state = "OPEN") => ({ pr: { number: n, headSha, state } });

describe("staleness", () => {
  const doc: GuideDoc = { stackKey: "k", layers: { 1: lg(1, "a"), 2: lg(2, "b"), 3: lg(3, "c") }, stack: { agent: "a", createdAt: 1, summary: "s", layerRoles: [], crossLayer: [], plan: "p", ranking: [1, 2, 3] } };

  it("marks a layer stale only when its head moves", () => {
    expect(isStale(doc.layers[1], "a")).toBe(false);
    expect(isStale(doc.layers[1], "a2")).toBe(true);
    expect(isStale(undefined, "x")).toBe(false);
  });

  it("finds stale, missing and removed layers", () => {
    const t = guideTargets(doc, [layer(1, "a"), layer(2, "b2"), layer(3, "c", "MERGED"), layer(4, "d")]);
    expect(t).toEqual({ stale: [2], missing: [4], removed: [3] });
  });

  it("the stack guide is stale when any layer is stale or the open set changed", () => {
    expect(stackGuideStale(doc, [layer(1, "a"), layer(2, "b"), layer(3, "c")])).toBe(false);
    expect(stackGuideStale(doc, [layer(1, "a"), layer(2, "x"), layer(3, "c")])).toBe(true);
    expect(stackGuideStale(doc, [layer(1, "a"), layer(2, "b")])).toBe(true);
    expect(stackGuideStale(doc, [layer(1, "a"), layer(2, "b"), layer(3, "c"), layer(4, "d")])).toBe(true);
    expect(stackGuideStale({ stackKey: "k", layers: {} }, [layer(1, "a")])).toBe(false);
  });
});

describe("validateStackGuide", () => {
  const ok = { summary: "s", plan: "p", layer_roles: [{ pr: 1, role: "r" }, { pr: 99, role: "dropped" }], cross_layer: [{ text: "t", prs: [1, 99] }], ranking: [2, 1, 3] };

  it("accepts a ranking with each guided PR exactly once", () => {
    const r = validateStackGuide(ok, [1, 2, 3], [1, 2, 3]);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.ranking).toEqual([2, 1, 3]);
      expect(r.value.layerRoles).toEqual([{ pr: 1, role: "r" }]);
      expect(r.value.crossLayer[0].prs).toEqual([1]);
    }
  });

  it("rejects duplicates, missing and unknown PRs", () => {
    const dup = validateStackGuide({ ...ok, ranking: [1, 1, 2, 3] }, [1, 2, 3], [1, 2, 3]);
    expect(!dup.ok && dup.error).toContain("repeats #1");
    const missing = validateStackGuide({ ...ok, ranking: [1, 2] }, [1, 2, 3], [1, 2, 3]);
    expect(!missing.ok && missing.error).toContain("missing #3");
    const unknown = validateStackGuide({ ...ok, ranking: [1, 2, 3, 7] }, [1, 2, 3], [1, 2, 3]);
    expect(!unknown.ok && unknown.error).toContain("#7");
  });

  it("asks for set_layer_guide on layers that have none yet", () => {
    const r = validateStackGuide({ ...ok, ranking: [1, 2] }, [1, 2, 3], [1, 2]);
    expect(!r.ok && r.error).toContain("#3");
    expect(!r.ok && r.error).toContain("set_layer_guide");
  });
});

describe("ranking labels", () => {
  it("derives '2nd of 5' from the ranking", () => {
    expect(rankLabel(rankOf([413, 412, 415, 416, 418], 412))).toBe("2nd of 5");
    expect(rankOf([1], 2)).toBeNull();
    expect([1, 2, 3, 4, 11, 12, 13, 21, 22, 23].map(ordinal)).toEqual(["1st", "2nd", "3rd", "4th", "11th", "12th", "13th", "21st", "22nd", "23rd"]);
  });
});
