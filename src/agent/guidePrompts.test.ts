import { describe, expect, it } from "vitest";
import { guideRefreshPrompt, guideStackPrompt, toolLabel } from "./session";

describe("guide prompts", () => {
  it("the full prompt lists every layer, forbids findings and asks for the stack guide last", () => {
    const p = guideStackPrompt([{ index: 1, number: 412, title: "Core" }, { index: 2, number: 413, title: "Wire" }]);
    expect(p).toContain("#412 Core");
    expect(p).toContain("#413 Wire");
    expect(p).toContain("set_layer_guide");
    expect(p).toContain("set_stack_guide");
    expect(p).toMatch(/Do not record findings/);
    expect(p).toMatch(/Size alone is not complexity/);
  });

  it("the refresh prompt lists only stale layers and carries the others' tier, reason and role", () => {
    const p = guideRefreshPrompt([{ index: 3, number: 415, title: "Tenants" }], [{ number: 412, tier: "light", reason: "tiny class", role: "The bucket" }]);
    expect(p).toContain("#415 Tenants");
    expect(p).not.toContain("#412 Core");
    expect(p).toContain("#412: light · tiny class · role: The bucket");
    expect(p).toContain("set_stack_guide again");
  });

  it("labels the guide tools", () => {
    expect(toolLabel("mcp__stack-reviewer__set_layer_guide", { pr: 413 })).toBe("Guided layer #413");
    expect(toolLabel("mcp__stack-reviewer__set_layer_guide")).toBe("Guided a layer");
    expect(toolLabel("mcp__stack-reviewer__set_stack_guide")).toBe("Wrote the stack guide");
  });
});
