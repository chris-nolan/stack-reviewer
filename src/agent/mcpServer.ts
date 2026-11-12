// Implements the "stack-reviewer" MCP server's tools. The Rust side forwards each JSON-RPC
// message from the agent as a `mcp-request` event and waits for `mcp_respond`.

import { listen } from "@tauri-apps/api/event";
import { invoke, isTauri } from "../lib/platform";
import { agentContexts, reviewBridge } from "./bridge";

const TOOLS = [
  {
    name: "get_review_context",
    description:
      "Returns the stack being reviewed: every layer (PR) in order, plus the layer you are currently on (or `pr`) with its description, base/head commits, changed files, open review threads and check status. Call this first, and again after the reviewer moves you to another layer.",
    inputSchema: { type: "object", properties: { pr: { type: "number", description: "PR number of another layer; defaults to the layer you are currently on" } } },
  },
  {
    name: "get_check_failures",
    description: "Returns failing CI checks for a layer with the relevant excerpt of each failing job's log.",
    inputSchema: { type: "object", properties: { pr: { type: "number", description: "PR number; defaults to the layer you are currently on" } } },
  },
  {
    name: "add_finding",
    description:
      "Record one review finding. It appears beside the diff for the reviewer to accept as a draft comment or dismiss. Nothing is posted to GitHub. `line` must be a new-side line number that appears in the PR diff for that file.",
    inputSchema: {
      type: "object",
      required: ["path", "line", "severity", "title", "body"],
      properties: {
        pr: { type: "number", description: "PR number; defaults to the layer you are currently on" },
        path: { type: "string" },
        line: { type: "number" },
        severity: { type: "string", enum: ["High", "Medium", "Low"] },
        title: { type: "string", description: "One line, under 80 characters" },
        body: { type: "string", description: "Why it matters and what to do, 1-3 sentences, markdown" },
        suggestion: { type: "string", description: "Optional replacement for the commented line, used as a GitHub suggestion" },
      },
    },
  },
  {
    name: "set_layer_brief",
    description: "Set the one-paragraph summary of what the layer does and the order the reviewer should read its files in.",
    inputSchema: {
      type: "object",
      required: ["summary"],
      properties: { summary: { type: "string" }, reading_order: { type: "array", items: { type: "string" } } },
    },
  },
  {
    name: "set_review_summary",
    description: "Draft the overall review summary the reviewer may submit with their verdict.",
    inputSchema: { type: "object", required: ["text"], properties: { text: { type: "string" } } },
  },
];

type Rpc = { jsonrpc: "2.0"; id?: number | string; method?: string; params?: Record<string, unknown> };

const text = (t: string, isError = false) => ({ content: [{ type: "text", text: t }], isError });

async function callTool(name: string, args: Record<string, unknown>, session: string) {
  const ctx = agentContexts.get(session);
  const b = ctx ? reviewBridge.get(ctx.stackId) : null;
  if (!ctx || !b) return text("This agent session is no longer attached to a review in Stack Reviewer.", true);
  // Tools default to the layer the agent is working on, which may differ from the one on screen.
  const pr = typeof args.pr === "number" ? args.pr : ctx.activePr();
  if (pr == null) return text("No layer is selected for this conversation yet.", true);
  switch (name) {
    case "get_review_context":
      return text(JSON.stringify(await b.context(pr), null, 2));
    case "get_check_failures":
      return text(await b.checkFailures(pr));
    case "add_finding": {
      const r = await b.addFinding(pr, args as never, ctx.agentName);
      return r.ok ? text(`Recorded finding ${r.id} on #${pr}. The reviewer will triage it; nothing was posted.`) : text(r.error, true);
    }
    case "set_layer_brief":
      b.setBrief(pr, String(args.summary ?? ""), Array.isArray(args.reading_order) ? args.reading_order.map(String) : [], ctx.agentName);
      return text(`Brief updated for #${pr}.`);
    case "set_review_summary":
      b.setSummary(pr, String(args.text ?? ""));
      return text(`Summary drafted for #${pr} for the reviewer to edit.`);
    default:
      return text(`Unknown tool ${name}`, true);
  }
}

export async function handle(msg: Rpc, session = ""): Promise<unknown | null> {
  if (msg.id == null || !msg.method) return null;
  const ok = (result: unknown) => ({ jsonrpc: "2.0", id: msg.id, result });
  switch (msg.method) {
    case "initialize":
      return ok({
        protocolVersion: (msg.params?.protocolVersion as string) ?? "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "stack-reviewer", version: "0.1.0" },
        instructions: "Tools for reviewing the stacked pull request open in Stack Reviewer. Findings are drafts for the human reviewer; you cannot post to GitHub.",
      });
    case "ping":
      return ok({});
    case "tools/list":
      return ok({ tools: TOOLS });
    case "tools/call": {
      const p = msg.params ?? {};
      try {
        return ok(await callTool(String(p.name), (p.arguments as Record<string, unknown>) ?? {}, session));
      } catch (e) {
        return ok(text(e instanceof Error ? e.message : String(e), true));
      }
    }
    default:
      return { jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: `Method not found: ${msg.method}` } };
  }
}

let started: Promise<string> | null = null;

/** Starts listening for tool calls and returns the server URL to hand to agents. */
export function startMcpServer(): Promise<string> {
  if (!isTauri()) return Promise.reject(new Error("MCP needs the desktop app"));
  started ??= (async () => {
    await listen<{ id: number; session: string; body: string }>("mcp-request", async (e) => {
      let reply: unknown = null;
      try {
        reply = await handle(JSON.parse(e.payload.body) as Rpc, e.payload.session);
      } catch {
        reply = { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } };
      }
      if (reply) await invoke("mcp_respond", { id: e.payload.id, body: JSON.stringify(reply) });
    });
    return invoke<string>("mcp_url");
  })();
  return started;
}
