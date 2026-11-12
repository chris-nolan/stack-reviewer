// One continuous agent conversation per (stack, agent). The agent works in a single checkout that
// moves between layers; when you move to another layer, the next message tells the agent and a
// divider marks it in the transcript. Transcripts are saved and agent sessions resumed on restart.

import type { RequestPermissionRequest, RequestPermissionResponse, SessionNotification } from "@agentclientprotocol/sdk";
import { useSyncExternalStore } from "react";
import { AcpConnection } from "./acp";
import { agentContexts, parseFindingBlocks, parseGuideBlocks, reviewBridge } from "./bridge";
import { startMcpServer } from "./mcpServer";
import { durable } from "../lib/durable";
import { knownSettings, prefs, readSettings, type AgentSetting, type SessionState, type SettingKind } from "./settings";

export type ChatItem =
  | { kind: "user"; id: string; text: string }
  | { kind: "agent"; id: string; text: string }
  | { kind: "thought"; id: string; text: string }
  | { kind: "tool"; id: string; toolCallId: string; title: string; status: string }
  | { kind: "permission"; id: string; title: string; options: { optionId: string; name: string; kind: string }[]; chosen?: string }
  | { kind: "notice"; id: string; text: string; tone: "info" | "error" }
  | { kind: "divider"; id: string; text: string };

/** The layer the conversation is currently working on. */
export type LayerRef = { index: number; total: number; pr: number; title: string; headSha: string; baseSha?: string };

export type AgentStatus = "idle" | "starting" | "ready" | "busy" | "error" | "stopped";

type Snapshot = { status: AgentStatus; items: ChatItem[]; worktree: string | null; settings: AgentSetting[]; layer: LayerRef | null };

type Saved = { items: ChatItem[]; sessionId: string | null; layer: LayerRef | null };
const MAX_SAVED_ITEMS = 400;

/** Known settings with the reviewer's preferences applied, for display before a session runs. */
function presetSettings(agentId: string): AgentSetting[] {
  const p = prefs.get(agentId);
  return knownSettings.get(agentId).map((s) => (p[s.kind] && s.options.some((o) => o.value === p[s.kind]) ? { ...s, current: p[s.kind]! } : s));
}

const uid = () => crypto.randomUUID();

const OWN_PREFIXES = ["mcp__stack-reviewer__", "stack-reviewer__", "stack-reviewer/", "stack-reviewer:"];
export const isOwnTool = (title: string | null | undefined) => !!title && OWN_PREFIXES.some((p) => title.toLowerCase().startsWith(p));

const OWN_LABELS: Record<string, string> = {
  get_review_context: "Read the review context",
  get_check_failures: "Read failing check logs",
  add_finding: "Recorded a finding",
  set_layer_brief: "Wrote the layer summary",
  set_review_summary: "Drafted the review summary",
  set_layer_guide: "Guided a layer",
  set_stack_guide: "Wrote the stack guide",
};

/** "mcp__stack-reviewer__add_finding" → "Recorded a finding"; other MCP tools → "server: tool name". */
export function toolLabel(title: string, input?: unknown): string {
  const m = /^mcp__([^_]+(?:-[^_]+)*)__(.+)$/.exec(title);
  if (!m) return title;
  if (m[1] === "stack-reviewer") {
    const pr = (input as { pr?: unknown } | null | undefined)?.pr;
    if (m[2] === "set_layer_guide" && typeof pr === "number") return `Guided layer #${pr}`;
    return OWN_LABELS[m[2]] ?? m[2].replace(/_/g, " ");
  }
  return `${m[1]}: ${m[2].replace(/_/g, " ")}`;
}

export class AgentSession {
  private conn: AcpConnection | null = null;
  private sessionId: string | null = null;
  private listeners = new Set<() => void>();
  private permissionWaiters = new Map<string, (r: RequestPermissionResponse) => void>();
  private usesMcp = false;
  private snap: Snapshot;
  private readonly token = uid();
  private savedSessionId: string | null;
  private replaying = false;
  /** Set when the reviewer moved to another layer; sent ahead of the next message. */
  private layerNote: string | null = null;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(readonly agentId: string, readonly agentName: string, readonly stackId: string) {
    const saved = durable.get<Saved | null>("chat", this.storageKey, null);
    this.savedSessionId = saved?.sessionId ?? null;
    this.snap = { status: "idle", items: saved?.items ?? [], worktree: null, settings: presetSettings(agentId), layer: saved?.layer ?? null };
    agentContexts.set(this.token, { stackId, agentName, label: () => this.label(), activePr: () => this.snap.layer?.pr ?? null });
  }

  /** "Claude Code · Opus 5.5 · high": the agent with the model and effort it is using. */
  label(): string {
    const parts = this.snap.settings.map((x) => x.options.find((o) => o.value === x.current)?.name ?? x.current).filter(Boolean);
    return [this.agentName, ...parts].join(" · ");
  }

  private get storageKey() {
    return `${this.stackId}|${this.agentId}`;
  }

  private save() {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      const items = this.snap.items.slice(-MAX_SAVED_ITEMS).map((i) =>
        i.kind === "permission" && !i.chosen ? { ...i, chosen: "expired" } : i.kind === "thought" ? { ...i, text: i.text.slice(0, 2000) } : i,
      );
      durable.set("chat", this.storageKey, { items, sessionId: this.sessionId ?? this.savedSessionId, layer: this.snap.layer } satisfies Saved);
    }, 500);
  }

  subscribe = (cb: () => void) => {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  };
  getSnapshot = () => this.snap;

  private set(patch: Partial<Snapshot>) {
    this.snap = { ...this.snap, ...patch };
    this.listeners.forEach((l) => l());
    if ("items" in patch || "layer" in patch) this.save();
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
        mcpServers.push({ type: "http" as const, name: "stack-reviewer", url: await startMcpServer(), headers: [{ name: "x-sr-session", value: this.token }] });
        this.usesMcp = true;
      }
      this.conn = conn;
      let state: SessionState | null = null;
      if (this.savedSessionId && conn.supportsLoad) {
        // Resume the agent's own memory of this conversation. It replays history as updates,
        // which we already have on screen, so ignore them while it does.
        this.replaying = true;
        try {
          state = (await conn.loadSession(this.savedSessionId, worktree, mcpServers)) as SessionState;
          this.sessionId = this.savedSessionId;
        } catch {
          state = null;
        } finally {
          this.replaying = false;
        }
      }
      if (!state) {
        const s = await conn.newSession(worktree, mcpServers);
        if (this.snap.items.some((i) => i.kind === "user")) {
          this.notice(`${this.agentName} started a fresh session and doesn't remember the conversation above.`);
          this.layerNote = null; // the review prompt or next message sets context afresh
        }
        this.sessionId = s.sessionId;
        state = s as SessionState;
      }
      this.savedSessionId = this.sessionId;
      await this.configure(state);
      this.set({ status: "ready" });
      this.save();
    } catch (e) {
      this.conn = null;
      await conn.dispose();
      this.set({ status: "error" });
      this.notice(`Couldn't start ${this.agentName}: ${e instanceof Error ? e.message : String(e)}`, "error");
      throw e;
    }
  }

  /** Puts a fresh session into review mode and applies the reviewer's model/effort choices. */
  private async configure(state: SessionState) {
    const conn = this.conn!;
    const sid = this.sessionId!;
    // Reviews should ask before running commands, whatever the agent's global default is.
    const modeOpt = state.configOptions?.find((o) => o.category === "mode" && o.type === "select");
    try {
      if (modeOpt && String(modeOpt.currentValue) !== "default" && JSON.stringify(modeOpt).includes('"default"')) {
        const r = await conn.setConfigOption(sid, modeOpt.id, "default");
        if (r?.configOptions) state = { ...state, configOptions: r.configOptions };
      } else if (!modeOpt && state.modes && state.modes.currentModeId !== "default" && state.modes.availableModes.some((m) => m.id === "default")) {
        await conn.setMode(sid, "default");
      }
    } catch {
      this.notice(`Couldn't switch ${this.agentName} to ask-before-running mode; it will use its own default.`);
    }
    let settings = readSettings(state);
    const wanted = prefs.get(this.agentId);
    for (const kind of ["model", "effort"] as SettingKind[]) {
      const setting = settings.find((x) => x.kind === kind);
      const value = wanted[kind];
      if (setting && value && value !== setting.current && setting.options.some((o) => o.value === value)) {
        settings = (await this.apply(setting, value)) ?? settings;
      }
    }
    knownSettings.set(this.agentId, settings);
    this.set({ settings });
  }

  private async apply(setting: AgentSetting, value: string): Promise<AgentSetting[] | null> {
    const conn = this.conn!;
    const sid = this.sessionId!;
    if (setting.via === "config") {
      const r = await conn.setConfigOption(sid, setting.id, value);
      if (r?.configOptions) return readSettings({ configOptions: r.configOptions, models: null });
    } else {
      await conn.setModel(sid, value);
    }
    return this.snap.settings.map((x) => (x.kind === setting.kind ? { ...x, current: value } : x));
  }

  /** Change model or effort. Remembered per agent and applied live if a session is running. */
  async setSetting(kind: SettingKind, value: string): Promise<void> {
    prefs.set(this.agentId, kind, value);
    const setting = this.snap.settings.find((x) => x.kind === kind);
    if (!setting) return;
    if (!this.conn || !this.sessionId) {
      this.set({ settings: this.snap.settings.map((x) => (x.kind === kind ? { ...x, current: value } : x)) });
      return;
    }
    try {
      const next = await this.apply(setting, value);
      if (next) {
        knownSettings.set(this.agentId, next);
        this.set({ settings: next });
      }
      const label = next?.find((x) => x.kind === kind)?.options.find((o) => o.value === value)?.name ?? value;
      this.notice(`${kind === "model" ? "Model" : "Effort"} set to ${label}.`);
    } catch (e) {
      this.notice(`Couldn't change ${kind}: ${e instanceof Error ? e.message : String(e)}`, "error");
    }
  }

  /** Learns an agent's settings without a worktree, so the pickers can show before first use. */
  async discover(cwd: string): Promise<void> {
    if (this.snap.settings.length || this.conn) return;
    const conn = new AcpConnection({ onUpdate: () => {}, onPermission: async () => ({ outcome: { outcome: "cancelled" } }) });
    try {
      await conn.start(this.agentId, cwd);
      const s = (await conn.newSession(cwd, [])) as SessionState;
      const settings = readSettings(s);
      knownSettings.set(this.agentId, settings);
      if (!this.conn) this.set({ settings: presetSettings(this.agentId) });
    } catch {
      /* the pickers fill in when the real session starts */
    } finally {
      await conn.dispose();
    }
  }

  /**
   * Point the conversation at a layer. The worktree must already be checked out there.
   * Adds a divider, and the next message tells the agent it has moved.
   */
  moveTo(layer: LayerRef) {
    const cur = this.snap.layer;
    if (cur && cur.pr === layer.pr && cur.headSha === layer.headSha) return;
    const label = `Layer ${layer.index} of ${layer.total} · #${layer.pr} ${layer.title}`;
    const hasHistory = this.snap.items.some((i) => i.kind === "user");
    if (hasHistory) {
      this.push({ kind: "divider", id: uid(), text: cur?.pr === layer.pr ? `${label} · new commits` : label });
      this.layerNote = cur?.pr === layer.pr
        ? `(Note: #${layer.pr} has new commits; the working directory is now at ${layer.headSha.slice(0, 12)}. Call get_review_context again before relying on earlier reading.)`
        : `(Note: we've moved to layer ${layer.index} of ${layer.total}, #${layer.pr} "${layer.title}". The working directory is now checked out at its head ${layer.headSha.slice(0, 12)}${layer.baseSha ? `, base ${layer.baseSha.slice(0, 12)}` : ""}. Your review tools now default to this layer. Earlier layers are in the base; keep what you learned about them in mind.)`;
    }
    this.set({ layer });
  }

  /** Forget this conversation and start a new one next time. */
  async reset() {
    await this.stop(false);
    this.savedSessionId = null;
    this.layerNote = null;
    this.set({ status: "idle", items: [], layer: null });
    durable.delete("chat", this.storageKey);
  }

  get running(): boolean {
    return !!this.conn && !!this.sessionId;
  }

  async send(text: string, display = text, opts: { guide?: boolean } = {}): Promise<void> {
    if (!this.conn || !this.sessionId) throw new Error("Agent is not running");
    if (this.layerNote) {
      text = `${this.layerNote}\n\n${text}`;
      this.layerNote = null;
    }
    this.push({ kind: "user", id: uid(), text: display });
    this.set({ status: "busy" });
    const firstNew = this.snap.items.length;
    try {
      const res = await this.conn.prompt(this.sessionId, this.usesMcp ? text : `${text}\n\n${opts.guide ? FALLBACK_GUIDE_FORMAT : FALLBACK_FORMAT}`);
      if (!this.usesMcp) await (opts.guide ? this.harvestGuide(firstNew) : this.harvestFindings(firstNew));
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
    // Stack Reviewer's own MCP tools only read the review and record draft findings, so the
    // agent may always use them. Everything else (shell commands, edits, other MCP servers) asks.
    if (isOwnTool(r.toolCall.title) || isOwnTool((r.toolCall as { rawInput?: { name?: string } }).rawInput?.name)) {
      const allow = r.options.find((o) => o.kind === "allow_always") ?? r.options.find((o) => o.kind === "allow_once");
      if (allow) return Promise.resolve({ outcome: { outcome: "selected", optionId: allow.optionId } });
    }
    const id = uid();
    this.push({
      kind: "permission", id,
      title: toolLabel(r.toolCall.title ?? "Run a tool"),
      options: r.options.map((o) => ({ optionId: o.optionId, name: o.name, kind: o.kind })),
    });
    return new Promise((resolve) => this.permissionWaiters.set(id, resolve));
  }

  private onUpdate(n: SessionNotification) {
    if (this.replaying) return;
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
        this.push({ kind: "tool", id: uid(), toolCallId: u.toolCallId, title: toolLabel(u.title, u.rawInput), status: u.status ?? "pending" });
        break;
      case "config_option_update":
        if (u.configOptions) {
          const settings = readSettings({ configOptions: u.configOptions, models: null });
          if (settings.length) {
            knownSettings.set(this.agentId, settings);
            this.set({ settings });
          }
        }
        break;
      case "tool_call_update":
        this.patchItem(
          (i) => i.kind === "tool" && i.toolCallId === u.toolCallId,
          (i) => ({ ...i, title: u.title ? toolLabel(u.title, u.rawInput) : (i as { title: string }).title, status: u.status ?? (i as { status: string }).status }) as ChatItem,
        );
        break;
      default:
        break;
    }
  }

  /** Guide mode without MCP: the agent's ```guide blocks are applied in order (layers first, then the stack). */
  private async harvestGuide(from: number) {
    const b = reviewBridge.get(this.stackId);
    if (!b) return;
    const text = this.snap.items.slice(from).filter((i) => i.kind === "agent").map((i) => (i as { text: string }).text).join("\n");
    const blocks = parseGuideBlocks(text);
    const errors: string[] = [];
    let saved = 0;
    for (const blk of blocks.filter((x) => x.kind === "layer")) {
      const r = await b.setLayerGuide((blk as { pr: number }).pr, blk.input, this.label());
      if (r.ok) saved++;
      else errors.push(r.error);
    }
    for (const blk of blocks.filter((x) => x.kind === "stack")) {
      const r = await b.setStackGuide(blk.input, this.label());
      if (r.ok) saved++;
      else errors.push(r.error);
    }
    if (!blocks.length) this.notice("No guide blocks came back from the agent.", "error");
    else if (errors.length) this.notice(`Saved ${saved} of ${blocks.length} guide parts. ${errors.join(" ")}`, "error");
  }

  private async harvestFindings(from: number) {
    const b = reviewBridge.get(this.stackId);
    const pr = this.snap.layer?.pr;
    if (!b || pr == null) return;
    const text = this.snap.items.slice(from).filter((i) => i.kind === "agent").map((i) => (i as { text: string }).text).join("\n");
    const found = parseFindingBlocks(text);
    let added = 0;
    for (const f of found) if ((await b.addFinding(f.pr ?? pr, f, this.agentName)).ok) added++;
    if (found.length) this.notice(`Placed ${added} of ${found.length} findings beside the diff.`);
  }
}

const FALLBACK_FORMAT = `This client cannot give you review tools, so report each finding in a fenced block exactly like:
\`\`\`findings
[{"path": "src/file.ts", "line": 42, "severity": "High|Medium|Low", "title": "short title", "body": "why and what to do", "suggestion": "optional replacement line"}]
\`\`\`
Use new-side line numbers that appear in the diff.`;

const FALLBACK_GUIDE_FORMAT = `This client cannot give you review tools, so report the guide in fenced blocks exactly like (one \`\`\`guide block holding a JSON array; layers first, bottom to top, the stack object last):
\`\`\`guide
[
  {"layer": {"pr": 412, "summary": "...", "tier": "light|moderate|heavy", "tier_reason": "...", "focus_areas": [{"path": "src/file.ts", "start_line": 10, "line": 18, "title": "...", "why": "..."}], "skim": [{"path": "package-lock.json", "why": "..."}], "questions": ["..."]}},
  {"stack": {"summary": "...", "layer_roles": [{"pr": 412, "role": "..."}], "cross_layer": [{"text": "...", "prs": [412, 413]}], "plan": "...", "ranking": [413, 412]}}
]
\`\`\`
Use new-side line numbers that appear in each layer's diff. The ranking lists every guided PR exactly once, hardest first.`;

// Kept on globalThis so a dev-mode hot reload of this module doesn't drop live conversations
// (and orphan their agent processes).
const g = globalThis as typeof globalThis & { __stackReviewerAgentSessions?: Map<string, AgentSession> };
const sessions = (g.__stackReviewerAgentSessions ??= new Map<string, AgentSession>());

export function getAgentSession(stackId: string, agentId: string, agentName: string): AgentSession {
  const key = `${stackId}|${agentId}`;
  let s = sessions.get(key);
  if (!s) {
    s = new AgentSession(agentId, agentName, stackId);
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
const EMPTY: Snapshot = { status: "idle", items: [], worktree: null, settings: [], layer: null };

export function checkFailurePrompt(number: number, checkNames: string[] = []): string {
  const which = checkNames.length ? ` (${checkNames.join(", ")})` : "";
  return `Checks are failing on #${number}${which}. Call get_check_failures, find the root cause (it may be in a lower layer of the stack) and explain it briefly. Add a finding if it is in this layer's changes.`;
}

export function reviewLayerPrompt(layerIndex: number, total: number, number: number): string {
  return `Review layer ${layerIndex} of ${total} (PR #${number}) of this stacked pull request with me.
The working directory is a checkout of this layer's head commit. We may move through other layers of the stack in this same conversation; anything you learned about lower layers still applies.

1. Call get_review_context to see the stack, this layer's description, its base and head commits and changed files.
2. Read the diff with \`git diff <base>...HEAD\` and read surrounding code as needed. Earlier layers are already in the base; later layers are not here yet.
3. If checks are failing, call get_check_failures and work out whether this layer or a lower one is the cause.
4. Call set_layer_brief with a 2-3 sentence summary and the best order to read the files in.
5. For each real problem (bugs, security, data loss, concurrency, missing error handling, misleading names, missing tests for risky logic) call add_finding, anchored to a changed line. Skip style nitpicks. Prefer a few high-signal findings over many.
6. Finish with a short message: what the layer does, what you flagged, and anything that needs a human decision.

Do not edit files, commit, push or post anything to GitHub.`;
}

export function reviewStackPrompt(layers: { index: number; number: number }[]): string {
  const list = layers.map((l) => `layer ${l.index} (#${l.number})`).join(", ");
  return `Review the whole stack with me, every open layer from the bottom up: ${list}.

The working directory only has the current layer's head checked out, so read each layer's diff from git objects instead of the checkout.
For each layer, bottom to top:
1. Call get_review_context with that layer's \`pr\` number. It gives the layer's description, changed files, \`base_sha\` and \`head_sha\`.
2. Read the layer's own changes with \`git diff <base_sha> <head_sha>\` (fetch first if a commit is missing: \`git fetch origin <head_sha>\`). Use \`git show <head_sha>:<path>\` for surrounding code. Layers below this one are already in its base.
3. For each real problem (bugs, security, data loss, concurrency, missing error handling, misleading names, missing tests for risky logic) call add_finding with that layer's \`pr\`, anchored to a changed line. Skip style nitpicks. Prefer a few high-signal findings over many.
4. Optionally call set_layer_brief with that layer's \`pr\` for a 2-3 sentence summary and reading order.
Findings you record for other layers land on those layers, so always pass the right \`pr\`.

Finish with a per-layer summary: what each layer does, what you flagged, and anything that needs a human decision. Mention problems that only show up across layers.

Do not edit files, commit, push or post anything to GitHub.`;
}

export type GuideLayerInfo = { index: number; number: number; title: string };
export type GuideKeptInfo = { number: number; tier: string; reason: string; role?: string };

const GUIDE_FIELDS = `Per layer, call set_layer_guide with:
- \`summary\`: 2-3 sentences on what the layer does.
- \`tier\`: light, moderate or heavy, judged against the other layers in this stack. Weigh risk, how much has to be understood rather than skimmed, new concepts, concurrency/security/data changes and cross-cutting reach. Size alone is not complexity: a 900-line fixture is Light.
- \`tier_reason\`: one line, e.g. "new concurrency around token refill; the rest is plumbing".
- \`focus_areas\`: 1-5 items {path, start_line?, line, title, why}, most important first. Lines are new-side lines in this layer's diff, and a range must sit inside one hunk.
- \`skim\`: files that are safe to skim (renames, generated code, fixtures, lockfiles, pure moves), each with a why.
- \`questions\`: 0-4 short questions the diff and description don't answer.`;

const GUIDE_RULES = `Judge complexity relative to the other layers. Keep output terse: the guide lives in the app, so end with a message of a few lines at most.
Do not record findings (no add_finding), edit files, commit, push or post anything to GitHub. This is a guide, not a review.`;

const GUIDE_STACK = `After the last layer, call set_stack_guide once with:
- \`summary\`: one short paragraph (markdown): the goal and the end state once every layer lands.
- \`layer_roles\`: {pr, role} for each layer, one line on its part in the story.
- \`cross_layer\`: concerns visible only across layers (an API added low and changed higher, a migration split across PRs, a layer that undoes another). May be empty.
- \`plan\`: 1-3 sentences (markdown) on where to spend time.
- \`ranking\`: every guided PR number, hardest first, each exactly once.
If a tool call returns an error, fix what it names and call again.`;

export function guideStackPrompt(layers: GuideLayerInfo[]): string {
  const list = layers.map((l) => `layer ${l.index} (#${l.number} ${l.title})`).join(", ");
  return `Guide me through this stack before I review it. Read every open layer from the bottom up: ${list}.

The working directory only has one layer's head checked out, so read each layer's diff from git objects.
For each layer, bottom to top:
1. Call get_review_context with that layer's \`pr\` number: its description, changed files, \`base_sha\` and \`head_sha\`.
2. Read the layer's own changes with \`git diff <base_sha> <head_sha>\` (fetch first if a commit is missing: \`git fetch origin <head_sha>\`). Use \`git show <head_sha>:<path>\` for surrounding code. Layers below are already in its base.
3. Call set_layer_guide for that layer right away, so I see progress. You may revise a tier later with another call.

${GUIDE_FIELDS}

${GUIDE_STACK}

${GUIDE_RULES}`;
}

/** Re-guide only the listed layers (stale, new, or the rest of an interrupted run), re-using the other layers' guides. */
export function guideRefreshPrompt(layers: GuideLayerInfo[], kept: GuideKeptInfo[], opts: { resume?: boolean } = {}): string {
  const list = layers.map((l) => `layer ${l.index} (#${l.number} ${l.title})`).join(", ");
  const others = kept.length
    ? `The other layers already have guides; do not reread them. Their current tier, reason and role, for ranking:\n${kept.map((k) => `- #${k.number}: ${k.tier} · ${k.reason}${k.role ? ` · role: ${k.role}` : ""}`).join("\n")}`
    : "";
  return `${opts.resume ? "Continue the guide for this stack" : "Refresh the guide for this stack"}. ${opts.resume ? "These layers still need a guide" : "These layers are new or have new commits since their guide"}: ${list}. Work bottom to top.

For each, call get_review_context with its \`pr\`, read its changes with \`git diff <base_sha> <head_sha>\` (fetch first if a commit is missing), and call set_layer_guide right away.

${GUIDE_FIELDS}

${others}

Then call set_stack_guide again with the full picture (summary, layer_roles for every layer, cross_layer, plan, and a ranking of every open layer, hardest first, each exactly once), re-ranking against the layers you did not reread.
If a tool call returns an error, fix what it names and call again.

${GUIDE_RULES}`;
}
