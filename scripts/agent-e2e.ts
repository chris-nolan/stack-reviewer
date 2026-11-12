// End-to-end check of the agent tool path without the desktop shell: serves the app's MCP tool
// handler over HTTP with a fake two-layer stack, starts Claude Code over ACP in ask-before-running
// mode, and has it work on layer 1 then layer 2 in one conversation.
// Usage: bun scripts/agent-e2e.ts   (uses your local Claude Code login; two short prompts)

import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handle } from "../src/agent/mcpServer";
import { agentContexts, reviewBridge } from "../src/agent/bridge";
import { isOwnTool } from "../src/agent/session";

const STACK = "acme/orders-api#n1";
const TOKEN = "test-session";
let activePr = 412;
const findings: { pr: number; path: string; line: number }[] = [];
const FILES: Record<number, string> = { 412: "src/limiter/tokenBucket.ts", 413: "src/middleware/rateLimit.ts" };
reviewBridge.set(STACK, {
  context: async (pr) => ({ stack: { layers: [{ index: 1, pr: 412 }, { index: 2, pr: 413 }] }, current_layer: { pr, files: [{ path: FILES[pr], status: "added" }] } }),
  addFinding: async (pr, f) => {
    if (f.path !== FILES[pr] || f.line < 1 || f.line > 20) return { ok: false, error: `Not in the diff of #${pr}; changed file is ${FILES[pr]} lines 1-20` };
    findings.push({ pr, path: f.path, line: f.line });
    return { ok: true, id: `F${findings.length}` };
  },
  setBrief: () => {},
  setSummary: () => {},
  checkFailures: async () => "No failing checks.",
});
agentContexts.set(TOKEN, { stackId: STACK, agentName: "Claude Code", activePr: () => activePr });

const calls: string[] = [];
const sessionsSeen = new Set<string>();
const permissions: string[] = [];
const server = Bun.serve({
  port: 0,
  async fetch(req) {
    if (req.method !== "POST") return new Response(null, { status: 405 });
    const msg = await req.json();
    const session = req.headers.get("x-sr-session") ?? "";
    sessionsSeen.add(session);
    if (msg.method === "tools/call") calls.push(`${msg.params.name}@${activePr}`);
    const reply = await handle(msg, session);
    return reply ? Response.json(reply) : new Response(null, { status: 202 });
  },
});

const dir = mkdtempSync(join(tmpdir(), "sr-e2e-"));
writeFileSync(join(dir, "README.md"), "test\n");
const child = spawn("npx", ["-y", "@agentclientprotocol/claude-agent-acp@0.106.0"], { cwd: dir, stdio: ["pipe", "pipe", "ignore"] });
const pending = new Map<number, (v: any) => void>();
let id = 0;
let text = "";
createInterface({ input: child.stdout! }).on("line", (line) => {
  let m: any;
  try { m = JSON.parse(line); } catch { return; }
  if (m.method === "session/update" && m.params.update.sessionUpdate === "agent_message_chunk") text += m.params.update.content.text ?? "";
  if (m.method === "session/request_permission") {
    const t = m.params.toolCall;
    permissions.push(`${t.title} own=${isOwnTool(t.title)}`);
    const allow = m.params.options.find((o: any) => o.kind === "allow_always") ?? m.params.options[0];
    child.stdin!.write(JSON.stringify({ jsonrpc: "2.0", id: m.id, result: { outcome: { outcome: "selected", optionId: allow.optionId } } }) + "\n");
  }
  if (m.id != null && !m.method && pending.has(m.id)) { pending.get(m.id)!(m); pending.delete(m.id); }
});
const rpc = (method: string, params: unknown) => new Promise<any>((r) => { const n = ++id; pending.set(n, r); child.stdin!.write(JSON.stringify({ jsonrpc: "2.0", id: n, method, params }) + "\n"); });

setTimeout(() => { console.log("TIMEOUT", { calls, findings }); child.kill(); process.exit(1); }, 300_000);
await rpc("initialize", { protocolVersion: 1, clientCapabilities: {} });
const s = await rpc("session/new", { cwd: dir, mcpServers: [{ type: "http", name: "stack-reviewer", url: `http://127.0.0.1:${server.port}/mcp/test`, headers: [{ name: "x-sr-session", value: TOKEN }] }] });
const sid = s.result.sessionId;
const modeOpt = s.result.configOptions?.find((o: any) => o.category === "mode");
if (modeOpt) await rpc("session/set_config_option", { sessionId: sid, configId: modeOpt.id, value: "default" });

const ask = (t: string) => rpc("session/prompt", { sessionId: sid, prompt: [{ type: "text", text: t }] });
await ask("Use only the stack-reviewer MCP tools (no shell). Call get_review_context, then add_finding on the changed file at line 4, severity Low, title 'Layer one note', body 'x'. Reply with just the current PR number.");
const reply1 = text.trim(); text = "";
activePr = 413; // the app does this when the reviewer moves to layer 2 and sends a message
await ask("(Note: we've moved to layer 2 of 2, #413. Your review tools now default to this layer.)\n\nCall get_review_context again, then add_finding on this layer's changed file at line 8, severity Low, title 'Layer two note', body 'y'. Reply with just the current PR number and the file you flagged on the previous layer.");
const reply2 = text.trim();

console.log("tool calls:", calls.join(", "));
console.log("findings:", JSON.stringify(findings));
console.log("session header seen:", [...sessionsSeen].join(",") || "none");
console.log("permission prompts:", permissions.length ? permissions.join("; ") : "none");
console.log("reply 1:", reply1.slice(0, 120));
console.log("reply 2:", reply2.slice(0, 200));
child.kill();
server.stop();
const ok = findings.some((f) => f.pr === 412) && findings.some((f) => f.pr === 413) && sessionsSeen.has(TOKEN);
console.log(ok ? "PASS" : "FAIL");
process.exit(ok ? 0 : 1);
