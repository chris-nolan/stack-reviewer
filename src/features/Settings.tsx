import { useState, type ReactNode } from "react";
import { PaletteButton } from "../app/Palette";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useSession } from "../app/session";
import { useNav } from "../app/nav";
import { useAgents } from "../agent/useAgents";
import { agentConfig, type AgentCommand, type CustomAgent } from "../agent/config";
import { invoke, isTauri, local } from "../lib/platform";
import { AgentDot, ChevronLeft, ErrorBox, Spinner } from "../ui/bits";

type WorktreeInfo = { name: string; path: string; size: number; modified: number; legacy: boolean };
type RepoCache = { owner: string; repo: string; path: string; clone_size: number; size: number; worktrees: WorktreeInfo[] };
type CacheReport = { path: string; total_size: number; repos: RepoCache[] };
type CleanupResult = { removed: string[]; freed: number; errors: string[] };

export function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const u = ["KB", "MB", "GB", "TB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < u.length - 1) (v /= 1024), i++;
  return `${v.toFixed(v < 10 ? 1 : 0)} ${u[i]}`;
}

const ago = (secs: number) => {
  if (!secs) return "unknown";
  const d = Math.floor((Date.now() / 1000 - secs) / 86400);
  return d <= 0 ? "today" : d === 1 ? "yesterday" : `${d} days ago`;
};

function Section({ title, note, children }: { title: string; note?: string; children: ReactNode }) {
  return (
    <section style={{ marginBottom: 32 }}>
      <h2 style={{ fontSize: 15, margin: "0 0 4px" }}>{title}</h2>
      {note && <p className="muted" style={{ margin: "0 0 12px", fontSize: 12 }}>{note}</p>}
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>{children}</div>
    </section>
  );
}

function Row({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 16, justifyContent: "space-between", flexWrap: "wrap" }}>
      <div>
        <div>{label}</div>
        {hint && <div className="muted" style={{ fontSize: 12 }}>{hint}</div>}
      </div>
      {children}
    </div>
  );
}

function DesktopOnly({ what }: { what: string }) {
  return <p className="muted" style={{ margin: 0 }}>{what} is available in the desktop app only.</p>;
}

/** Button that asks for a second click before doing something destructive. */
function ConfirmButton({ label, confirmLabel, onConfirm, disabled }: { label: string; confirmLabel: string; onConfirm: () => void; disabled?: boolean }) {
  const [asking, setAsking] = useState(false);
  if (!asking) return <button className="btn btn-sm" disabled={disabled} onClick={() => setAsking(true)}>{label}</button>;
  return (
    <span style={{ display: "inline-flex", gap: 6 }}>
      <button className="btn btn-sm btn-primary" onClick={() => { setAsking(false); onConfirm(); }}>{confirmLabel}</button>
      <button className="btn btn-sm" onClick={() => setAsking(false)}>Cancel</button>
    </span>
  );
}

function General() {
  const { org, orgs, setOrg } = useSession();
  const [singles, setSingles] = useState(() => local.get("includeSingles", false));
  const [notify, setNotify] = useState(() => local.get("notifications", true));
  return (
    <Section title="General">
      <Row label="Default organisation" hint="Shown first in the inbox.">
        <select className="input" style={{ width: 220 }} aria-label="Default organisation" value={org} onChange={(e) => setOrg(e.target.value)}>
          {!orgs.includes(org) && <option value={org}>{org || "—"}</option>}
          {orgs.map((o) => <option key={o} value={o}>{o}</option>)}
        </select>
      </Row>
      <Row label="Include single PRs" hint="Also list PRs that aren't part of a stack.">
        <input type="checkbox" aria-label="Include single PRs" checked={singles} onChange={(e) => { setSingles(e.target.checked); local.set("includeSingles", e.target.checked); }} />
      </Row>
      <Row label="Desktop notifications" hint="Notify when a stack needs your review or changes.">
        <input type="checkbox" aria-label="Desktop notifications" checked={notify} onChange={(e) => { setNotify(e.target.checked); local.set("notifications", e.target.checked); }} />
      </Row>
    </Section>
  );
}

function CommandFields({ value, onChange, placeholder }: { value: AgentCommand; onChange: (v: AgentCommand) => void; placeholder?: AgentCommand }) {
  return (
    <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
      <input className="input" style={{ flex: "2 1 220px" }} aria-label="Command" placeholder={placeholder?.command ?? "Command or path"} value={value.command} onChange={(e) => onChange({ ...value, command: e.target.value })} />
      <input className="input" style={{ flex: "1 1 160px" }} aria-label="Arguments" placeholder={placeholder?.args ?? "Arguments"} value={value.args} onChange={(e) => onChange({ ...value, args: e.target.value })} />
    </div>
  );
}

function Agents() {
  const agents = useAgents();
  const qc = useQueryClient();
  const [overrides, setOverrides] = useState(agentConfig.overrides);
  const [custom, setCustom] = useState(agentConfig.custom);
  const commit = (o: Record<string, AgentCommand>, c: CustomAgent[]) => {
    setOverrides(o);
    setCustom(c);
    agentConfig.setOverrides(o);
    agentConfig.setCustom(c);
    void qc.invalidateQueries({ queryKey: ["agents"] });
  };
  const builtin = (agents.data ?? []).filter((a) => a.id === "claude" || a.id === "gemini");
  const addCustom = () => commit(overrides, [...custom, { id: `custom-${Date.now().toString(36)}`, name: "", command: "", args: "" }]);

  return (
    <Section title="Agents" note="Commands you enter here are the only ones the app will run for an agent. Leave blank to use the detected default. Arguments are split on spaces; use quotes to keep spaces together.">
      {!isTauri() && <DesktopOnly what="Agent detection" />}
      {agents.isLoading && <Spinner label="Checking agents…" />}
      {builtin.map((a) => (
        <div key={a.id} className="card" style={{ padding: 12, display: "flex", flexDirection: "column", gap: 8 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <AgentDot ok={a.available} /> <strong>{a.name}</strong>
            <span className="muted" style={{ fontSize: 12, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{a.detail}</span>
          </div>
          <CommandFields
            value={overrides[a.id] ?? { command: "", args: "" }}
            onChange={(v) => commit({ ...overrides, [a.id]: v }, custom)}
            placeholder={{ command: a.id === "claude" ? "Override, e.g. /path/to/claude-agent-acp" : "Override, e.g. /path/to/gemini", args: a.id === "gemini" ? "--acp" : "Arguments" }}
          />
        </div>
      ))}
      <h3 style={{ fontSize: 13, margin: "8px 0 0" }}>Custom ACP agents</h3>
      {custom.map((c) => {
        const info = agents.data?.find((a) => a.id === c.id);
        const update = (patch: Partial<CustomAgent>) => commit(overrides, custom.map((x) => (x.id === c.id ? { ...x, ...patch } : x)));
        return (
          <div key={c.id} className="card" style={{ padding: 12, display: "flex", flexDirection: "column", gap: 8 }}>
            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
              {info && <AgentDot ok={info.available} />}
              <input className="input" style={{ flex: 1 }} aria-label="Agent name" placeholder="Name" value={c.name} onChange={(e) => update({ name: e.target.value })} />
              <button className="btn btn-sm" onClick={() => commit(overrides, custom.filter((x) => x.id !== c.id))}>Delete</button>
            </div>
            <CommandFields value={c} onChange={(v) => update(v)} />
            {info && !info.available && c.command && <span className="muted" style={{ fontSize: 12 }}>{info.detail}</span>}
          </div>
        );
      })}
      <div><button className="btn btn-sm" onClick={addCustom}>Add custom ACP agent</button></div>
    </Section>
  );
}

function Cache() {
  const qc = useQueryClient();
  const report = useQuery({ queryKey: ["cacheReport"], queryFn: () => invoke<CacheReport>("cache_report"), enabled: isTauri() });
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const run = async (fn: () => Promise<string>) => {
    setBusy(true);
    setError(null);
    try {
      setMsg(await fn());
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
      void qc.invalidateQueries({ queryKey: ["cacheReport"] });
    }
  };
  const cleanup = () =>
    run(async () => {
      const r = await invoke<CleanupResult>("cache_cleanup");
      return `Removed ${r.removed.length} checkout${r.removed.length === 1 ? "" : "s"}, freed ${fmtBytes(r.freed)}.${r.errors.length ? ` ${r.errors.length} failed: ${r.errors[0]}` : ""}`;
    });
  const removeRepo = (r: RepoCache) =>
    run(async () => `Removed ${r.owner}/${r.repo}, freed ${fmtBytes(await invoke<number>("cache_remove_repo", { owner: r.owner, repo: r.repo }))}.`);

  return (
    <Section title="Repository cache" note="Partial clones and checkouts the agent reads. Old per-layer checkouts and stack checkouts unused for 14 days can be cleaned up; they are re-created on demand.">
      {!isTauri() && <DesktopOnly what="The repository cache" />}
      {isTauri() && (
        <>
          {report.isLoading && <Spinner label="Measuring…" />}
          {report.error != null && <ErrorBox error={report.error} />}
          {report.data && (
            <>
              <Row label={`Total ${fmtBytes(report.data.total_size)}`} hint={report.data.path}>
                <ConfirmButton label="Clean up old checkouts" confirmLabel="Confirm clean up" disabled={busy} onConfirm={cleanup} />
              </Row>
              {report.data.repos.length === 0 && <span className="muted">Nothing cached yet.</span>}
              {report.data.repos.map((r) => (
                <div key={r.path} className="card" style={{ padding: 12 }}>
                  <Row label={`${r.owner}/${r.repo}`} hint={`${fmtBytes(r.size)} total · clone ${fmtBytes(r.clone_size)}`}>
                    <ConfirmButton label="Remove" confirmLabel="Confirm remove" disabled={busy} onConfirm={() => removeRepo(r)} />
                  </Row>
                  {r.worktrees.length > 0 && (
                    <ul style={{ margin: "8px 0 0", paddingLeft: 18, fontSize: 12 }} className="muted">
                      {r.worktrees.map((w) => (
                        <li key={w.name}>{w.name} · {fmtBytes(w.size)} · modified {ago(w.modified)}{w.legacy ? " · legacy" : ""}</li>
                      ))}
                    </ul>
                  )}
                </div>
              ))}
            </>
          )}
          {msg && <span role="status">{msg}</span>}
          {error != null && <ErrorBox error={error} />}
        </>
      )}
    </Section>
  );
}

export function Settings() {
  const { up } = useNav();
  return (
    <div style={{ height: "100%", overflow: "auto" }}>
      <header className="topbar" style={{ padding: "12px 28px", gap: 12 }}>
        <button className="btn btn-sm" onClick={() => up({ name: "home", section: "review" })}><ChevronLeft /> Inbox</button>
        <strong>Settings</strong>
        <div style={{ flex: 1 }} />
        <PaletteButton />
      </header>
      <div style={{ maxWidth: 720, padding: "24px 28px" }}>
        <General />
        <Agents />
        <Cache />
      </div>
    </div>
  );
}
