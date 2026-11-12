// Checks model / effort switching against a real agent over ACP. No prompt is sent.
// Usage: bun scripts/agent-settings-probe.ts claude|gemini

import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { readSettings } from "../src/agent/settings";

const which = process.argv[2] ?? "claude";
const [cmd, args] = which === "gemini" ? ["gemini", ["--acp"]] : ["npx", ["-y", "@agentclientprotocol/claude-agent-acp@0.106.0"]];
const child = spawn(cmd, args, { cwd: process.env.TMPDIR ?? "/tmp", stdio: ["pipe", "pipe", "ignore"] });
const pending = new Map<number, (v: any) => void>();
let id = 0;
createInterface({ input: child.stdout! }).on("line", (line) => {
  try {
    const m = JSON.parse(line);
    if (m.id != null && !m.method && pending.has(m.id)) { pending.get(m.id)!(m); pending.delete(m.id); }
  } catch { /* log line */ }
});
const rpc = (method: string, params: unknown) => new Promise<any>((r) => { const n = ++id; pending.set(n, r); child.stdin!.write(JSON.stringify({ jsonrpc: "2.0", id: n, method, params }) + "\n"); });
setTimeout(() => { console.log("timeout"); child.kill(); process.exit(1); }, 120_000);

await rpc("initialize", { protocolVersion: 1, clientCapabilities: {} });
const s = (await rpc("session/new", { cwd: process.env.TMPDIR ?? "/tmp", mcpServers: [] })).result;
const before = readSettings(s);
const show = (st: ReturnType<typeof readSettings>) => st.map((x) => `${x.kind}=${x.current} (${x.options.length} options, via ${x.via})`).join("; ");
console.log("settings:", show(before));
let ok = true;

const model = before.find((x) => x.kind === "model");
if (model) {
  const target = model.options.find((o) => o.value !== model.current && o.value !== "default")!;
  const r = model.via === "config"
    ? await rpc("session/set_config_option", { sessionId: s.sessionId, configId: model.id, value: target.value })
    : await rpc("session/set_model", { sessionId: s.sessionId, modelId: target.value });
  const after = r.result?.configOptions ? readSettings({ configOptions: r.result.configOptions }) : null;
  const applied = r.error ? `error ${r.error.message}` : after ? after.find((x) => x.kind === "model")?.current : "accepted";
  console.log(`set model → ${target.value}:`, applied, after ? `| ${show(after)}` : "");
  ok &&= !r.error;
}
const effort = (readSettings(s)).find((x) => x.kind === "effort");
if (effort) {
  const r = await rpc("session/set_config_option", { sessionId: s.sessionId, configId: effort.id, value: "low" });
  const after = r.result?.configOptions ? readSettings({ configOptions: r.result.configOptions }) : null;
  console.log("set effort → low:", r.error ? `error ${r.error.message}` : after?.find((x) => x.kind === "effort")?.current);
  ok &&= !r.error && after?.find((x) => x.kind === "effort")?.current === "low";
}
const modeOpt = s.configOptions?.find((o: any) => o.category === "mode");
if (modeOpt) {
  const r = await rpc("session/set_config_option", { sessionId: s.sessionId, configId: modeOpt.id, value: "default" });
  console.log("set mode → default:", r.error ? `error ${r.error.message}` : r.result.configOptions.find((o: any) => o.category === "mode").currentValue);
} else if (s.modes) {
  const r = await rpc("session/set_mode", { sessionId: s.sessionId, modeId: "default" });
  console.log("set_mode default:", r.error ? `error ${r.error.message}` : "ok");
}
child.kill();
process.exit(ok ? 0 : 1);
