// Minimal Agent Client Protocol (ACP) client over the Rust stdio relay.
// Speaks JSON-RPC 2.0, one message per line. We advertise no fs/terminal capabilities:
// agents read the worktree themselves and ask permission before running commands.

import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type {
  InitializeResponse, LoadSessionResponse, McpServer, NewSessionResponse, PromptResponse, RequestPermissionRequest,
  RequestPermissionResponse, SessionConfigOption, SessionNotification,
} from "@agentclientprotocol/sdk";
import { invoke } from "../lib/platform";

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void };

export type AcpHandlers = {
  onUpdate: (n: SessionNotification) => void;
  onPermission: (req: RequestPermissionRequest) => Promise<RequestPermissionResponse>;
  onStderr?: (line: string) => void;
  onExit?: () => void;
};

export class AcpError extends Error {
  constructor(message: string, readonly code: number, readonly data?: unknown) {
    super(message);
  }
}

export class AcpConnection {
  private pid = 0;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private unlisten: UnlistenFn[] = [];
  private exited = false;
  init: InitializeResponse | null = null;

  constructor(private handlers: AcpHandlers) {}

  async start(agent: string, cwd: string): Promise<InitializeResponse> {
    // Subscribe before spawning would be ideal, but the event names include the pid. The Rust
    // side only starts reading once spawned, and the agent waits for `initialize` before writing.
    this.pid = await invoke<number>("agent_spawn", { agent, cwd });
    this.unlisten.push(
      await listen<string>(`agent-stdout-${this.pid}`, (e) => this.onLine(e.payload)),
      await listen<string>(`agent-stderr-${this.pid}`, (e) => this.handlers.onStderr?.(e.payload)),
      await listen(`agent-exit-${this.pid}`, () => {
        this.exited = true;
        for (const p of this.pending.values()) p.reject(new Error("The agent process exited"));
        this.pending.clear();
        this.handlers.onExit?.();
      }),
    );
    this.init = await this.request<InitializeResponse>("initialize", {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      clientInfo: { name: "stack-reviewer", title: "Stack Reviewer", version: "0.1.0" },
    });
    return this.init;
  }

  get supportsHttpMcp(): boolean {
    return !!this.init?.agentCapabilities?.mcpCapabilities?.http;
  }

  async newSession(cwd: string, mcpServers: McpServer[]): Promise<NewSessionResponse> {
    try {
      return await this.request<NewSessionResponse>("session/new", { cwd, mcpServers });
    } catch (e) {
      const methods = this.init?.authMethods ?? [];
      if (e instanceof AcpError && e.code === -32000 && methods.length) {
        // Agent needs a login step. Use its first method (typically the CLI's own login), then retry.
        await this.request("authenticate", { methodId: methods[0].id });
        return this.request<NewSessionResponse>("session/new", { cwd, mcpServers });
      }
      throw e;
    }
  }

  setConfigOption(sessionId: string, configId: string, value: string): Promise<{ configOptions?: SessionConfigOption[] }> {
    return this.request("session/set_config_option", { sessionId, configId, value });
  }

  /** Older (pre-config-options) model switching, still used by Gemini CLI. */
  setModel(sessionId: string, modelId: string): Promise<unknown> {
    return this.request("session/set_model", { sessionId, modelId });
  }

  setMode(sessionId: string, modeId: string): Promise<unknown> {
    return this.request("session/set_mode", { sessionId, modeId });
  }

  get supportsLoad(): boolean {
    return !!this.init?.agentCapabilities?.loadSession;
  }

  /** Resumes an earlier session. The agent replays its history as session/update notifications. */
  loadSession(sessionId: string, cwd: string, mcpServers: McpServer[]): Promise<LoadSessionResponse> {
    return this.request<LoadSessionResponse>("session/load", { sessionId, cwd, mcpServers });
  }

  prompt(sessionId: string, text: string): Promise<PromptResponse> {
    return this.request<PromptResponse>("session/prompt", { sessionId, prompt: [{ type: "text", text }] });
  }

  cancel(sessionId: string): void {
    void this.send({ jsonrpc: "2.0", method: "session/cancel", params: { sessionId } });
  }

  async dispose(): Promise<void> {
    this.unlisten.forEach((u) => u());
    this.unlisten = [];
    if (this.pid && !this.exited) await invoke("agent_kill", { id: this.pid }).catch(() => {});
  }

  private request<T>(method: string, params: unknown): Promise<T> {
    if (this.exited) return Promise.reject(new Error("The agent is not running"));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.send({ jsonrpc: "2.0", id, method, params }).catch((e) => {
        this.pending.delete(id);
        reject(e);
      });
    });
  }

  private send(msg: unknown): Promise<void> {
    return invoke("agent_write", { id: this.pid, line: JSON.stringify(msg) });
  }

  private onLine(line: string) {
    let msg: { id?: number | string; method?: string; params?: unknown; result?: unknown; error?: { code: number; message: string; data?: unknown } };
    try {
      msg = JSON.parse(line);
    } catch {
      this.handlers.onStderr?.(line); // some adapters log to stdout
      return;
    }
    if (msg.method && msg.id != null) return void this.onRequest(msg.id, msg.method, msg.params);
    if (msg.method) {
      if (msg.method === "session/update") this.handlers.onUpdate(msg.params as SessionNotification);
      return;
    }
    if (msg.id != null) {
      const p = this.pending.get(Number(msg.id));
      if (!p) return;
      this.pending.delete(Number(msg.id));
      if (msg.error) p.reject(new AcpError(msg.error.message, msg.error.code, msg.error.data));
      else p.resolve(msg.result);
    }
  }

  private async onRequest(id: number | string, method: string, params: unknown) {
    try {
      if (method === "session/request_permission") {
        const result = await this.handlers.onPermission(params as RequestPermissionRequest);
        return void this.send({ jsonrpc: "2.0", id, result });
      }
      await this.send({ jsonrpc: "2.0", id, error: { code: -32601, message: `Stack Reviewer does not support ${method}` } });
    } catch (e) {
      await this.send({ jsonrpc: "2.0", id, error: { code: -32603, message: e instanceof Error ? e.message : String(e) } });
    }
  }
}
