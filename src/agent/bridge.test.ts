import { describe, expect, it } from "vitest";
import { parseGuideBlocks } from "./bridge";

const fence = (body: string) => "Here you go:\n```guide\n" + body + "\n```\nDone.";

describe("parseGuideBlocks", () => {
  it("parses layer and stack objects from an array", () => {
    const out = parseGuideBlocks(fence(JSON.stringify([{ layer: { pr: 412, tier: "light" } }, { stack: { summary: "s", ranking: [412] } }])));
    expect(out).toEqual([
      { kind: "layer", pr: 412, input: { pr: 412, tier: "light" } },
      { kind: "stack", input: { summary: "s", ranking: [412] } },
    ]);
  });

  it("accepts bare layer and stack fields", () => {
    const out = parseGuideBlocks(fence(JSON.stringify([{ pr: 3, tier: "heavy", summary: "x" }, { ranking: [3], summary: "s" }])));
    expect(out.map((b) => b.kind)).toEqual(["layer", "stack"]);
  });

  it("reads several blocks and ignores malformed ones and findings blocks", () => {
    const text = [fence('{"layer": {"pr": 1, "tier": "light"}}'), "```guide\n{not json\n```", "```findings\n[{\"path\":\"a\",\"line\":1,\"title\":\"t\"}]\n```", fence('{"stack": {"ranking": [1]}}')].join("\n");
    expect(parseGuideBlocks(text).map((b) => b.kind)).toEqual(["layer", "stack"]);
  });

  it("skips layer entries without a numeric pr", () => {
    expect(parseGuideBlocks(fence('[{"layer": {"pr": "x", "tier": "light"}}]'))).toEqual([]);
    expect(parseGuideBlocks("no blocks")).toEqual([]);
  });
});
