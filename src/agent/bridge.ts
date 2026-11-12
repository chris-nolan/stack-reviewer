// Connects agent tool calls (served over MCP) to the review UI.
//
// - Each open stack registers a ReviewBridge (keyed by stack id) that can read context and write
//   findings for any of its layers. Bridges outlive the review screen, so an agent that is still
//   working when you go back to the overview keeps writing to the right place.
// - Each agent session gets a token, sent as the `x-sr-session` header on its MCP connection,
//   that says which stack it belongs to and which layer it is currently working on.

import type { Severity } from "../lib/model";

export type FindingInput = { pr?: number; path: string; line: number; severity: Severity; title: string; body: string; suggestion?: string };

export type ToolResult = { ok: true; id: string } | { ok: false; error: string };

export type ReviewBridge = {
  /** Stack plus the given layer's details, for get_review_context. */
  context(pr: number): Promise<unknown>;
  addFinding(pr: number, f: FindingInput, agent: string): Promise<ToolResult>;
  setBrief(pr: number, summary: string, readingOrder: string[], agent: string): void;
  setSummary(pr: number, text: string): void;
  checkFailures(pr: number): Promise<string>;
};

export type AgentContext = { stackId: string; agentName: string; activePr: () => number | null };

const g = globalThis as typeof globalThis & {
  __srBridges?: Map<string, ReviewBridge>;
  __srAgentContexts?: Map<string, AgentContext>;
};
const bridges = (g.__srBridges ??= new Map());
const contexts = (g.__srAgentContexts ??= new Map());

export const reviewBridge = {
  set(stackId: string, b: ReviewBridge) {
    bridges.set(stackId, b);
  },
  get(stackId: string): ReviewBridge | null {
    return bridges.get(stackId) ?? null;
  },
};

export const agentContexts = {
  set(token: string, ctx: AgentContext) {
    contexts.set(token, ctx);
  },
  get(token: string): AgentContext | null {
    return contexts.get(token) ?? null;
  },
  delete(token: string) {
    contexts.delete(token);
  },
};

/** Parses ```findings fenced JSON blocks, the fallback for agents without HTTP MCP support. */
export function parseFindingBlocks(text: string): FindingInput[] {
  const out: FindingInput[] = [];
  const re = /```findings\s*\n([\s\S]*?)```/g;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    try {
      const v = JSON.parse(m[1]);
      for (const f of Array.isArray(v) ? v : [v]) {
        if (f && typeof f.path === "string" && Number.isFinite(f.line) && f.title) {
          out.push({
            path: f.path, line: Number(f.line), title: String(f.title), body: String(f.body ?? ""),
            severity: (["High", "Medium", "Low"].includes(f.severity) ? f.severity : "Medium") as Severity,
            suggestion: f.suggestion ? String(f.suggestion) : undefined,
          });
        }
      }
    } catch {
      /* ignore malformed block */
    }
  }
  return out;
}
