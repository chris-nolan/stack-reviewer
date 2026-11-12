import { useEffect, useMemo, useState } from "react";
import { useSession } from "../app/session";
import { useNav, type HomeSection, type RecentStack } from "../app/nav";
import { useInbox, useOrgRepos, useRepoStacks } from "../app/queries";
import { useAgents } from "../agent/useAgents";
import type { RepoRef, Stack } from "../lib/model";
import { repoKey } from "../lib/model";
import { local } from "../lib/platform";
import { progressLabel } from "../lib/stacks";
import { AgentDot, ChecksLabel, ErrorBox, LayerStrip, LogoMark, Spinner, timeAgo } from "../ui/bits";

export function Home() {
  const { route, go } = useNav();
  const { org, orgs, setOrg, viewer, signOut, source } = useSession();
  const section: HomeSection = route.name === "home" ? route.section ?? "review" : "review";
  const browsing = route.name === "home" ? route.repo : undefined;
  const [singles, setSingles] = useState(() => local.get("includeSingles", false));
  const [filter, setFilter] = useState("");
  const inbox = useInbox(singles);
  const agents = useAgents();
  const [pinned, setPinned] = useState<RepoRef[]>(() => local.get("pinnedRepos", []));
  const recent = local.get<RecentStack[]>("recent", []);

  useEffect(() => local.set("includeSingles", singles), [singles]);

  const togglePin = (r: RepoRef) => {
    const next = pinned.some((p) => repoKey(p) === repoKey(r)) ? pinned.filter((p) => repoKey(p) !== repoKey(r)) : [...pinned, r];
    setPinned(next);
    local.set("pinnedRepos", next);
  };

  const nav: { id: HomeSection; label: string; count?: number }[] = [
    { id: "review", label: "Needs my review", count: inbox.data?.needsReview.length },
    { id: "mine", label: "My stacks", count: inbox.data?.mine.length },
    { id: "recent", label: "Recent", count: recent.length || undefined },
    { id: "repo", label: "Browse repos" },
  ];

  return (
    <div style={{ height: "100%", display: "flex", flexWrap: "wrap" }}>
      <aside style={{ flex: "1 1 240px", maxWidth: 260, display: "flex", flexDirection: "column", borderRight: "1px solid var(--border)", background: "var(--chrome)", minHeight: "100%" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "16px 16px 12px", fontWeight: 600 }}>
          <LogoMark /> Stack Reviewer
          {source?.label && <span className="pill" style={{ background: "var(--agent-bg)", color: "var(--agent)" }}>{source.label}</span>}
        </div>
        <div style={{ padding: "0 12px 12px" }}>
          <label htmlFor="org" className="label" style={{ display: "block", margin: "0 4px 6px" }}>Organisation</label>
          <select id="org" className="input" style={{ padding: "6px 8px" }} value={org} onChange={(e) => setOrg(e.target.value)}>
            {orgs.map((o) => <option key={o}>{o}</option>)}
          </select>
        </div>
        <nav aria-label="Inbox" style={{ display: "flex", flexDirection: "column", gap: 2, padding: "0 8px" }}>
          {nav.map((n) => {
            const sel = n.id === section && !browsing;
            return (
              <button
                key={n.id}
                onClick={() => go({ name: "home", section: n.id })}
                aria-current={sel ? "page" : undefined}
                style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 10px", borderRadius: 8, border: 0, background: sel ? "var(--accent-soft-bg)" : "transparent", color: sel ? "var(--text)" : "var(--text-2)", fontWeight: 500, textAlign: "left" }}
              >
                <span style={{ flex: "1 1 auto" }}>{n.label}</span>
                {n.count != null && <span style={{ fontSize: 12, padding: "0 7px", borderRadius: 10, background: n.id === "review" && n.count ? "#2b3a52" : "var(--border)", color: n.id === "review" && n.count ? "var(--text)" : "var(--muted)" }}>{n.count}</span>}
              </button>
            );
          })}
        </nav>
        <div className="label" style={{ padding: "18px 16px 6px" }}>Pinned repos</div>
        <div style={{ display: "flex", flexDirection: "column", gap: 2, padding: "0 8px" }}>
          {pinned.length === 0 && <p className="muted" style={{ margin: "0 10px", fontSize: 12, lineHeight: 1.5 }}>Pin repos from Browse repos.</p>}
          {pinned.map((r) => {
            const sel = browsing && repoKey(browsing) === repoKey(r);
            return (
              <button key={repoKey(r)} onClick={() => go({ name: "home", section: "repo", repo: r })} style={{ display: "flex", justifyContent: "space-between", padding: "7px 10px", borderRadius: 8, border: 0, background: sel ? "var(--accent-soft-bg)" : "transparent", color: "var(--text-2)", textAlign: "left" }}>
                <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.repo}</span>
              </button>
            );
          })}
        </div>
        <div style={{ marginTop: "auto", padding: "14px 16px", borderTop: "1px solid var(--border)", display: "flex", flexDirection: "column", gap: 8 }}>
          <span className="label">Agents</span>
          {agents.data?.map((a) => (
            <span key={a.id} style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <AgentDot ok={a.available} /> {a.name} <span className="muted">· {a.available ? "ready" : "not installed"}</span>
            </span>
          )) ?? <span className="muted">Checking…</span>}
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 6 }}>
            {viewer?.avatarUrl ? (
              <img src={viewer.avatarUrl} alt="" width={26} height={26} style={{ borderRadius: "50%" }} />
            ) : (
              <span aria-hidden="true" style={{ width: 26, height: 26, borderRadius: "50%", background: "#2b3a52", display: "grid", placeItems: "center", fontSize: 11, fontWeight: 600 }}>{viewer?.login.slice(0, 2).toUpperCase()}</span>
            )}
            <span style={{ flex: "1 1 auto", overflow: "hidden", textOverflow: "ellipsis" }}>{viewer?.login}</span>
            <button className="btn btn-sm" onClick={signOut}>Sign out</button>
          </div>
        </div>
      </aside>

      <main style={{ flex: "999 1 640px", minWidth: 0, display: "flex", flexDirection: "column", height: "100%" }}>
        <header className="topbar" style={{ padding: "12px 28px" }}>
          <label htmlFor="filter" className="sr-only">Filter stacks</label>
          <input id="filter" className="input" style={{ maxWidth: 480 }} placeholder="Filter by title, repo, author or PR number" value={filter} onChange={(e) => setFilter(e.target.value)} />
          <div className="spacer" />
          <label style={{ display: "flex", gap: 6, alignItems: "center", color: "var(--text-2)" }}>
            <input type="checkbox" checked={singles} onChange={(e) => setSingles(e.target.checked)} style={{ accentColor: "var(--accent)" }} />
            Include single PRs
          </label>
          <span className="muted">{inbox.isFetching ? "Syncing…" : inbox.dataUpdatedAt ? `Synced ${timeAgo(new Date(inbox.dataUpdatedAt).toISOString())}` : ""}</span>
          <button className="btn btn-sm" onClick={() => inbox.refetch()}>Refresh</button>
        </header>
        <div className="scroll" style={{ flex: "1 1 auto" }}>
          <div style={{ padding: "24px 28px 40px", display: "flex", flexDirection: "column", gap: 18, maxWidth: 1120 }}>
            {browsing ? (
              <RepoStacks repo={browsing} singles={singles} filter={filter} pinned={pinned.some((p) => repoKey(p) === repoKey(browsing))} onPin={() => togglePin(browsing)} />
            ) : section === "repo" ? (
              <RepoBrowser pinned={pinned} onPin={togglePin} />
            ) : section === "recent" ? (
              <RecentList items={recent} />
            ) : (
              <InboxList section={section} filter={filter} inbox={inbox} />
            )}
          </div>
        </div>
      </main>
    </div>
  );
}

function matches(s: Stack, f: string) {
  if (!f) return true;
  const q = f.toLowerCase().replace(/^#/, "");
  return [s.title, s.repo.repo, s.author, ...s.layers.map((l) => `${l.pr.number} ${l.pr.title}`)].some((x) => x.toLowerCase().includes(q));
}

function InboxList({ section, filter, inbox }: { section: HomeSection; filter: string; inbox: ReturnType<typeof useInbox> }) {
  const { org } = useSession();
  if (inbox.isPending) return <Spinner label={`Finding stacks in ${org}…`} />;
  if (inbox.error) return <ErrorBox error={inbox.error} />;
  const list = (section === "mine" ? inbox.data.mine : inbox.data.needsReview).filter((s) => matches(s, filter));
  const all = inbox.data.needsReview;
  const failing = all.filter((s) => s.checks === "fail").length;
  const stale = all.flatMap((s) => s.layers.filter((l) => l.mine === "stale")).length;
  return (
    <>
      {section === "review" && (failing > 0 || stale > 0) && (
        <section aria-label="Attention" style={{ display: "flex", flexWrap: "wrap", gap: 10 }}>
          {failing > 0 && <span className="pill" style={{ padding: "8px 12px", borderRadius: 10, border: "1px solid var(--bad-bd)", background: "var(--bad-bg)", color: "var(--text)" }}><span style={{ color: "var(--bad)" }} aria-hidden="true">✕</span> {failing} {failing === 1 ? "stack has" : "stacks have"} failing checks</span>}
          {stale > 0 && <span className="pill" style={{ padding: "8px 12px", borderRadius: 10, border: "1px solid var(--warn-bd)", background: "var(--warn-bg)", color: "var(--text)" }}><span style={{ color: "var(--warn)" }} aria-hidden="true">!</span> {stale} {stale === 1 ? "layer has" : "layers have"} new commits since you reviewed</span>}
        </section>
      )}
      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "baseline", gap: 12 }}>
        <h1 style={{ margin: 0, fontSize: 22, fontWeight: 600 }}>{section === "mine" ? "My stacks" : "Needs your review"}</h1>
        <span className="muted">{list.length} {list.length === 1 ? "stack" : "stacks"} in {org}</span>
      </div>
      {list.length === 0 ? (
        <p className="muted" style={{ lineHeight: 1.6 }}>
          {section === "mine" ? "You have no open stacks here." : "Nothing is waiting on you. Browse repos to look at other stacks."}
        </p>
      ) : (
        <StackList stacks={list} />
      )}
      <p className="muted" style={{ fontSize: 12 }}>Layers: ✓ reviewed · ● your turn · ! new commits since your review · ✕ changes requested · … waiting for reviewers (your PRs) · ⇡ merged · blank: not reviewed</p>
    </>
  );
}

export function StackList({ stacks }: { stacks: Stack[] }) {
  const { go } = useNav();
  const { viewer } = useSession();
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      {stacks.map((s) => {
        return (
          <button
            key={`${repoKey(s.repo)}#${s.key}`}
            onClick={() => go({ name: "overview", repo: s.repo, stackKey: s.key })}
            className="card"
            style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 18, padding: "14px 16px", textAlign: "left", color: "inherit" }}
          >
            <span style={{ flex: "1 1 320px", minWidth: 0, display: "flex", flexDirection: "column", gap: 4 }}>
              <span className="muted" style={{ fontSize: 12 }}>{repoKey(s.repo)}{s.source === "inferred" ? " · inferred from branches" : ""}</span>
              <span style={{ fontSize: 15, fontWeight: 600 }}>{s.title}</span>
              <span className="muted" style={{ fontSize: 12 }}>{s.author} · {s.layers.length} {s.layers.length === 1 ? "layer" : "layers"} · updated {timeAgo(s.updatedAt)}</span>
            </span>
            <span style={{ flex: "0 1 240px", display: "flex", flexDirection: "column", gap: 6, minWidth: 120 }}>
              <LayerStrip layers={s.layers} />
              <span className="muted" style={{ fontSize: 12 }}>{progressLabel(s, viewer?.login ?? "")}</span>
            </span>
            <span style={{ flex: "0 0 150px", fontSize: 12 }}>
              <ChecksLabel state={s.checks} />
            </span>
            <span aria-hidden="true" className="muted">›</span>
          </button>
        );
      })}
    </div>
  );
}

function RepoBrowser({ pinned, onPin }: { pinned: RepoRef[]; onPin: (r: RepoRef) => void }) {
  const { go } = useNav();
  const [q, setQ] = useState("");
  const [debounced, setDebounced] = useState("");
  useEffect(() => {
    const t = setTimeout(() => setDebounced(q), 300);
    return () => clearTimeout(t);
  }, [q]);
  const repos = useOrgRepos(debounced);
  const pinnedKeys = useMemo(() => new Set(pinned.map(repoKey)), [pinned]);
  return (
    <>
      <h1 style={{ margin: 0, fontSize: 22, fontWeight: 600 }}>Browse repos</h1>
      <label htmlFor="repoq" className="sr-only">Search repos</label>
      <input id="repoq" className="input" style={{ maxWidth: 480 }} placeholder="Search repos by name" value={q} onChange={(e) => setQ(e.target.value)} autoFocus />
      {repos.isPending ? <Spinner /> : repos.error ? <ErrorBox error={repos.error} /> : (
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          {repos.data.map(({ repo, pushedAt }) => (
            <div key={repoKey(repo)} className="card" style={{ display: "flex", alignItems: "center", gap: 12, padding: "10px 14px" }}>
              <button onClick={() => go({ name: "home", section: "repo", repo })} style={{ flex: "1 1 auto", textAlign: "left", border: 0, background: "transparent", padding: 0 }}>
                <span style={{ fontWeight: 600 }}>{repo.repo}</span> <span className="muted">· pushed {timeAgo(pushedAt)}</span>
              </button>
              <button className="btn btn-sm" onClick={() => onPin(repo)}>{pinnedKeys.has(repoKey(repo)) ? "Unpin" : "Pin"}</button>
            </div>
          ))}
        </div>
      )}
    </>
  );
}

function RepoStacks({ repo, singles, filter, pinned, onPin }: { repo: RepoRef; singles: boolean; filter: string; pinned: boolean; onPin: () => void }) {
  const stacks = useRepoStacks(repo, singles);
  return (
    <>
      <div style={{ display: "flex", alignItems: "baseline", gap: 12, flexWrap: "wrap" }}>
        <h1 style={{ margin: 0, fontSize: 22, fontWeight: 600 }}>{repo.repo}</h1>
        <span className="muted">{repoKey(repo)}</span>
        <div className="spacer" />
        <button className="btn btn-sm" onClick={onPin}>{pinned ? "Unpin" : "Pin repo"}</button>
      </div>
      {stacks.isPending ? <Spinner /> : stacks.error ? <ErrorBox error={stacks.error} /> : stacks.data.length === 0 ? (
        <p className="muted">No open stacks{singles ? " or PRs" : ""} in this repo.</p>
      ) : (
        <StackList stacks={stacks.data.filter((s) => matches(s, filter))} />
      )}
    </>
  );
}

function RecentList({ items }: { items: RecentStack[] }) {
  const { go } = useNav();
  return (
    <>
      <h1 style={{ margin: 0, fontSize: 22, fontWeight: 600 }}>Recently viewed</h1>
      {items.length === 0 ? <p className="muted">Stacks you open will show up here.</p> : (
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          {items.map((r) => (
            <button key={`${repoKey(r.repo)}#${r.stackKey}`} className="card" onClick={() => go({ name: "review", repo: r.repo, stackKey: r.stackKey, layer: r.layer })} style={{ display: "flex", flexDirection: "column", gap: 4, padding: "12px 14px", textAlign: "left" }}>
              <span className="muted" style={{ fontSize: 12 }}>{repoKey(r.repo)}</span>
              <span style={{ fontWeight: 600 }}>{r.title}</span>
              <span className="muted" style={{ fontSize: 12 }}>Last at layer {r.layer} · {timeAgo(r.at)}</span>
            </button>
          ))}
        </div>
      )}
    </>
  );
}
