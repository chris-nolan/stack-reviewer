import { describe, expect, it } from "vitest";
import { fuzzyFilter, fuzzyScore } from "./fuzzy";
import { applyFileFilters, extensionChips, filterCounts, fileExt, type FileFacts } from "./fileFilters";

describe("fuzzy", () => {
  it("rejects non-matches and accepts empty query", () => {
    expect(fuzzyScore("xyz", "settings")).toBeNull();
    expect(fuzzyScore("", "anything")).toBe(0);
  });
  it("ranks prefix over word-start over inner substring over subsequence", () => {
    const p = fuzzyScore("set", "Settings")!;
    const w = fuzzyScore("set", "Go to settings")!;
    const i = fuzzyScore("set", "Reset")!;
    const s = fuzzyScore("stg", "Settings")!;
    expect(p).toBeGreaterThan(w);
    expect(w).toBeGreaterThan(i);
    expect(i).toBeGreaterThan(s);
  });
  it("matches subsequences across word starts", () => {
    expect(fuzzyScore("gti", "Go to inbox")).not.toBeNull();
  });
  it("filters and sorts, keeping order on empty query", () => {
    const items = ["Reset", "Settings", "Go to settings"];
    expect(fuzzyFilter(items, "set", (x) => x)).toEqual(["Settings", "Go to settings", "Reset"]);
    expect(fuzzyFilter(items, "", (x) => x)).toEqual(items);
    expect(fuzzyFilter(items, "zzz", (x) => x)).toEqual([]);
  });
  it("uses the best of several texts", () => {
    expect(fuzzyFilter([{ a: "foo", b: "bar" }], "bar", (x) => [x.a, x.b])).toHaveLength(1);
  });
});

const f = (path: string, o: Partial<FileFacts> = {}): FileFacts => ({ path, viewed: false, openFindings: 0, openThreads: 0, drafts: 0, ...o });

describe("file filters", () => {
  const files = [f("a.ts", { viewed: true }), f("b.ts", { openFindings: 2 }), f("c.md", { openThreads: 1 }), f("d.ts", { drafts: 1 }), f("Makefile")];
  const paths = (x: FileFacts[]) => x.map((y) => y.path);
  it("counts", () => {
    expect(filterCounts(files)).toEqual({ all: 5, unviewed: 4, findings: 1, comments: 2 });
  });
  it("filters by kind", () => {
    expect(paths(applyFileFilters(files, { kind: "unviewed", ext: null }))).toEqual(["b.ts", "c.md", "d.ts", "Makefile"]);
    expect(paths(applyFileFilters(files, { kind: "findings", ext: null }))).toEqual(["b.ts"]);
    expect(paths(applyFileFilters(files, { kind: "comments", ext: null }))).toEqual(["c.md", "d.ts"]);
  });
  it("filters by extension, including extensionless files", () => {
    expect(paths(applyFileFilters(files, { kind: "all", ext: "md" }))).toEqual(["c.md"]);
    expect(paths(applyFileFilters(files, { kind: "all", ext: "other" }))).toEqual(["Makefile"]);
  });
  it("never hides the current file", () => {
    expect(paths(applyFileFilters(files, { kind: "findings", ext: null }, "a.ts"))).toEqual(["a.ts", "b.ts"]);
  });
  it("offers extension chips only with more than one type", () => {
    expect(extensionChips([{ path: "a.ts" }, { path: "b.ts" }])).toEqual([]);
    expect(extensionChips(files)).toEqual([{ ext: "ts", count: 3 }, { ext: "md", count: 1 }, { ext: "other", count: 1 }]);
    expect(fileExt(".gitignore")).toBe("other");
  });
});
