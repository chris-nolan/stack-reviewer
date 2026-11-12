import { describe, expect, it } from "vitest";
import { applyFileFilters, filterCounts, NO_FILTER, type FileFacts } from "./fileFilters";

const f = (path: string, extra: Partial<FileFacts> = {}): FileFacts => ({ path, viewed: false, openFindings: 0, openThreads: 0, drafts: 0, ...extra });
const files = [f("a.ts", { focus: 2 }), f("b.ts", { skim: true }), f("c.ts"), f("d.lock", { skim: true, focus: 0 })];

describe("guide file filters", () => {
  it("Focus keeps files with focus areas, Hide skim drops skim files", () => {
    expect(applyFileFilters(files, { ...NO_FILTER, kind: "focus" }).map((x) => x.path)).toEqual(["a.ts"]);
    expect(applyFileFilters(files, { ...NO_FILTER, hideSkim: true }).map((x) => x.path)).toEqual(["a.ts", "c.ts"]);
  });

  it("never hides the current file", () => {
    expect(applyFileFilters(files, { ...NO_FILTER, hideSkim: true }, "b.ts").map((x) => x.path)).toEqual(["a.ts", "b.ts", "c.ts"]);
  });

  it("counts focus files", () => {
    expect(filterCounts(files).focus).toBe(1);
  });
});
