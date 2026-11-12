import { describe, expect, it, vi } from "vitest";
import { agentSessionKey, getAgentSession, stopAllAgentSessions } from "./session";
import { worktreeSlot } from "./useStackAgent";
import { resetForAccountChange } from "../app/accountSwitch";

describe("agent session keys", () => {
  it("include the login, stack and agent", () => {
    expect(agentSessionKey("alex-r", "acme/orders-api#s1", "claude")).toBe("alex-r@acme/orders-api#s1|claude");
    expect(agentSessionKey("alex-r", "acme/orders-api#s1", "claude")).not.toBe(agentSessionKey("priya-k", "acme/orders-api#s1", "claude"));
  });

  it("gives each account its own session for the same stack", () => {
    const a = getAgentSession("alex-r", "acme/orders-api#s1", "claude", "Claude Code");
    const b = getAgentSession("priya-k", "acme/orders-api#s1", "claude", "Claude Code");
    expect(a).not.toBe(b);
    expect(getAgentSession("alex-r", "acme/orders-api#s1", "claude", "Claude Code")).toBe(a);
  });

  it("gives each account its own checkout slot", () => {
    expect(worktreeSlot("alex-r", "s1", "claude")).not.toBe(worktreeSlot("priya-k", "s1", "claude"));
    expect(worktreeSlot("alex-r", "feat/x y", "claude")).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(worktreeSlot("alex-r", "k".repeat(200), "claude")).toHaveLength(64);
    expect(worktreeSlot("alex-r", "k".repeat(200), "claude").startsWith("alex-r-claude-")).toBe(true);
  });
});

describe("switching accounts", () => {
  it("clears the query cache and stops every running agent session", async () => {
    const s1 = getAgentSession("alex-r", "acme/orders-api#s2", "claude", "Claude Code");
    const s2 = getAgentSession("priya-k", "acme/orders-api#s3", "gemini", "Gemini CLI");
    const stop1 = vi.spyOn(s1, "stop").mockResolvedValue();
    const stop2 = vi.spyOn(s2, "stop").mockResolvedValue();
    const clear = vi.fn();
    await resetForAccountChange({ clear });
    expect(clear).toHaveBeenCalledTimes(1);
    expect(stop1).toHaveBeenCalled();
    expect(stop2).toHaveBeenCalled();
  });

  it("stopAllAgentSessions survives a session that fails to stop", async () => {
    const s = getAgentSession("alex-r", "acme/orders-api#s4", "claude", "Claude Code");
    vi.spyOn(s, "stop").mockRejectedValue(new Error("boom"));
    await expect(stopAllAgentSessions()).resolves.toBeUndefined();
  });
});
