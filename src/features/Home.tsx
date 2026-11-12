import { useEffect, useMemo, useState } from "react";
import { PaletteButton } from "../app/Palette";
import { useQueries } from "@tanstack/react-query";
import { useSession, useSource } from "../app/session";
import { useNav, type HomeSection, type RecentStack } from "../app/nav";
import { useInbox, useOrgRepos, useRepoStacks } from "../app/queries";
import { useAgents } from "../agent/useAgents";
import type { RepoRef, Stack } from "../lib/model";
import type { Inbox } from "../lib/source";
import { repoKey } from "../lib/model";
import { local, openUrl } from "../lib/platform";
import { GitHubError } from "../lib/github";
import { scoped } from "../lib/scope";
import { pinId, pinStore, seenStore, usePinnedStacks, useSeen, type PinnedStack } from "../lib/homeStore";
import { diffSince, markAllSeen, needsMyReview, stackId, type Change } from "../lib/sinceLast";
import { progressLabel } from "../lib/stacks";
import { AccountMenu } from "../ui/AccountMenu";
import { AgentDot, ChecksLabel, ErrorBox, LayerStrip, LogoMark, Spinner, timeAgo } from "../ui/bits";

export function Home() {
  const { route, go } = useNav();
  const { org, orgs, setOrg, source } = useSession();
  const section: HomeSection = route.name === "home" ? route.section ?? "review" : "review";
  const browsing = route.name === "home" ? route.repo : undefined;
  const [singles, setSingles] = useState(() => local.get("includeSingles", false));
  const [filter, setFilter] = useState("");
  const inbox = useInbox(singles);
  const agents = useAgents();
  const [pinned, setPinned] = useState<RepoRef[]>(() => scoped.get<RepoRef[]>("pinnedRepos", []));
  const recent = scoped.get<RecentStack[]>("recent", []);

  useEffect(() => local.set("includeSingles", singles), [singles]);

  // First run for this data source/viewer: everything currently in the inbox counts as already seen.
  useEffect(() => {
    if (!inbox.data || seenStore.initialised()) return;
    const all = [...inbox.data.needsReview, ...inbox.data.mine];
    seenStore.replace(markAllSeen(seenStore.get(), all, new Set(inbox.data.needsReview.map(stackId))));
    seenStore.setInitialised();
  }, [inbox.data]);

  const togglePin = (r: RepoRef) => {
    const next = pinned.some((p) => repoKey(p) === repoKey(r)) ? pinned.filter((p) => repoKey(p) !== repoKey(r)) : [...pinned, r];
    setPinned(next);
    scoped.set("pinnedRepos", next);
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
        <PinnedStacks />
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
            <AccountMenu />
            <button className="btn btn-sm btn-icon" aria-label="Settings" title="Settings" onClick={() => go({ name: "settings" })}>⚙</button>
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
          <PaletteButton />
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

/** Shown instead of a silently empty inbox when the token can't see an org (SAML SSO not authorised). */
function AccessNotice({ error }: { error?: unknown }) {
  const source = useSource();
  const { current } = useSession();
  const issue = source.accessIssue?.() ?? (error instanceof GitHubError && error.ssoUrl ? { kind: "sso" as const, message: error.message, url: error.ssoUrl } : null);
  if (!issue) return null;
  return (
    <div className="error-box" role="alert" style={{ display: "flex", flexDirection: "column", gap: 8, lineHeight: 1.5 }}>
      <strong>Some of this organisation's data is hidden from {current ? `${current}'s` : "this"} token</strong>
      <span>The organisation requires single sign-on, and this token hasn't been authorised for it, so stacks there won't appear. Authorise the token for SSO on GitHub, or switch to an account that has access.</span>
      {issue.url && <div><button className="btn btn-sm" onClick={() => openUrl(issue.url!)}>Authorise on GitHub</button></div>}
    </div>
  );
}

function InboxList({ section, filter, inbox }: { section: HomeSection; filter: string; inbox: ReturnType<typeof useInbox> }) {
  const { org } = useSession();
  if (inbox.isPending) return <Spinner label={`Finding stacks in ${org}…`} />;
  if (inbox.error) return <><AccessNotice error={inbox.error} /><ErrorBox error={inbox.error} /></>;
  const list = (section === "mine" ? inbox.data.mine : inbox.data.needsReview).filter((s) => matches(s, filter));
  return (
    <>
      <AccessNotice />
      {section === "review" && <SinceStrip inbox={inbox.data} />}
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

function describe(c: Change): { glyph: string; color: string; bd: string; bg: string; text: string } {
  const n = (c.kind === "new" ? 0 : c.layers.length);
  const layers = c.kind === "new" ? "" : c.layers.length > 3 ? `${n} layers` : `layer${n === 1 ? "" : "s"} ${c.layers.join(", ")}`;
  if (c.kind === "new") return { glyph: "●", color: "var(--accent)", bd: "var(--accent-soft-bd)", bg: "var(--accent-soft-bg)", text: `New to review: ${c.stack.title}` };
  if (c.kind === "commits") return { glyph: "!", color: "var(--warn)", bd: "var(--warn-bd)", bg: "var(--warn-bg)", text: `New commits on ${layers}: ${c.stack.title}` };
  return { glyph: "✕", color: "var(--bad)", bd: "var(--bad-bd)", bg: "var(--bad-bg)", text: `Checks now failing on ${layers}: ${c.stack.title}` };
}

function SinceStrip({ inbox }: { inbox: Inbox }) {
  const { go } = useNav();
  const seen = useSeen();
  const all = useMemo(() => {
    const byId = new Map<string, Stack>();
    for (const s of [...inbox.needsReview, ...inbox.mine]) byId.set(stackId(s), s);
    return [...byId.values()];
  }, [inbox]);
  const needs = useMemo(() => new Set(inbox.needsReview.map(stackId)), [inbox]);
  const changes = useMemo(() => diffSince(seen, all, needs), [seen, all, needs]);
  if (!changes.length) return null;
  return (
    <section aria-label="Since you last looked" style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <span className="label">Since you last looked · {changes.length}</span>
        <div className="spacer" />
        <button className="btn btn-sm" onClick={() => seenStore.replace(markAllSeen(seen, all, needs))}>Mark all seen</button>
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
        {changes.map((c) => {
          const d = describe(c);
          return (
            <button key={`${c.kind}:${c.id}`} onClick={() => go({ name: "overview", repo: c.stack.repo, stackKey: c.stack.key })} className="pill" style={{ padding: "8px 12px", borderRadius: 10, border: `1px solid ${d.bd}`, background: d.bg, color: "var(--text)", maxWidth: "100%" }}>
              <span style={{ color: d.color }} aria-hidden="true">{d.glyph}</span>
              <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{d.text}</span>
              <span className="muted">· {c.stack.repo.repo}</span>
            </button>
          );
        })}
      </div>
    </section>
  );
}

function PinnedStacks() {
  const { go } = useNav();
  const source = useSource();
  const pins = usePinnedStacks();
  const qs = useQueries({
    queries: pins.map((p) => ({
      queryKey: ["stack", source.kind, repoKey(p.repo), p.stackKey],
      queryFn: () => source.stack(p.repo, p.stackKey),
      refetchInterval: 60_000,
      retry: false,
    })),
  });
  return (
    <>
      <div className="label" style={{ padding: "18px 16px 6px" }}>Pinned</div>
      <div style={{ display: "flex", flexDirection: "column", gap: 2, padding: "0 8px" }}>
        {pins.length === 0 && <p className="muted" style={{ margin: "0 10px", fontSize: 12, lineHeight: 1.5 }}>Pin a stack from its overview.</p>}
        {pins.map((p: PinnedStack, i) => {
          const q = qs[i];
          const st = q?.data;
          const gone = !!q && !q.isPending && !st;
          const needs = st ? needsMyReview(st) : false;
          return (
            <div key={pinId(p)} style={{ display: "flex", alignItems: "center", borderRadius: 8 }}>
              <button
                onClick={() => go({ name: "overview", repo: p.repo, stackKey: p.stackKey })}
                title={gone ? `${repoKey(p.repo)} · no longer open (or unavailable)` : `${repoKey(p.repo)} · ${p.title}`}
                style={{ flex: "1 1 auto", minWidth: 0, display: "flex", alignItems: "center", gap: 6, padding: "7px 10px", border: 0, borderRadius: 8, background: "transparent", color: gone ? "var(--muted)" : "var(--text-2)", textAlign: "left", fontStyle: gone ? "italic" : undefined }}
              >
                <span style={{ flex: "1 1 auto", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{st?.title ?? p.title}</span>
                {gone && <span style={{ fontSize: 11 }}>closed</span>}
                {st?.checks === "fail" && <span style={{ color: "var(--bad)" }} title="Checks failing" aria-label="Checks failing">✕</span>}
                {needs && <span style={{ color: "var(--accent)" }} title="Needs your review" aria-label="Needs your review">●</span>}
              </button>
              <button aria-label={`Unpin ${p.title}`} title="Unpin" onClick={() => pinStore.toggle(p)} style={{ border: 0, background: "transparent", color: "var(--muted)", padding: "4px 8px" }}>×</button>
            </div>
          );
        })}
      </div>
    </>
  );
}
