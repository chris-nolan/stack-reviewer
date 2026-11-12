// End-to-end check of "guide me" with a real agent and no desktop shell: replays a stack from
// dev-data/snapshot.json through the app's real stack bridge and MCP tool handler, starts Claude
// Code over ACP in the app's managed clone, and sends the real guide prompt. Shell commands are
// approved only for read-only git; everything else is refused. Nothing is posted anywhere.
// Usage: bun scripts/guide-e2e.ts <stack id from the snapshot> <checkout dir> [max layers]
//   e.g. bun scripts/guide-e2e.ts 'owner/repo#n66' "$HOME/Library/Application Support/com.stackreviewer.app/repos/owner/repo/clone" 16

// Minimal localStorage so the app's stores run outside a browser (writes stay in memory).
const mem = new Map<string, string>();
(globalThis as Record<string, unknown>).localStorage = {
  get length() { return mem.size; },
  key: (i: number) => [...mem.keys()][i] ?? null,
  getItem: (k: string) => mem.get(k) ?? null,
  setItem: (k: string, v: string) => void mem.set(k, String(v)),
  removeItem: (k: string) => void mem.delete(k),
};

import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { readFileSync, writeFileSync } from "node:fs";
import { QueryClient } from "@tanstack/react-query";
import { handle } from "../src/agent/mcpServer";
import { agentContexts } from "../src/agent/bridge";
import { guideStackPrompt, isOwnTool } from "../src/agent/session";
import { registerStackBridge } from "../src/features/review/stackBridge";
import { guideStore } from "../src/lib/guideStore";
import { SnapshotSource, type Snapshot } from "../src/lib/snapshot";
import { TIER_WORD } from "../src/lib/guide";

const [stackId, cwd, maxArg] = process.argv.slice(2);
if (!stackId || !cwd) {
  console.error("Usage: bun scripts/guide-e2e.ts <stack id> <checkout dir> [max layers]");
  process.exit(2);
}
const snap: Snapshot = JSON.parse(readFileSync("dev-data/snapshot.json", "utf8"));
const full = snap.stacks[stackId];
if (!full) throw new Error(`No stack ${stackId} in the snapshot. Stacks: ${Object.keys(snap.stacks).join(", ")}`);
const stack = { ...full, layers: full.layers.slice(0, Number(maxArg) || full.layers.length) };
const open = stack.layers.filter((l) => l.pr.state === "OPEN");

const source = new SnapshotSource(snap);
registerStackBridge(stackId, source, new QueryClient(), () => stack);
const TOKEN = "guide-e2e";
let label = "Claude Code";
agentContexts.set(TOKEN, { stackId, agentName: "Claude Code", label: () => label, activePr: () => open[0].pr.number });

const calls: { name: string; pr?: unknown; ok: boolean; error?: string; at: number }[] = [];
const t0 = Date.now();
const server = Bun.serve({
  port: 0,
  async fetch(req) {
    if (req.method !== "POST") return new Response(null, { status: 405 });
    const msg = await req.json();
    const reply = (await handle(msg, req.headers.get("x-sr-session") ?? "")) as { result?: { isError?: boolean; content?: { text: string }[] } } | null;
    if (msg.method === "tools/call") {
      const err = reply?.result?.isError;
      calls.push({ name: msg.params.name, pr: msg.params.arguments?.pr, ok: !err, error: err ? reply?.result?.content?.[0]?.text : undefined, at: Math.round((Date.now() - t0) / 1000) });
      console.log(`[${calls.at(-1)!.at}s] ${msg.params.name}${msg.params.arguments?.pr ? ` #${msg.params.arguments.pr}` : ""} ${err ? "ERROR" : "ok"}`);
    }
    return reply ? Response.json(reply) : new Response(null, { status: 202 });
  },
});

const READ_ONLY_GIT = /^\s*git\s+(-C\s+\S+\s+)?(diff|show|log|cat-file|ls-tree|rev-parse|merge-base|fetch|status|blame|grep)\b/;
const permissions: { title: string; allowed: boolean }[] = [];
const child = spawn("npx", ["-y", "@agentclientprotocol/claude-agent-acp@0.106.0"], { cwd, stdio: ["pipe", "pipe", "ignore"] });
const pending = new Map<number, (v: any) => void>();
let id = 0;
let text = "";
createInterface({ input: child.stdout! }).on("line", (line) => {
  let m: any;
  try { m = JSON.parse(line); } catch { return; }
  if (m.method === "session/update" && m.params.update.sessionUpdate === "agent_message_chunk") text += m.params.update.content.text ?? "";
  if (m.method === "session/request_permission") {
    const t = m.params.toolCall;
    const cmd = String(t.rawInput?.command ?? "");
    const allowed = isOwnTool(t.title) || READ_ONLY_GIT.test(cmd) && !/[;&|`$><]/.test(cmd.replace(/\|\s*(head|tail|wc|sed -n)\b[^|;&]*/g, ""));
    permissions.push({ title: cmd || t.title, allowed });
    const opt = m.params.options.find((o: any) => o.kind === (allowed ? "allow_once" : "reject_once")) ?? m.params.options[0];
    child.stdin!.write(JSON.stringify({ jsonrpc: "2.0", id: m.id, result: { outcome: { outcome: "selected", optionId: opt.optionId } } }) + "\n");
  }
  if (m.id != null && !m.method && pending.has(m.id)) { pending.get(m.id)!(m); pending.delete(m.id); }
});
const rpc = (method: string, params: unknown) => new Promise<any>((r) => { const n = ++id; pending.set(n, r); child.stdin!.write(JSON.stringify({ jsonrpc: "2.0", id: n, method, params }) + "\n"); });

const LIMIT_MIN = 45;
setTimeout(() => { console.log(`TIMEOUT after ${LIMIT_MIN} min`); report(false); }, LIMIT_MIN * 60_000);

await rpc("initialize", { protocolVersion: 1, clientCapabilities: {} });
const s = await rpc("session/new", { cwd, mcpServers: [{ type: "http", name: "stack-reviewer", url: `http://127.0.0.1:${server.port}/mcp/e2e`, headers: [{ name: "x-sr-session", value: TOKEN }] }] });
const sid = s.result.sessionId;
const opts: any[] = s.result.configOptions ?? [];
const mode = opts.find((o) => o.category === "mode");
if (mode) await rpc("session/set_config_option", { sessionId: sid, configId: mode.id, value: "default" });
const name = (o: any) => o?.options?.flatMap((x: any) => x.options ?? [x]).find((x: any) => x.value === o.currentValue)?.name ?? o?.currentValue;
label = ["Claude Code", name(opts.find((o) => o.category === "model")), name(opts.find((o) => o.category === "thought_level"))].filter(Boolean).join(" · ");
console.log(`Guiding ${open.length} layers of ${stackId} with ${label}`);

const res = await rpc("session/prompt", { sessionId: sid, prompt: [{ type: "text", text: guideStackPrompt(open.map((l) => ({ index: l.index, number: l.pr.number, title: l.pr.title }))) }] });
console.log("stop reason:", res.result?.stopReason ?? JSON.stringify(res.error));
report(true);

function report(finished: boolean) {
  const doc = guideStore.get(stackId);
  const guided = open.filter((l) => doc.layers[l.pr.number]);
  writeFileSync("dev-data/guide-e2e.json", JSON.stringify({ label, calls, permissions, doc, finalMessage: text.trim() }, null, 2));
  console.log(`\n${Math.round((Date.now() - t0) / 60000)} min · ${calls.length} tool calls · ${calls.filter((c) => !c.ok).length} returned errors`);
  for (const c of calls.filter((c) => !c.ok)) console.log(`  error on ${c.name}${c.pr ? ` #${c.pr}` : ""}: ${c.error?.split("\n").slice(0, 3).join(" / ")}`);
  console.log(`permissions: ${permissions.filter((p) => p.allowed).length} allowed, ${permissions.filter((p) => !p.allowed).length} refused`);
  for (const p of permissions.filter((p) => !p.allowed)) console.log(`  refused: ${p.title.slice(0, 120)}`);
  console.log(`guided ${guided.length}/${open.length} layers; stack guide ${doc.stack ? "written" : "MISSING"}`);
  for (const l of open) {
    const g = doc.layers[l.pr.number];
    const rank = doc.stack ? doc.stack.ranking.indexOf(l.pr.number) + 1 : 0;
    console.log(`  L${l.index} #${l.pr.number} +${l.pr.additions}/-${l.pr.deletions}: ${g ? `${TIER_WORD[g.tier]}${rank ? ` · rank ${rank}` : ""} · ${g.focus.length} focus · ${g.skim.length} skim · ${g.questions.length} q — ${g.tierReason}` : "no guide"}`);
  }
  if (doc.stack) console.log(`\nplan: ${doc.stack.plan}\ncross-layer: ${doc.stack.crossLayer.length}`);
  console.log(`final message (${text.trim().length} chars): ${text.trim().slice(0, 300)}`);
  const ok = finished && guided.length === open.length && !!doc.stack && calls.every((c) => c.name !== "add_finding");
  console.log(ok ? "PASS" : "FAIL");
  child.kill();
  server.stop();
  process.exit(ok ? 0 : 1);
}
