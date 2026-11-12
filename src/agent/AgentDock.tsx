import { useEffect, useMemo, useRef, useState } from "react";
import type { Layer, RepoRef, Stack } from "../lib/model";
import { repoKey } from "../lib/model";
import { useSession } from "../app/session";
import { isTauri, local } from "../lib/platform";
import { AgentDot } from "../ui/bits";
import { Markdown } from "../ui/Markdown";
import { homeDir } from "@tauri-apps/api/path";
import { checkFailurePrompt, getAgentSession, reviewLayerPrompt, reviewStackPrompt, useAgentSnapshot, type AgentSession, type ChatItem } from "./session";
import type { AgentSetting } from "./settings";
import { useAgents } from "./useAgents";
import { useStackAgent } from "./useStackAgent";

export type AgentRequest = { id: number; text: string; display: string };

type Props = {
  stack: Stack;
  layer: Layer;
  repo: RepoRef;
  currentFile: string | null;
  openFindings: number;
  onNextFinding: () => void;
  onClose: () => void;
  /** A message requested from elsewhere in the review screen; sent once the agent is free. */
  request?: AgentRequest | null;
  onRequestHandled?: (id: number) => void;
};

export function AgentDock({ stack, layer, repo, currentFile, openFindings, onNextFinding, onClose, request, onRequestHandled }: Props) {
  const agents = useAgents();
  const login = useSession().viewer?.login ?? "";
  const available = agents.data?.filter((a) => a.available) ?? [];
  const [agentId, setAgentId] = useState<string>(() => local.get("agent", "claude"));
  const agent = available.find((a) => a.id === agentId) ?? available[0];
  const stackId = `${repoKey(repo)}#${stack.key}`;
  const session = useMemo(() => (agent ? getAgentSession(login, stackId, agent.id, agent.name) : null), [login, stackId, agent]);
  const snap = useAgentSnapshot(session);
  const [input, setInput] = useState("");
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => local.set("agent", agentId), [agentId]);
  useEffect(() => {
    // First time with this agent: learn its models/effort levels so the pickers show before a review starts.
    if (!session || !isTauri() || session.getSnapshot().settings.length) return;
    void homeDir().then((home) => session.discover(home)).catch(() => {});
  }, [session]);
  useEffect(() => endRef.current?.scrollIntoView({ block: "end" }), [snap.items.length, snap.items.at(-1)]);

  const { ensureRunning: ensure, preparing } = useStackAgent(stack);
  const agentLayer = snap.layer;
  const elsewhere = !!agentLayer && (agentLayer.pr !== layer.pr.number || agentLayer.headSha !== layer.pr.headSha);
  const ensureRunning = () => {
    if (!session) throw new Error("No agent available");
    return ensure(session, layer);
  };

  const send = async (text: string, display?: string) => {
    if (!session) return;
    try {
      await ensureRunning();
      await session.send(text, display);
    } catch (e) {
      if (snap.status !== "error") session.notice(e instanceof Error ? e.message : String(e), "error");
    }
  };

  const busy = snap.status === "busy" || snap.status === "starting" || !!preparing;

  // Requests from the rest of the screen (e.g. "Ask the agent why" on a failing check). If the
  // agent is busy, wait until it is free rather than dropping the request.
  const handled = useRef<number | null>(null);
  useEffect(() => {
    if (!request || handled.current === request.id || busy || !session || !agent) return;
    handled.current = request.id;
    onRequestHandled?.(request.id);
    void send(request.text, request.display);
  }, [request, busy, session, agent]);
  const queued = !!request && handled.current !== request.id;
  const quick = [
    { label: `Review layer ${layer.index}`, run: () => send(reviewLayerPrompt(layer.index, stack.layers.length, layer.pr.number), `Review layer ${layer.index} (#${layer.pr.number})`) },
    ...(stack.layers.filter((l) => l.pr.state === "OPEN").length > 1 ? [{ label: "Review whole stack", run: () => send(reviewStackPrompt(stack.layers.filter((l) => l.pr.state === "OPEN").map((l) => ({ index: l.index, number: l.pr.number }))), "Review the whole stack") }] : []),
    ...(layer.pr.checks === "fail" ? [{ label: "Why are checks failing?", run: () => send(checkFailurePrompt(layer.pr.number), "Why are checks failing?") }] : []),
    ...(currentFile ? [{ label: "Explain this file", run: () => send(`Explain the changes to ${currentFile} in #${layer.pr.number}: what they do and what a reviewer should check. Don't add findings unless something is wrong.`, `Explain ${currentFile.split("/").pop()}`) }] : []),
    { label: "Draft review summary", run: () => send(`Draft a short review summary for #${layer.pr.number} based on our discussion and the findings so far, and save it with set_review_summary. Keep it under 80 words.`, "Draft review summary") },
  ];

  if (!isTauri()) {
    return (
      <DockShell onClose={onClose} title="Agent">
        <p className="muted" style={{ padding: 14, margin: 0, lineHeight: 1.6 }}>Agents run in the desktop app, where Stack Reviewer can start Claude Code or Gemini CLI on your machine.</p>
      </DockShell>
    );
  }
  if (agents.data && !available.length) {
    return (
      <DockShell onClose={onClose} title="Agent">
        <div style={{ padding: 14, lineHeight: 1.6 }} className="muted">
          No supported agent found. Install one of these and reopen the panel:
          <ul>{agents.data.map((a) => <li key={a.id}><strong style={{ color: "var(--text)" }}>{a.name}</strong>: {a.detail}</li>)}</ul>
        </div>
      </DockShell>
    );
  }

  return (
    <DockShell
      onClose={onClose}
      title={
        <>
          <AgentDot ok={snap.status !== "error"} />
          <label htmlFor="agentPick" className="sr-only">Agent</label>
          <select id="agentPick" className="input" style={{ padding: "4px 6px", fontWeight: 600 }} value={agent?.id} onChange={(e) => setAgentId(e.target.value)}>
            {available.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
          </select>
        </>
      }
    >
      <div style={{ display: "flex", flexWrap: "wrap", gap: 4, padding: "8px 12px", borderBottom: "1px solid var(--border)", alignItems: "center" }}>
        <span className="pill" style={{ fontSize: 11, background: "#1a1f26", color: "var(--text-2)" }} title="One conversation for the whole stack">whole stack</span>
        <span className="pill" style={{ fontSize: 11, background: "#1a1f26", color: "var(--text-2)" }}>checks + logs</span>
        <span className="pill" style={{ fontSize: 11, background: "#2a1f12", color: "var(--agent)" }}>drafts only</span>
        <span className="spacer" />
        {snap.items.length > 0 && <button className="btn btn-sm" disabled={busy} onClick={() => void session?.reset()} title="Forget this conversation and start a new one">New chat</button>}
      </div>
      {agentLayer && (
        <div style={{ padding: "6px 12px", borderBottom: "1px solid var(--border)", fontSize: 12, background: elsewhere ? "var(--warn-bg)" : undefined, color: elsewhere ? "var(--warn-fg)" : "var(--muted)" }}>
          {elsewhere
            ? snap.status === "busy"
              ? `Still working on layer ${agentLayer.index} (#${agentLayer.pr}). Its findings go to that layer.`
              : `On layer ${agentLayer.index} (#${agentLayer.pr}). Your next message moves it to layer ${layer.index}.`
            : `Working on layer ${agentLayer.index} of ${agentLayer.total} · #${agentLayer.pr}`}
        </div>
      )}
      <AgentSettingsRow session={session} settings={snap.settings} disabled={snap.status === "busy" || snap.status === "starting"} />

      <div className="scroll" style={{ flex: "1 1 auto", padding: 12, display: "flex", flexDirection: "column", gap: 12, lineHeight: 1.5 }} aria-live="polite">
        {snap.items.length === 0 && (
          <p className="muted" style={{ margin: 0 }}>
            One conversation for the whole stack. {agent?.name} works in a local checkout that follows you from layer to layer, and remembers what it learned lower down. It can read code and, with your permission, run commands. Its findings appear beside the diff as drafts. Nothing is posted until you submit your review.
          </p>
        )}
        {snap.items.map((i) => <Item key={i.id} item={i} onAnswer={(opt) => session?.answerPermission(i.id, opt)} />)}
        {preparing && <span className="muted" style={{ display: "flex", gap: 8, alignItems: "center" }}><span className="spinner" aria-hidden="true" />{preparing}</span>}
        {snap.status === "busy" && <span className="muted" style={{ display: "flex", gap: 8, alignItems: "center" }}><span className="spinner" aria-hidden="true" />Working…</span>}
        {queued && busy && <span className="muted" style={{ fontSize: 12 }}>Queued: “{request!.display}” will be sent when {agent?.name} finishes.</span>}
        {openFindings > 0 && (
          <button className="btn btn-agent" style={{ alignSelf: "flex-start" }} onClick={onNextFinding}>Go to next finding · {openFindings} to triage</button>
        )}
        <div ref={endRef} />
      </div>
      <div style={{ padding: "10px 12px 12px", borderTop: "1px solid var(--border)", display: "flex", flexDirection: "column", gap: 8 }}>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
          {quick.map((q) => <button key={q.label} className="btn btn-chip" disabled={busy} onClick={q.run}>{q.label}</button>)}
        </div>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (input.trim() && !busy) {
              const t = input.trim();
              setInput("");
              void send(`(Reviewing #${layer.pr.number}${currentFile ? `, looking at ${currentFile}` : ""}.) ${t}`, t);
            }
          }}
          style={{ display: "flex", gap: 6, alignItems: "flex-end" }}
        >
          <label htmlFor="ask" className="sr-only">Message the agent</label>
          <textarea
            id="ask" className="input" rows={2} value={input} placeholder={`Ask about #${layer.pr.number}…`}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                (e.currentTarget.form as HTMLFormElement).requestSubmit();
              }
            }}
            style={{ resize: "none" }}
          />
          {snap.status === "busy" ? (
            <button type="button" className="btn" onClick={() => session?.cancel()}>Stop</button>
          ) : (
            <button type="submit" className="btn btn-primary" disabled={busy || !input.trim()}>Send</button>
          )}
        </form>
      </div>
    </DockShell>
  );
}

function AgentSettingsRow({ session, settings, disabled }: { session: AgentSession | null; settings: AgentSetting[]; disabled: boolean }) {
  if (!session) return null;
  if (!settings.length) {
    return <div className="muted" style={{ padding: "6px 12px", fontSize: 12, borderBottom: "1px solid var(--border)" }}>Model and effort appear once {session.agentName} has started.</div>;
  }
  return (
    <div style={{ display: "flex", gap: 8, padding: "8px 12px", borderBottom: "1px solid var(--border)", alignItems: "center" }}>
      {settings.map((s) => {
        const id = `agent-${s.kind}`;
        const current = s.options.find((o) => o.value === s.current);
        return (
          <label key={s.kind} htmlFor={id} style={{ flex: s.kind === "model" ? "1 1 60%" : "1 1 40%", minWidth: 0, display: "flex", flexDirection: "column", gap: 3 }}>
            <span className="label" style={{ fontSize: 10 }}>{s.kind === "model" ? "Model" : "Effort"}</span>
            <select
              id={id}
              className="input"
              style={{ padding: "4px 6px", fontSize: 12 }}
              value={s.current}
              disabled={disabled}
              title={current?.description}
              onChange={(e) => void session.setSetting(s.kind, e.target.value)}
            >
              {!current && <option value={s.current}>{s.current}</option>}
              {s.options.map((o) => <option key={o.value} value={o.value} title={o.description}>{o.name}</option>)}
            </select>
          </label>
        );
      })}
    </div>
  );
}

function DockShell({ title, onClose, children }: { title: React.ReactNode; onClose: () => void; children: React.ReactNode }) {
  return (
    <aside aria-label="Agent" style={{ flex: "0 0 340px", width: 340, minWidth: 0, display: "flex", flexDirection: "column", borderLeft: "1px solid var(--border)", background: "var(--chrome)", minHeight: 0, height: "100%" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "10px 12px", borderBottom: "1px solid var(--border)" }}>
        <span style={{ flex: "1 1 auto", display: "flex", alignItems: "center", gap: 8, fontWeight: 600 }}>{title}</span>
        <button className="btn btn-icon" onClick={onClose} aria-label="Close agent panel">✕</button>
      </div>
      {children}
    </aside>
  );
}

function Item({ item, onAnswer }: { item: ChatItem; onAnswer: (optionId: string | null) => void }) {
  switch (item.kind) {
    case "user":
      return <div style={{ alignSelf: "flex-end", maxWidth: "88%", padding: "7px 11px", borderRadius: 12, background: "#1f2a3b", whiteSpace: "pre-wrap" }}>{item.text}</div>;
    case "agent":
      return <div style={{ color: "#dadde2" }}><Markdown text={item.text} /></div>;
    case "thought":
      return (
        <details className="muted" style={{ fontSize: 12 }}>
          <summary>Thinking</summary>
          <div style={{ whiteSpace: "pre-wrap", marginTop: 4 }}>{item.text}</div>
        </details>
      );
    case "tool": {
      const color = item.status === "completed" ? "var(--ok)" : item.status === "failed" ? "var(--bad)" : "var(--warn)";
      const glyph = item.status === "completed" ? "✓" : item.status === "failed" ? "✕" : "●";
      return <div className="muted" style={{ fontSize: 12, display: "flex", gap: 6 }}><span style={{ color }} aria-label={item.status}>{glyph}</span><span style={{ overflowWrap: "anywhere" }}>{item.title}</span></div>;
    }
    case "permission":
      return (
        <div style={{ padding: 10, borderRadius: 10, border: "1px solid #3a3328", background: "#18160f", display: "flex", flexDirection: "column", gap: 8 }}>
          <span style={{ color: "var(--warn-fg)" }}>Permission requested</span>
          <code style={{ fontSize: 12, whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{item.title}</code>
          {item.chosen ? (
            <span className="muted" style={{ fontSize: 12 }}>{item.chosen === "cancelled" ? "Cancelled" : `Answered: ${item.options.find((o) => o.optionId === item.chosen)?.name ?? item.chosen}`}</span>
          ) : (
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
              {item.options.map((o) => (
                <button key={o.optionId} className={o.kind === "allow_once" ? "btn btn-sm btn-soft" : "btn btn-sm"} style={{ whiteSpace: "normal", textAlign: "left", maxWidth: "100%", lineHeight: 1.35 }} onClick={() => onAnswer(o.optionId)}>{o.name}</button>
              ))}
            </div>
          )}
        </div>
      );
    case "notice":
      return <div style={{ fontSize: 12, color: item.tone === "error" ? "var(--bad-fg)" : "var(--muted)" }}>{item.text}</div>;
    case "divider":
      return (
        <div role="separator" aria-label={item.text} style={{ display: "flex", alignItems: "center", gap: 8, color: "var(--accent-soft-fg)", fontSize: 12, margin: "4px 0" }}>
          <span style={{ flex: "1 1 auto", height: 1, background: "var(--accent-soft-bd)" }} />
          <span style={{ flex: "0 1 auto", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{item.text}</span>
          <span style={{ flex: "1 1 auto", height: 1, background: "var(--accent-soft-bd)" }} />
        </div>
      );
  }
}
