// One agent conversation per (stack, agent). Owns the ACP connection and the chat transcript.

import type { RequestPermissionRequest, RequestPermissionResponse, SessionNotification } from "@agentclientprotocol/sdk";
import { useSyncExternalStore } from "react";
import { AcpConnection } from "./acp";
import { parseFindingBlocks, reviewBridge } from "./bridge";
import { setActiveAgentName, startMcpServer } from "./mcpServer";

export type ChatItem =
  | { kind: "user"; id: string; text: string }
  | { kind: "agent"; id: string; text: string }
  | { kind: "thought"; id: string; text: string }
  | { kind: "tool"; id: string; toolCallId: string; title: string; status: string }
  | { kind: "permission"; id: string; title: string; options: { optionId: string; name: string; kind: string }[]; chosen?: string }
  | { kind: "notice"; id: string; text: string; tone: "info" | "error" };

export type AgentStatus = "idle" | "starting" | "ready" | "busy" | "error" | "stopped";

type Snapshot = { status: AgentStatus; items: ChatItem[]; worktree: string | null };

const uid = () => crypto.randomUUID();

export class AgentSession {
  private conn: AcpConnection | null = null;
  private sessionId: string | null = null;
  private listeners = new Set<() => void>();
  private permissionWaiters = new Map<string, (r: RequestPermissionResponse) => void>();
  private usesMcp = false;
  private snap: Snapshot = { status: "idle", items: [], worktree: null };

  constructor(readonly agentId: string, readonly agentName: string) {}

  subscribe = (cb: () => void) => {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  };
  getSnapshot = () => this.snap;

  private set(patch: Partial<Snapshot>) {
    this.snap = { ...this.snap, ...patch };
    this.listeners.forEach((l) => l());
  }
  private push(item: ChatItem) {
    this.set({ items: [...this.snap.items, item] });
  }
  private patchItem(pred: (i: ChatItem) => boolean, fn: (i: ChatItem) => ChatItem) {
    this.set({ items: this.snap.items.map((i) => (pred(i) ? fn(i) : i)) });
  }
  notice(text: string, tone: "info" | "error" = "info") {
    this.push({ kind: "notice", id: uid(), text, tone });
  }

  async start(worktree: string): Promise<void> {
    if (this.conn && this.snap.worktree === worktree && this.sessionId) return;
    if (this.conn) await this.stop(false);
    this.set({ status: "starting", worktree });
    const conn = new AcpConnection({
      onUpdate: (n) => this.onUpdate(n),
      onPermission: (r) => this.onPermission(r),
      onExit: () => {
        if (this.snap.status !== "stopped") {
          this.set({ status: "error" });
          this.notice(`${this.agentName} stopped unexpectedly.`, "error");
        }
        this.conn = null;
        this.sessionId = null;
      },
    });
    try {
      await conn.start(this.agentId, worktree);
      const mcpServers = [];
      if (conn.supportsHttpMcp) {
        mcpServers.push({ type: "http" as const, name: "stack-reviewer", url: await startMcpServer(), headers: [] });
        this.usesMcp = true;
      }
      const s = await conn.newSession(worktree, mcpServers);
      this.conn = conn;
      this.sessionId = s.sessionId;
      this.set({ status: "ready" });
    } catch (e) {
      await conn.dispose();
      this.set({ status: "error" });
      this.notice(`Couldn't start ${this.agentName}: ${e instanceof Error ? e.message : String(e)}`, "error");
      throw e;
    }
  }

  async send(text: string, display = text): Promise<void> {
    if (!this.conn || !this.sessionId) throw new Error("Agent is not running");
    setActiveAgentName(this.agentName);
    this.push({ kind: "user", id: uid(), text: display });
    this.set({ status: "busy" });
    const firstNew = this.snap.items.length;
    try {
      const res = await this.conn.prompt(this.sessionId, this.usesMcp ? text : `${text}\n\n${FALLBACK_FORMAT}`);
      if (!this.usesMcp) this.harvestFindings(firstNew);
      if (res.stopReason === "refusal") this.notice(`${this.agentName} declined this request.`);
      if (res.stopReason === "max_tokens" || res.stopReason === "max_turn_requests") this.notice(`${this.agentName} hit its limit before finishing.`);
    } catch (e) {
      this.notice(e instanceof Error ? e.message : String(e), "error");
    } finally {
      if (this.snap.status === "busy") this.set({ status: "ready" });
    }
  }

  cancel() {
    if (this.conn && this.sessionId) this.conn.cancel(this.sessionId);
    for (const [id, resolve] of this.permissionWaiters) {
      resolve({ outcome: { outcome: "cancelled" } });
      this.permissionWaiters.delete(id);
    }
  }

  async stop(markStopped = true) {
    if (markStopped) this.set({ status: "stopped" });
    const c = this.conn;
    this.conn = null;
    this.sessionId = null;
    await c?.dispose();
  }

  answerPermission(itemId: string, optionId: string | null) {
    const resolve = this.permissionWaiters.get(itemId);
    if (!resolve) return;
    this.permissionWaiters.delete(itemId);
    this.patchItem((i) => i.id === itemId, (i) => ({ ...i, chosen: optionId ?? "cancelled" }) as ChatItem);
    resolve(optionId ? { outcome: { outcome: "selected", optionId } } : { outcome: { outcome: "cancelled" } });
  }

  private onPermission(r: RequestPermissionRequest): Promise<RequestPermissionResponse> {
    const id = uid();
    this.push({
      kind: "permission", id,
      title: r.toolCall.title ?? "Run a tool",
      options: r.options.map((o) => ({ optionId: o.optionId, name: o.name, kind: o.kind })),
    });
    return new Promise((resolve) => this.permissionWaiters.set(id, resolve));
  }

  private onUpdate(n: SessionNotification) {
    const u = n.update;
    const appendChunk = (kind: "agent" | "thought", t: string) => {
      const last = this.snap.items[this.snap.items.length - 1];
      if (last && last.kind === kind) this.patchItem((i) => i === last, (i) => ({ ...i, text: (i as { text: string }).text + t }) as ChatItem);
      else this.push({ kind, id: uid(), text: t });
    };
    switch (u.sessionUpdate) {
      case "agent_message_chunk":
        if (u.content.type === "text") appendChunk("agent", u.content.text);
        break;
      case "agent_thought_chunk":
        if (u.content.type === "text") appendChunk("thought", u.content.text);
        break;
      case "tool_call":
        this.push({ kind: "tool", id: uid(), toolCallId: u.toolCallId, title: u.title, status: u.status ?? "pending" });
        break;
      case "tool_call_update":
        this.patchItem(
          (i) => i.kind === "tool" && i.toolCallId === u.toolCallId,
          (i) => ({ ...i, title: u.title ?? (i as { title: string }).title, status: u.status ?? (i as { status: string }).status }) as ChatItem,
        );
        break;
      default:
        break;
    }
  }

  private harvestFindings(from: number) {
    const b = reviewBridge.get();
    if (!b) return;
    const text = this.snap.items.slice(from).filter((i) => i.kind === "agent").map((i) => (i as { text: string }).text).join("\n");
    const found = parseFindingBlocks(text);
    let added = 0;
    for (const f of found) if (b.addFinding(f, this.agentName).ok) added++;
    if (found.length) this.notice(`Placed ${added} of ${found.length} findings beside the diff.`);
  }
}

const FALLBACK_FORMAT = `This client cannot give you review tools, so report each finding in a fenced block exactly like:
\`\`\`findings
[{"path": "src/file.ts", "line": 42, "severity": "High|Medium|Low", "title": "short title", "body": "why and what to do", "suggestion": "optional replacement line"}]
\`\`\`
Use new-side line numbers that appear in the diff.`;

const sessions = new Map<string, AgentSession>();

export function getAgentSession(stackId: string, agentId: string, agentName: string): AgentSession {
  const key = `${stackId}|${agentId}`;
  let s = sessions.get(key);
  if (!s) {
    s = new AgentSession(agentId, agentName);
    sessions.set(key, s);
  }
  return s;
}

export function useAgentSnapshot(s: AgentSession | null): Snapshot {
  return useSyncExternalStore(
    (cb) => (s ? s.subscribe(cb) : () => {}),
    () => (s ? s.getSnapshot() : EMPTY),
  );
}
const EMPTY: Snapshot = { status: "idle", items: [], worktree: null };

export function reviewLayerPrompt(layerIndex: number, total: number, number: number): string {
  return `You are helping me review layer ${layerIndex} of ${total} (PR #${number}) of a stacked pull request.
The working directory is a checkout of this layer's head commit.

1. Call get_review_context to see the stack, this layer's description, its base and head commits and changed files.
2. Read the diff with \`git diff <base>...HEAD\` and read surrounding code as needed. Earlier layers are already in the base; later layers are not here yet.
3. If checks are failing, call get_check_failures and work out whether this layer or a lower one is the cause.
4. Call set_layer_brief with a 2-3 sentence summary and the best order to read the files in.
5. For each real problem (bugs, security, data loss, concurrency, missing error handling, misleading names, missing tests for risky logic) call add_finding, anchored to a changed line. Skip style nitpicks. Prefer a few high-signal findings over many.
6. Finish with a short message: what the layer does, what you flagged, and anything that needs a human decision.

Do not edit files, commit, push or post anything to GitHub.`;
}
