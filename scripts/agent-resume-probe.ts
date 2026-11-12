// Checks that an agent conversation survives an app restart via ACP session/load.
// Process 1 learns a word; process 2 loads the session and is asked for it. Two tiny prompts.
// Usage: bun scripts/agent-resume-probe.ts [claude|gemini]

import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const which = process.argv[2] ?? "claude";
const [cmd, args] = which === "gemini" ? ["gemini", ["--acp"]] : ["npx", ["-y", "@agentclientprotocol/claude-agent-acp@0.106.0"]];
const cwd = mkdtempSync(join(tmpdir(), "sr-resume-"));

function agent() {
  const child = spawn(cmd, args, { cwd, stdio: ["pipe", "pipe", "ignore"] });
  const pending = new Map<number, (v: any) => void>();
  let id = 0;
  const state = { text: "", replayed: 0 };
  createInterface({ input: child.stdout! }).on("line", (line) => {
    let m: any;
    try { m = JSON.parse(line); } catch { return; }
    if (m.method === "session/update") {
      state.replayed++;
      if (m.params.update.sessionUpdate === "agent_message_chunk") state.text += m.params.update.content.text ?? "";
    }
    if (m.id != null && !m.method && pending.has(m.id)) { pending.get(m.id)!(m); pending.delete(m.id); }
  });
  const rpc = (method: string, params: unknown) => new Promise<any>((r) => { const n = ++id; pending.set(n, r); child.stdin!.write(JSON.stringify({ jsonrpc: "2.0", id: n, method, params }) + "\n"); });
  return { child, rpc, state };
}

setTimeout(() => { console.log("timeout"); process.exit(1); }, 240_000);
const a = agent();
await a.rpc("initialize", { protocolVersion: 1, clientCapabilities: {} });
const sid = (await a.rpc("session/new", { cwd, mcpServers: [] })).result.sessionId;
await a.rpc("session/prompt", { sessionId: sid, prompt: [{ type: "text", text: "Remember the code word kumquat. Reply with just: ok" }] });
console.log("first process said:", a.state.text.trim().slice(0, 40));
a.child.kill();

const b = agent();
const init = await b.rpc("initialize", { protocolVersion: 1, clientCapabilities: {} });
console.log("loadSession supported:", !!init.result?.agentCapabilities?.loadSession);
b.state.replayed = 0;
const load = await b.rpc("session/load", { sessionId: sid, cwd, mcpServers: [] });
console.log("session/load:", load.error ? `error ${load.error.message}` : `ok, replayed ${b.state.replayed} updates`);
b.state.text = "";
await b.rpc("session/prompt", { sessionId: sid, prompt: [{ type: "text", text: "What was the code word? Reply with just the word." }] });
const answer = b.state.text.trim();
console.log("second process said:", answer.slice(0, 40));
b.child.kill();
const ok = /kumquat/i.test(answer);
console.log(ok ? "PASS" : "FAIL");
process.exit(ok ? 0 : 1);
