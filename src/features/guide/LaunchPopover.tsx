import { useEffect, useMemo, useRef, useState } from "react";
import { homeDir } from "@tauri-apps/api/path";
import { useSession, useSource } from "../../app/session";
import { getAgentSession, useAgentSnapshot } from "../../agent/session";
import { knownSettings, type AgentSetting } from "../../agent/settings";
import { useAgents, type AgentInfo } from "../../agent/useAgents";
import type { GuideLaunch } from "../../agent/guideRun";
import { isTauri, local } from "../../lib/platform";
import { GuideIcon } from "../../ui/guide";

const DEMO_SETTINGS: AgentSetting[] = [
  { kind: "model", id: "model", via: "config", name: "Model", current: "opus", options: [{ value: "opus", name: "Opus 5.5" }, { value: "sonnet", name: "Sonnet 5.5" }] },
  { kind: "effort", id: "effort", via: "config", name: "Effort", current: "high", options: [{ value: "low", name: "Low" }, { value: "medium", name: "Medium" }, { value: "high", name: "High" }, { value: "max", name: "Max" }] },
];

function Segmented({ label, value, options, onChange }: { label: string; value: string; options: { value: string; name: string; description?: string }[]; onChange: (v: string) => void }) {
  return (
    <div role="group" aria-label={label} style={{ display: "flex", flexDirection: "column", gap: 5 }}>
      <span className="label" style={{ fontSize: 10 }}>{label}</span>
      <div style={{ display: "flex", flexWrap: "wrap", border: "1px solid var(--border-strong)", borderRadius: 8, overflow: "hidden", alignSelf: "flex-start", maxWidth: "100%" }}>
        {options.map((o) => (
          <button key={o.value} type="button" aria-pressed={value === o.value} title={o.description} onClick={() => onChange(o.value)} style={{ padding: "5px 11px", border: 0, borderRight: "1px solid var(--border-strong)", background: value === o.value ? "var(--agent-bg)" : "transparent", color: value === o.value ? "var(--agent)" : "var(--text-2)", fontWeight: value === o.value ? 600 : 400 }}>
            {o.name}
          </button>
        ))}
      </div>
    </div>
  );
}

/** The "Guide me" launch popover: agent, model, effort, scope and a read-only reminder. */
export function LaunchPopover({ stackId, openLayers, mode, onStart, onClose }: {
  stackId: string;
  openLayers: number;
  /** "all" for a first guide or re-run; "refresh" lists only changed layers. */
  mode: "all" | "refresh";
  onStart: (o: GuideLaunch) => void;
  onClose: () => void;
}) {
  const source = useSource();
  const login = useSession().viewer?.login ?? "";
  const demo = source.kind === "fixtures";
  const agentsQ = useAgents();
  const agents: AgentInfo[] = demo
    ? [{ id: "claude", name: "Claude Code", available: true, detail: "" }, { id: "gemini", name: "Gemini CLI", available: true, detail: "" }]
    : agentsQ.data ?? [];
  const [agentId, setAgentId] = useState(() => local.get("agent", "claude"));
  const agent = agents.find((a) => a.id === agentId && a.available) ?? agents.find((a) => a.available);
  if (demo && !knownSettings.get("claude").length) knownSettings.set("claude", DEMO_SETTINGS);
  const session = useMemo(() => (agent ? getAgentSession(login, stackId, agent.id, agent.name) : null), [login, stackId, agent]);
  const snap = useAgentSnapshot(session);
  const settings = demo && !snap.settings.length ? knownSettings.get(agent?.id ?? "claude") : snap.settings;
  const [chosen, setChosen] = useState<{ model?: string; effort?: string }>({});
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    // First time with this agent: learn its models and effort levels so the pickers can show.
    if (!session || demo || !isTauri() || session.getSnapshot().settings.length) return;
    void homeDir().then((h) => session.discover(h)).catch(() => {});
  }, [session, demo]);
  useEffect(() => {
    const key = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    const click = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && !(e.target as HTMLElement).closest("[data-guide-launch]") && onClose();
    window.addEventListener("keydown", key);
    window.addEventListener("mousedown", click);
    return () => {
      window.removeEventListener("keydown", key);
      window.removeEventListener("mousedown", click);
    };
  }, [onClose]);

  const pick = (s: AgentSetting) => chosen[s.kind] ?? s.current;
  return (
    <div ref={ref} role="dialog" aria-label="Guide me" style={{ position: "absolute", top: "calc(100% + 8px)", right: 0, zIndex: 20, width: 400, padding: 16, display: "flex", flexDirection: "column", gap: 12, borderRadius: 12, border: "1px solid var(--agent-bd)", background: "var(--surface)", boxShadow: "0 12px 32px rgba(0,0,0,.45)" }}>
      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        <strong style={{ display: "flex", gap: 8, alignItems: "center", color: "var(--agent)", fontSize: 14 }}><GuideIcon size={15} />{mode === "refresh" ? "Refresh the guide" : "Guide me through this stack"}</strong>
        <span className="muted" style={{ lineHeight: 1.5 }}>The agent reads every open layer, summarises the stack, ranks layers by how hard they are to review, and marks where to focus in each.</span>
      </div>
      {!agents.some((a) => a.available) && agentsQ.data && <span className="error-box">{isTauri() ? "No supported agent found. Install Claude Code or Gemini CLI." : "Agents run in the desktop app."}</span>}
      <Segmented label="Agent" value={agent?.id ?? ""} options={agents.filter((a) => a.available).map((a) => ({ value: a.id, name: a.name }))} onChange={(v) => { setAgentId(v); setChosen({}); }} />
      {settings.map((s) => <Segmented key={s.kind} label={s.kind === "model" ? "Model" : "Effort"} value={pick(s)} options={s.options} onChange={(v) => setChosen((c) => ({ ...c, [s.kind]: v }))} />)}
      {agent && !settings.length && <span className="muted" style={{ fontSize: 12 }}>Model and effort appear once {agent.name} has been started; its defaults apply until then.</span>}
      {settings.length > 0 && <span className="faint" style={{ fontSize: 12 }}>Pickers come from the agent, prefilled with what you last chose in the chat.</span>}
      <div style={{ display: "flex", flexDirection: "column", gap: 4, paddingTop: 10, borderTop: "1px solid var(--border)", lineHeight: 1.5 }}>
        <span style={{ color: "var(--text-2)" }}>{openLayers} open {openLayers === 1 ? "layer" : "layers"}. Merged and closed layers are skipped.</span>
        <span className="muted" style={{ fontSize: 12 }}>Runs in this stack's agent chat, so you can ask follow-ups afterwards. Read-only: no findings, nothing posted to GitHub.</span>
      </div>
      {snap.status === "busy" && <span style={{ color: "var(--warn-fg)", fontSize: 12 }}>{agent?.name} is busy in this stack's chat. Wait for its reply, or stop it from the chat, before starting the guide.</span>}
      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn btn-agent" style={{ fontWeight: 600 }} disabled={!agent || snap.status === "busy"}onClick={() => agent && onStart({ agentId: agent.id, agentName: agent.name, model: chosen.model, effort: chosen.effort, mode })}>
          {mode === "refresh" ? "Refresh guide" : "Start guide"}
        </button>
      </div>
    </div>
  );
}
