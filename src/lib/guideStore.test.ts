import { describe, expect, it } from "vitest";
import { focusProgress, type LayerGuide } from "./guide";
import { guideStore } from "./guideStore";
import { reviewStore } from "./reviewStore";

const guide = (pr: number, ids: string[], head = "h1"): LayerGuide => ({
  pr, headSha: head, agent: "a", createdAt: 1, tier: "moderate", tierReason: "r", skim: [], questions: [],
  focus: ids.map((id) => ({ id, path: "a.ts", line: 1, title: id, why: "w" })),
});

describe("guideStore run state", () => {
  it("takes guided layers off the pending list and finishes when the stack guide lands", () => {
    const k = "o/r#t1";
    guideStore.startRun(k, { pending: [1, 2], total: 2, kind: "all", agent: "a" });
    guideStore.markReading(k, 1);
    expect(guideStore.get(k).run?.reading).toBe(1);
    guideStore.setLayer(k, guide(1, ["x"]));
    expect(guideStore.get(k).run).toMatchObject({ pending: [2], reading: undefined, status: "running" });
    guideStore.setLayer(k, guide(2, ["y"]));
    guideStore.setStack(k, { agent: "a", createdAt: 2, summary: "s", layerRoles: [], crossLayer: [], plan: "p", ranking: [2, 1] });
    expect(guideStore.get(k).run?.status).toBe("done");
    expect(Object.keys(guideStore.get(k).layers)).toEqual(["1", "2"]);
  });

  it("keeps finished layers when stopped, and shows a run that died with the app as stopped", () => {
    const k = "o/r#t2";
    guideStore.startRun(k, { pending: [1, 2, 3], total: 3, kind: "all", agent: "a" });
    guideStore.setLayer(k, guide(1, ["x"]));
    guideStore.finishRun(k, "stopped");
    expect(guideStore.get(k).run).toMatchObject({ status: "stopped", pending: [2, 3] });
    expect(guideStore.get(k).layers[1]).toBeDefined();
    // A persisted "running" run with no live agent (app restart) is presented as stopped.
    guideStore.replace("o/r#t3", { stackKey: "o/r#t3", layers: {}, run: { status: "running", pending: [1], total: 1, kind: "all", agent: "a", startedAt: 1 } });
    expect(guideStore.view("o/r#t3").run?.status).toBe("stopped");
  });
});

describe("focus ticks survive a refresh", () => {
  it("keeps ticks in reviewStore while the layer guide is replaced", () => {
    const sid = "o/r#t4";
    const key = "o/r#901";
    guideStore.setLayer(sid, guide(901, ["keep", "drop"]));
    reviewStore.setFocusDone(key, "keep", true);
    reviewStore.setFocusDone(key, "drop", true);
    reviewStore.setFocusDone(key, "keep", true); // idempotent
    expect(reviewStore.get(key).focusDone).toEqual(["keep", "drop"]);

    // Refresh: a new head, one area kept, one new.
    guideStore.setLayer(sid, guide(901, ["keep", "fresh"], "h2"));
    const g = guideStore.get(sid).layers[901];
    expect(g.headSha).toBe("h2");
    expect(focusProgress(g.focus, reviewStore.get(key).focusDone)).toEqual({ done: 1, total: 2 });

    reviewStore.setFocusDone(key, "keep", false);
    expect(focusProgress(g.focus, reviewStore.get(key).focusDone)).toEqual({ done: 0, total: 2 });
  });
});
