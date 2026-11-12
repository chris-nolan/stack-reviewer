import { useEffect, useMemo, useRef, useState } from "react";
import { useSource } from "../app/session";
import type { Layer, RepoRef, Stack } from "../lib/model";
import { repoKey } from "../lib/model";
import { invoke, isTauri, local } from "../lib/platform";
import { AgentDot } from "../ui/bits";
import { getAgentSession, reviewLayerPrompt, useAgentSnapshot, type ChatItem } from "./session";
import { useAgents } from "./useAgents";

type Props = {
  stack: Stack;
  layer: Layer;
  repo: RepoRef;
  currentFile: string | null;
  openFindings: number;
  onNextFinding: () => void;
  onClose: () => void;
};

type Worktree = { path: string; head: string; base: string };

export function AgentDock({ stack, layer, repo, currentFile, openFindings, onNextFinding, onClose }: Props) {
  const source = useSource();
  const agents = useAgents();
  const available = agents.data?.filter((a) => a.available) ?? [];
  const [agentId, setAgentId] = useState<string>(() => local.get("agent", "claude"));
  const agent = available.find((a) => a.id === agentId) ?? available[0];
  const stackId = `${repoKey(repo)}#${stack.key}`;
  const session = useMemo(() => (agent ? getAgentSession(stackId, agent.id, agent.name) : null), [stackId, agent]);
  const snap = useAgentSnapshot(session);
  const [input, setInput] = useState("");
  const [preparing, setPreparing] = useState<string | null>(null);
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => local.set("agent", agentId), [agentId]);
  useEffect(() => endRef.current?.scrollIntoView({ block: "end" }), [snap.items.length, snap.items.at(-1)]);

  const ensureRunning = async () => {
    if (!session) throw new Error("No agent available");
    const token = source.gitToken();
    if (!token) throw new Error("Agents need a real GitHub sign-in (demo data has no code to read).");
    setPreparing("Checking out this layer…");
    try {
      const wt = await invoke<Worktree>("worktree_prepare", {
        token, owner: repo.owner, repo: repo.repo, number: layer.pr.number, headSha: layer.pr.headSha, baseRef: layer.pr.baseRef,
      });
      setPreparing(`Starting ${session.agentName}…`);
      await session.start(wt.path);
    } finally {
      setPreparing(null);
    }
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
  const quick = [
    { label: `Review layer ${layer.index}`, run: () => send(reviewLayerPrompt(layer.index, stack.layers.length, layer.pr.number), `Review layer ${layer.index} (#${layer.pr.number})`) },
    ...(layer.pr.checks === "fail" ? [{ label: "Why are checks failing?", run: () => send(`Checks are failing on #${layer.pr.number}. Call get_check_failures, find the root cause (it may be in a lower layer of the stack) and explain it briefly. Add a finding if it is in this layer's changes.`, "Why are checks failing?") }] : []),
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
      <div style={{ display: "flex", flexWrap: "wrap", gap: 4, padding: "8px 12px", borderBottom: "1px solid var(--border)" }}>
        {["#" + layer.pr.number + " diff", "whole stack", "checks + logs", "worktree"].map((c) => <span key={c} className="pill" style={{ fontSize: 11, background: "#1a1f26", color: "var(--text-2)" }}>{c}</span>)}
        <span className="pill" style={{ fontSize: 11, background: "#2a1f12", color: "var(--agent)" }}>drafts only</span>
      </div>
      <div className="scroll" style={{ flex: "1 1 auto", padding: 12, display: "flex", flexDirection: "column", gap: 12, lineHeight: 1.5 }} aria-live="polite">
        {snap.items.length === 0 && (
          <p className="muted" style={{ margin: 0 }}>
            {agent?.name} works in a local checkout of #{layer.pr.number}. It can read code and, with your permission, run commands. Its findings appear beside the diff as drafts. Nothing is posted until you submit your review.
          </p>
        )}
        {snap.items.map((i) => <Item key={i.id} item={i} onAnswer={(opt) => session?.answerPermission(i.id, opt)} />)}
        {preparing && <span className="muted" style={{ display: "flex", gap: 8, alignItems: "center" }}><span className="spinner" aria-hidden="true" />{preparing}</span>}
        {snap.status === "busy" && <span className="muted" style={{ display: "flex", gap: 8, alignItems: "center" }}><span className="spinner" aria-hidden="true" />Working…</span>}
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
      return <div style={{ color: "#dadde2", whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{item.text}</div>;
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
                <button key={o.optionId} className={o.kind === "allow_once" ? "btn btn-sm btn-soft" : "btn btn-sm"} onClick={() => onAnswer(o.optionId)}>{o.name}</button>
              ))}
            </div>
          )}
        </div>
      );
    case "notice":
      return <div style={{ fontSize: 12, color: item.tone === "error" ? "var(--bad-fg)" : "var(--muted)" }}>{item.text}</div>;
  }
}
