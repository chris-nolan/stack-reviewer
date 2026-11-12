// The review screen registers itself here so agent tools (served over MCP) can read the
// current review context and write findings into the UI.

import type { Severity } from "../lib/model";

export type FindingInput = { pr?: number; path: string; line: number; severity: Severity; title: string; body: string; suggestion?: string };

export type ReviewBridge = {
  context(): unknown;
  addFinding(f: FindingInput, agent: string): { ok: true; id: string } | { ok: false; error: string };
  setBrief(summary: string, readingOrder: string[]): void;
  setSummary(text: string): void;
  checkFailures(pr?: number): Promise<string>;
};

let current: ReviewBridge | null = null;

export const reviewBridge = {
  set(b: ReviewBridge | null) {
    current = b;
  },
  get(): ReviewBridge | null {
    return current;
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
