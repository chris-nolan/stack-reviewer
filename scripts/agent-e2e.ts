// End-to-end check of the agent tool path without the desktop shell: serves the app's MCP tool
// handler over HTTP with a fake review, starts Claude Code over ACP, and asks it to use the tools.
// Usage: bun scripts/agent-e2e.ts   (uses your local Claude Code login; one short prompt)

import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handle } from "../src/agent/mcpServer";
import { reviewBridge } from "../src/agent/bridge";

const findings: unknown[] = [];
reviewBridge.set({
  context: () => ({
    repository: "acme/orders-api",
    layer_under_review: { pr: 413, title: "Wire limiter into request middleware", files: [{ path: "src/middleware/rateLimit.ts", status: "added" }] },
  }),
  addFinding: (f) => {
    if (f.path !== "src/middleware/rateLimit.ts" || f.line < 1 || f.line > 20) return { ok: false, error: "Line not in diff; use 1-20" };
    findings.push(f);
    return { ok: true, id: `F${findings.length}` };
  },
  setBrief: () => {},
  setSummary: () => {},
  checkFailures: async () => "No failing checks.",
});

const calls: string[] = [];
const server = Bun.serve({
  port: 0,
  async fetch(req) {
    if (req.method !== "POST") return new Response(null, { status: 405 });
    const msg = await req.json();
    if (msg.method === "tools/call") calls.push(msg.params.name);
    const reply = await handle(msg);
    return reply ? Response.json(reply) : new Response(null, { status: 202 });
  },
});

const dir = mkdtempSync(join(tmpdir(), "sr-e2e-"));
writeFileSync(join(dir, "rateLimit.ts"), "const buckets = new Map();\n");
const child = spawn("npx", ["-y", "@agentclientprotocol/claude-agent-acp@0.106.0"], { cwd: dir, stdio: ["pipe", "pipe", "ignore"] });
const pending = new Map<number, (v: any) => void>();
let id = 0;
let text = "";
createInterface({ input: child.stdout! }).on("line", (line) => {
  let m: any;
  try { m = JSON.parse(line); } catch { return; }
  if (m.method === "session/update" && m.params.update.sessionUpdate === "agent_message_chunk") text += m.params.update.content.text ?? "";
  if (m.method === "session/request_permission") {
    child.stdin!.write(JSON.stringify({ jsonrpc: "2.0", id: m.id, result: { outcome: { outcome: "selected", optionId: m.params.options.find((o: any) => o.kind === "allow_once")?.optionId } } }) + "\n");
  }
  if (m.id != null && !m.method && pending.has(m.id)) { pending.get(m.id)!(m); pending.delete(m.id); }
});
const rpc = (method: string, params: unknown) => new Promise<any>((r) => { const n = ++id; pending.set(n, r); child.stdin!.write(JSON.stringify({ jsonrpc: "2.0", id: n, method, params }) + "\n"); });

setTimeout(() => { console.log("TIMEOUT", { calls, findings }); child.kill(); process.exit(1); }, 240_000);
await rpc("initialize", { protocolVersion: 1, clientCapabilities: {} });
const s = await rpc("session/new", { cwd: dir, mcpServers: [{ type: "http", name: "stack-reviewer", url: `http://127.0.0.1:${server.port}/mcp/test`, headers: [] }] });
const res = await rpc("session/prompt", {
  sessionId: s.result.sessionId,
  prompt: [{ type: "text", text: "Use the stack-reviewer MCP tools only (no shell). Call get_review_context, then call add_finding once for src/middleware/rateLimit.ts line 4, severity High, title 'Unbounded map', body 'Never evicts.'. Then reply with just the PR number." }],
});
console.log("stopReason:", res.result?.stopReason ?? res.error);
console.log("tool calls:", calls.join(", "));
console.log("findings:", JSON.stringify(findings));
console.log("reply:", text.trim().slice(0, 200));
child.kill();
server.stop();
process.exit(calls.includes("add_finding") && findings.length ? 0 : 1);
