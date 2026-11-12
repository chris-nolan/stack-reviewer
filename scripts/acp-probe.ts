// Starts an ACP agent, sends `initialize` and `session/new`, prints its capabilities, then exits.
// No prompt is sent. Usage: bun scripts/acp-probe.ts claude|gemini [cwd]

import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

const which = process.argv[2] ?? "claude";
const cwd = process.argv[3] ?? process.cwd();
const [cmd, args] = which === "gemini" ? ["gemini", ["--acp"]] : ["npx", ["-y", "@agentclientprotocol/claude-agent-acp@0.106.0"]];
const child = spawn(cmd, args, { cwd, stdio: ["pipe", "pipe", "pipe"] });
const pending = new Map<number, (v: unknown) => void>();
let id = 0;
createInterface({ input: child.stdout! }).on("line", (line) => {
  try {
    const m = JSON.parse(line);
    if (m.id != null && pending.has(m.id)) {
      pending.get(m.id)!(m);
      pending.delete(m.id);
    }
  } catch { /* log line */ }
});
child.stderr!.on("data", () => {});
const rpc = (method: string, params: unknown) =>
  new Promise<any>((resolve) => {
    const n = ++id;
    pending.set(n, resolve);
    child.stdin!.write(JSON.stringify({ jsonrpc: "2.0", id: n, method, params }) + "\n");
  });

const timer = setTimeout(() => { console.log("timeout"); child.kill(); process.exit(1); }, 90_000);
const init = await rpc("initialize", { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false } });
console.log("initialize:", JSON.stringify({ protocolVersion: init.result?.protocolVersion, agentCapabilities: init.result?.agentCapabilities, authMethods: init.result?.authMethods?.map((a: any) => a.id), error: init.error }));
const s = await rpc("session/new", { cwd, mcpServers: [] });
console.log("session/new:", s.error ? `error ${s.error.code} ${s.error.message}` : JSON.stringify({ ...s.result, sessionId: "…" }, null, 1));
clearTimeout(timer);
child.kill();
process.exit(0);
