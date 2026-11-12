import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { rememberRecent, useNav } from "../../app/nav";
import { useChecks, useFiles, useSetViewed, useStack, useThreads } from "../../app/queries";
import { useSession, useSource } from "../../app/session";
import { AgentDock } from "../../agent/AgentDock";
import { reviewBridge, type FindingInput } from "../../agent/bridge";
import { changeStarts, commentableLines, parsePatch } from "../../lib/diff";
import { failureExcerpt } from "../../lib/logs";
import { plainText, splitConventional, stripStackBoilerplate, summarize } from "../../lib/markdown";
import type { CheckRun, FileChange, Layer, RepoRef, ReviewEvent, Stack } from "../../lib/model";
import { repoKey } from "../../lib/model";
import { local } from "../../lib/platform";
import { prKey, reviewStore, useReviewState } from "../../lib/reviewStore";
import { checkRunState, ChevronLeft, ErrorBox, LAYER_STYLE, LayerRing, Spinner } from "../../ui/bits";
import { ChecksDialog, FinishDialog } from "./Dialogs";
import { DiffView } from "./DiffView";
import { Margin } from "./Margin";

type Props = { repo: RepoRef; stackKey: string; layer: number; file?: string; line?: number };

export function Review(p: Props) {
  const stack = useStack(p.repo, p.stackKey);
  const { go } = useNav();
  if (stack.isPending) return <div className="empty"><Spinner label="Loading stack…" /></div>;
  if (stack.error) return (
    <div style={{ padding: 24, display: "flex", flexDirection: "column", gap: 12, alignItems: "flex-start" }}>
      <ErrorBox error={stack.error} />
      <button className="btn" onClick={() => go({ name: "home" })}>Back to inbox</button>
    </div>
  );
  const idx = Math.min(Math.max(1, p.layer), stack.data.layers.length);
  return <ReviewBody key={`${p.stackKey}:${idx}`} {...p} stack={stack.data} layer={stack.data.layers[idx - 1]} />;
}

const isTestish = (p: string) => /(^|\/)(test|tests|__tests__|spec)\/|\.(test|spec)\.[a-z]+$|_test\.(go|py|rs)$/i.test(p);
const isDocish = (p: string) => /\.(md|mdx|txt|rst)$|(^|\/)docs?\//i.test(p);

function useWindowWidth(): number {
  const [w, setW] = useState(() => window.innerWidth);
  useEffect(() => {
    const on = () => setW(window.innerWidth);
    window.addEventListener("resize", on);
    return () => window.removeEventListener("resize", on);
  }, []);
  return w;
}

function readingOrder(files: FileChange[], preferred?: string[]): FileChange[] {
  const byPath = new Map(files.map((f) => [f.path, f]));
  const first = (preferred ?? []).map((p) => byPath.get(p)).filter((f): f is FileChange => !!f);
  const rest = files.filter((f) => !first.includes(f));
  const rank = (f: FileChange) => (isDocish(f.path) ? 2 : isTestish(f.path) ? 1 : 0);
  return [...first, ...rest.sort((a, b) => rank(a) - rank(b))];
}

function ReviewBody({ repo, stack, layer, file: initialFile, line: initialLine }: Omit<Props, "layer"> & { stack: Stack; layer: Layer }) {
  const source = useSource();
  const { viewer } = useSession();
  const { go } = useNav();
  const qc = useQueryClient();
  const key = prKey(repo, layer.pr.number);
  const review = useReviewState(key);
  const me = viewer?.login ?? "";
  const myReview = layer.pr.latestReviews.find((r) => r.author.toLowerCase() === me.toLowerCase());
  const canSince = layer.mine === "stale" && !!myReview?.commit;

  const [mode, setMode] = useState<"layer" | "since">("layer");
  const [layout, setLayout] = useState<"unified" | "split">(() => local.get("layout", "unified"));
  const [railPref, setRailOpen] = useState(() => local.get("railOpen", true));
  const width = useWindowWidth();
  const [dockOpen, setDockOpen] = useState(() => local.get("dockOpen", true));
  // On narrow windows the agent panel and the full sidebar don't both fit beside a diff.
  const [railForced, setRailForced] = useState(false);
  const railOpen = railPref && (railForced || !(dockOpen && width < 1280));
  const [briefOpen, setBriefOpen] = useState(() => local.get("briefOpen", true));
  const [finishOpen, setFinishOpen] = useState(false);
  const [checksOpen, setChecksOpen] = useState<number | null | false>(false);
  const [path, setPath] = useState<string | null>(initialFile ?? null);
  const [focusLine, setFocusLine] = useState<number | null>(initialLine ?? null);
  const [composerLine, setComposerLine] = useState<number | null>(null);

  useEffect(() => local.set("layout", layout), [layout]);
  useEffect(() => local.set("railOpen", railPref), [railPref]);
  useEffect(() => local.set("dockOpen", dockOpen), [dockOpen]);
  useEffect(() => local.set("briefOpen", briefOpen), [briefOpen]);
  useEffect(() => rememberRecent({ repo, stackKey: stack.key, title: stack.title, layer: layer.index, at: new Date().toISOString() }), [repo, stack.key, stack.title, layer.index]);

  const filesQ = useFiles(repo, layer.pr);
  const sinceQ = useQuery({
    queryKey: ["compare", source.kind, repoKey(repo), myReview?.commit, layer.pr.headSha],
    queryFn: () => source.compare(repo, myReview!.commit!, layer.pr.headSha),
    enabled: mode === "since" && canSince,
    staleTime: Infinity,
  });
  const threadsQ = useThreads(repo, layer.pr.number);
  const checksQ = useChecks(repo, layer.pr.headSha);
  const setViewed = useSetViewed(repo, layer.pr);

  const layerFiles = filesQ.data ?? [];
  const shownFiles = mode === "since" ? sinceQ.data ?? [] : layerFiles;
  const ordered = useMemo(() => readingOrder(shownFiles, review.brief?.readingOrder), [shownFiles, review.brief?.readingOrder]);
  const viewedByPath = useMemo(() => new Map(layerFiles.map((f) => [f.path, f.viewed])), [layerFiles]);
  const current = ordered.find((f) => f.path === path) ?? ordered.find((f) => !viewedByPath.get(f.path)) ?? ordered[0] ?? null;
  const currentIdx = current ? ordered.indexOf(current) : -1;
  const viewedCount = layerFiles.filter((f) => f.viewed).length;

  const findingsHere = review.findings.filter((f) => f.path === current?.path);
  const threadsHere = (threadsQ.data ?? []).filter((t) => t.path === current?.path);
  const draftsHere = review.drafts.filter((d) => d.path === current?.path);
  const openFindings = review.findings.filter((f) => f.status === "open");
  const notesHere = findingsHere.length + threadsHere.length + draftsHere.filter((d) => d.source === "me").length;
  const [marginPinned, setMarginPinned] = useState(() => local.get("marginPinned", false));
  useEffect(() => local.set("marginPinned", marginPinned), [marginPinned]);
  const showMargin = notesHere > 0 || marginPinned || composerLine != null;
  const failingChecks = (checksQ.data ?? []).filter((c) => checkRunState(c) === "fail");
  const prev = stack.layers[layer.index - 2] ?? null;
  const next = stack.layers[layer.index] ?? null;

  const selectFile = useCallback((p: string, line: number | null = null) => {
    setPath(p);
    setFocusLine(line);
    setComposerLine(null);
  }, []);

  const goLayer = (l: Layer | null) => l && go({ name: "review", repo, stackKey: stack.key, layer: l.index });

  const markViewedAndNext = () => {
    if (!current) return;
    if (mode === "layer" && !current.viewed) setViewed.mutate({ path: current.path, viewed: true });
    const after = ordered.slice(currentIdx + 1);
    const target = after.find((f) => !viewedByPath.get(f.path)) ?? after[0];
    if (target) selectFile(target.path);
    else setFinishOpen(true);
  };

  const nextFinding = () => {
    const sorted = [...openFindings].sort((a, b) => ordered.findIndex((f) => f.path === a.path) - ordered.findIndex((f) => f.path === b.path) || a.line - b.line);
    const f = sorted.find((x) => x.path === current?.path && x.line > (focusLine ?? 0)) ?? sorted[0];
    if (f) selectFile(f.path, f.line);
  };

  // Expose this review to agent tools.
  const live = useRef({ stack, layer, layerFiles, threads: threadsQ.data ?? [], checks: checksQ.data ?? [], findings: review.findings });
  live.current = { stack, layer, layerFiles, threads: threadsQ.data ?? [], checks: checksQ.data ?? [], findings: review.findings };
  useEffect(() => {
    reviewBridge.set({
      context: () => {
        const { stack, layer, layerFiles, threads, checks, findings } = live.current;
        return {
          repository: repoKey(stack.repo),
          stack: {
            title: stack.title, kind: stack.source, base_branch: stack.baseRef,
            layers: stack.layers.map((l) => ({ index: l.index, pr: l.pr.number, title: l.pr.title, author: l.pr.author, state: l.pr.state, head_branch: l.pr.headRef, base_branch: l.pr.baseRef, checks: l.pr.checks })),
          },
          layer_under_review: {
            index: layer.index, pr: layer.pr.number, title: layer.pr.title, author: layer.pr.author, url: layer.pr.url,
            description: layer.pr.body.slice(0, 4000), base_sha: layer.pr.baseSha, head_sha: layer.pr.headSha,
            diff_command: layer.pr.baseSha ? `git diff ${layer.pr.baseSha}...HEAD` : `git diff refs/sr/base/${layer.pr.number}...HEAD`,
            files: layerFiles.map((f) => ({ path: f.path, status: f.status, additions: f.additions, deletions: f.deletions })),
          },
          open_review_threads: threads.filter((t) => !t.isResolved).map((t) => ({ path: t.path, line: t.line, comments: t.comments.map((c) => `${c.author}: ${c.body}`) })),
          checks: checks.map((c) => ({ name: c.name, state: checkRunState(c) })),
          findings_already_recorded: findings.filter((f) => f.status !== "dismissed").map((f) => ({ path: f.path, line: f.line, title: f.title })),
        };
      },
      addFinding: (f: FindingInput, agent: string) => {
        const { stack, layer, layerFiles } = live.current;
        const target = f.pr ? stack.layers.find((l) => l.pr.number === f.pr) : layer;
        if (!target) return { ok: false, error: `PR #${f.pr} is not part of this stack.` };
        const severity = (["High", "Medium", "Low"] as const).includes(f.severity) ? f.severity : "Medium";
        if (target === layer) {
          const file = layerFiles.find((x) => x.path === f.path);
          if (!file) return { ok: false, error: `${f.path} is not changed in #${layer.pr.number}. Changed files: ${layerFiles.map((x) => x.path).join(", ")}` };
          const lines = commentableLines(parsePatch(file.patch));
          if (!lines.has(Number(f.line))) {
            const ranges = [...lines].sort((a, b) => a - b).reduce<string[]>((acc, n, i, arr) => {
              if (i === 0 || n !== arr[i - 1] + 1) acc.push(String(n));
              else acc[acc.length - 1] = `${acc[acc.length - 1].split("-")[0]}-${n}`;
              return acc;
            }, []);
            return { ok: false, error: `Line ${f.line} of ${f.path} is not in the diff. Use one of: ${ranges.join(", ") || "(no commentable lines)"}` };
          }
        }
        const created = reviewStore.addFinding(prKey(stack.repo, target.pr.number), {
          pr: target.pr.number, path: f.path, line: Number(f.line), severity, title: String(f.title).slice(0, 140), body: String(f.body ?? ""),
          suggestion: f.suggestion || undefined, agent,
        });
        return { ok: true, id: created.id.slice(0, 8) };
      },
      setBrief: (summary, order) => reviewStore.setBrief(key, { summary, readingOrder: order, agent: "agent" }),
      setSummary: (text) => reviewStore.setSummary(key, text),
      checkFailures: async (pr) => {
        const { stack, layer } = live.current;
        const target = pr ? stack.layers.find((l) => l.pr.number === pr) ?? layer : layer;
        const checks: CheckRun[] = await source.checks(stack.repo, target.pr.headSha);
        const failing = checks.filter((c) => checkRunState(c) === "fail");
        if (!failing.length) return `No failing checks on #${target.pr.number}.`;
        const parts = await Promise.all(failing.slice(0, 4).map(async (c) => {
          if (!c.isActions) return `## ${c.name}\n(not a GitHub Actions job; no log available)`;
          try {
            const ex = failureExcerpt(await source.jobLog(stack.repo, c.id), 80);
            return `## ${c.name}\n${ex.lines.join("\n")}`;
          } catch (e) {
            return `## ${c.name}\n(log unavailable: ${e instanceof Error ? e.message : e})`;
          }
        }));
        return `Failing checks on #${target.pr.number}:\n\n${parts.join("\n\n")}`;
      },
    });
    return () => reviewBridge.set(null);
  }, [key, source]);

  // Keyboard shortcuts.
  const keys = useRef<(e: KeyboardEvent) => void>(() => {});
  keys.current = (e: KeyboardEvent) => {
    const t = e.target as HTMLElement;
    if (e.metaKey || e.ctrlKey || e.altKey || finishOpen || checksOpen !== false) return;
    if (t.closest("input, textarea, select, [contenteditable=true]")) return;
    const k = e.key;
    if (k === "j") markViewedAndNext();
    else if (k === "k" && currentIdx > 0) selectFile(ordered[currentIdx - 1].path);
    else if (k === "v" && current && mode === "layer") setViewed.mutate({ path: current.path, viewed: !current.viewed });
    else if (k === "a") setDockOpen((o) => !o);
    else if (k === "]") goLayer(next);
    else if (k === "[") goLayer(prev);
    else if (k === "c" && focusLine != null) setComposerLine(focusLine);
    else if (k === "f") setFinishOpen(true);
    else if (k === "n" || k === "p") {
      if (!current) return;
      const starts = changeStarts(parsePatch(current.patch));
      const cur = focusLine ?? 0;
      const target = k === "n" ? starts.find((n) => n > cur) ?? starts[0] : [...starts].reverse().find((n) => n < cur) ?? starts[starts.length - 1];
      if (target != null) setFocusLine(target);
    } else if (k === "Escape") setComposerLine(null);
    else return;
    e.preventDefault();
  };
  useEffect(() => {
    const h = (e: KeyboardEvent) => keys.current(e);
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, []);

  const submit = async (event: ReviewEvent, body: string) => {
    const byPath = new Map(layerFiles.map((f) => [f.path, commentableLines(parsePatch(f.patch))]));
    const valid = review.drafts.filter((d) => byPath.get(d.path)?.has(d.line));
    const orphan = review.drafts.filter((d) => !valid.includes(d));
    const fullBody = [body, ...orphan.map((d) => `**${d.path}:${d.line}**\n${d.body}`)].filter(Boolean).join("\n\n---\n\n");
    await source.submitReview(repo, layer.pr.number, { event, body: fullBody, commitId: layer.pr.headSha, comments: valid.map((d) => ({ path: d.path, line: d.line, body: d.body })) });
    reviewStore.clearDrafts(key);
    reviewStore.setSummary(key, "");
    await qc.invalidateQueries({ queryKey: ["stack"] });
    await qc.invalidateQueries({ queryKey: ["inbox"] });
    setFinishOpen(false);
    if (next) goLayer(next);
    else go({ name: "overview", repo, stackKey: stack.key });
  };

  const summaryText = review.brief?.summary ?? summarize(layer.pr.body, 600);
  const fullBody = useMemo(() => plainText(stripStackBoilerplate(layer.pr.body)).replace(/\n{3,}/g, "\n\n").trim(), [layer.pr.body]);
  const [showBody, setShowBody] = useState(false);
  const manyLayers = stack.layers.length > 8;
  const railLayersRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    railLayersRef.current?.querySelector("[data-current]")?.scrollIntoView({ block: "nearest" });
  }, [railOpen, layer.index]);
  const titleParts = splitConventional(layer.pr.title);

  return (
    <div className="app">
      <header className="topbar">
        <button className="btn" onClick={() => go({ name: "overview", repo, stackKey: stack.key })}><ChevronLeft /> Overview</button>
        <nav aria-label="Breadcrumb" className="crumbs"><span>{repo.repo}</span><span aria-hidden="true">›</span><span>{stack.title}</span><span aria-hidden="true">›</span><span className="here">#{layer.pr.number}</span></nav>
        <div className="spacer" />
        <button className="btn btn-soft" onClick={() => setFinishOpen(true)}>Pending review · {review.drafts.length} {review.drafts.length === 1 ? "draft" : "drafts"}</button>
        <button className={dockOpen ? "btn btn-agent" : "btn"} aria-pressed={dockOpen} onClick={() => setDockOpen((o) => !o)}>
          <span className="dot" style={{ background: "var(--ok)" }} aria-hidden="true" /> Agent <span className="kbd">a</span>
        </button>
      </header>

      <div style={{ flex: "1 1 auto", display: "flex", minHeight: 0 }}>
        {railOpen ? (
          <aside aria-label="Stack and files" style={{ flex: "0 0 256px", width: 256, minWidth: 0, overflow: "hidden", borderRight: "1px solid var(--border)", background: "var(--chrome)", display: "flex", flexDirection: "column", minHeight: 0 }}>
            <div style={{ display: "flex", alignItems: "center", padding: "12px 12px 6px 14px" }}>
              <span className="label" style={{ flex: "1 1 auto" }}>Stack · layer {layer.index} of {stack.layers.length}</span>
              <button className="btn btn-icon" onClick={() => { setRailOpen(false); setRailForced(false); }} aria-label="Collapse sidebar">‹</button>
            </div>
            <div ref={railLayersRef} className="scroll" style={{ flex: "0 1 auto", maxHeight: manyLayers ? "38%" : undefined, display: "flex", flexDirection: "column", gap: manyLayers ? 0 : 2, padding: "0 8px 8px" }}>
              <div className="mono faint" style={{ padding: "0 0 4px 14px", fontSize: 12 }}>{stack.baseRef}</div>
              {stack.layers.map((l) => {
                const sel = l === layer;
                const s = LAYER_STYLE[l.mine];
                const t = splitConventional(l.pr.title);
                return (
                  <button
                    key={l.pr.number}
                    data-current={sel || undefined}
                    onClick={() => goLayer(l)}
                    aria-current={sel ? "true" : undefined}
                    title={`#${l.pr.number} ${l.pr.title} — ${s.word}`}
                    style={{ display: "flex", gap: manyLayers ? 8 : 10, alignItems: "center", textAlign: "left", padding: manyLayers ? "4px 6px" : "7px 8px", borderRadius: 8, border: `1px solid ${sel ? "var(--accent-soft-bd)" : "transparent"}`, background: sel ? "var(--accent-soft-bg)" : "transparent", flex: "0 0 auto" }}
                  >
                    <LayerRing layer={l} size={manyLayers ? 20 : 22} />
                    {manyLayers ? (
                      <span style={{ minWidth: 0, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", fontWeight: sel ? 600 : 400, color: sel ? "var(--text)" : "var(--text-2)" }}>{t.text}</span>
                    ) : (
                      <span style={{ display: "flex", flexDirection: "column", minWidth: 0 }}>
                        <span style={{ fontWeight: 500, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{t.text}</span>
                        <span style={{ fontSize: 12, color: s.fg }}>#{l.pr.number} · {s.word}</span>
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
            <div style={{ borderTop: "1px solid var(--border)", padding: "12px 14px 6px", display: "flex", justifyContent: "space-between" }}>
              <span className="label">Files · reading order</span>
              <span className="muted" style={{ fontSize: 12 }}>{viewedCount}/{layerFiles.length}</span>
            </div>
            <div className="scroll" style={{ flex: "1 1 auto", display: "flex", flexDirection: "column", gap: 1, padding: "0 8px 12px" }}>
              {filesQ.isPending && <span style={{ padding: 8 }}><Spinner /></span>}
              {ordered.map((f) => {
                const sel = f === current;
                const nOpen = review.findings.filter((x) => x.path === f.path && x.status === "open").length;
                const nThreads = (threadsQ.data ?? []).filter((t) => t.path === f.path && !t.isResolved).length;
                const viewed = viewedByPath.get(f.path) ?? false;
                return (
                  <div key={f.path} style={{ display: "flex", alignItems: "center", gap: 8, padding: "3px 6px", borderRadius: 6, background: sel ? "var(--accent-soft-bg)" : "transparent" }}>
                    <input type="checkbox" checked={viewed} disabled={mode === "since" && !viewedByPath.has(f.path)} onChange={() => setViewed.mutate({ path: f.path, viewed: !viewed })} aria-label={`Mark ${f.path} viewed`} style={{ accentColor: "var(--accent)", margin: 0 }} />
                    <button onClick={() => selectFile(f.path)} title={f.path} style={{ flex: "1 1 auto", minWidth: 0, textAlign: "left", padding: "5px 2px", border: 0, background: "transparent", color: viewed && !sel ? "var(--muted)" : "var(--text)", display: "flex", flexDirection: "column" }}>
                      <span className="mono" style={{ fontSize: 12, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{f.path.split("/").pop()}</span>
                      <span className="faint" style={{ fontSize: 11, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{f.path.split("/").slice(0, -1).join("/")}</span>
                    </button>
                    {nOpen > 0 && <span style={{ fontSize: 11, color: "var(--agent)" }} aria-label={`${nOpen} findings`}>●{nOpen}</span>}
                    {nThreads > 0 && <span style={{ fontSize: 11, color: "var(--accent-soft-fg)" }} aria-label={`${nThreads} threads`}>◆{nThreads}</span>}
                  </div>
                );
              })}
            </div>
          </aside>
        ) : (
          <aside aria-label="Stack" style={{ flex: "0 0 52px", display: "flex", flexDirection: "column", alignItems: "center", gap: 8, padding: "12px 0", borderRight: "1px solid var(--border)", background: "var(--chrome)", overflow: "auto" }}>
            <button className="btn btn-icon" onClick={() => { setRailOpen(true); setRailForced(true); }} aria-label="Expand sidebar">›</button>
            {stack.layers.map((l) => (
              <button key={l.pr.number} onClick={() => goLayer(l)} aria-label={`Layer ${l.index}: ${l.pr.title}`} style={{ border: 0, background: "transparent", padding: 0 }}>
                <LayerRing layer={l} size={28} outline={l === layer} />
              </button>
            ))}
          </aside>
        )}

        <main style={{ flex: "1 1 auto", minWidth: 0, display: "flex", flexDirection: "column", background: "var(--bg-sunk)" }}>
          <section aria-label="Layer brief" className="card" style={{ margin: "14px 16px 0", padding: "14px 16px", display: "flex", flexDirection: "column", gap: 10 }}>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center" }}>
              <span className="muted">Layer {layer.index} of {stack.layers.length} · <a href={layer.pr.url} target="_blank" rel="noreferrer">#{layer.pr.number}</a> · {layer.pr.author}</span>
              <span className="pill" style={{ background: LAYER_STYLE[layer.mine].bg, color: LAYER_STYLE[layer.mine].fg }}>{LAYER_STYLE[layer.mine].word}</span>
              {layer.pr.isDraft && <span className="pill" style={{ background: "var(--surface-2)", color: "var(--muted)" }}>Draft PR</span>}
              {canSince && (
                <div role="group" aria-label="Diff range" style={{ display: "flex", border: "1px solid var(--border-strong)", borderRadius: 6, overflow: "hidden" }}>
                  <button className="btn-sm" style={{ border: 0, padding: "3px 9px", background: mode === "layer" ? "#232a35" : "transparent", color: mode === "layer" ? "var(--text)" : "var(--muted)" }} onClick={() => setMode("layer")}>Whole layer</button>
                  <button className="btn-sm" style={{ border: 0, padding: "3px 9px", background: mode === "since" ? "#2f2914" : "transparent", color: mode === "since" ? "var(--warn-fg)" : "var(--muted)" }} onClick={() => setMode("since")}>Since my review</button>
                </div>
              )}
              <div className="spacer" />
              <button className="btn btn-sm" aria-expanded={briefOpen} onClick={() => setBriefOpen((o) => !o)}>{briefOpen ? "Collapse" : "Expand"}</button>
            </div>
            <h1 style={{ margin: 0, fontSize: 19, fontWeight: 600 }}>
              {titleParts.tag && <span className="mono faint" style={{ fontSize: 13, fontWeight: 400, marginRight: 8 }}>{titleParts.tag}</span>}
              {titleParts.text}
            </h1>
            {briefOpen && (
              <>
                {showBody ? (
                  <div className="prose scroll" style={{ maxWidth: 900, maxHeight: 260, whiteSpace: "pre-wrap", padding: "8px 10px", borderRadius: 8, background: "var(--surface-2)" }}>{fullBody}</div>
                ) : summaryText ? (
                  <p className="prose" style={{ margin: 0, maxWidth: 900, display: "-webkit-box", WebkitLineClamp: 3, WebkitBoxOrient: "vertical", overflow: "hidden" }}>
                    {summaryText}
                    {review.brief && <span className="muted"> · summary by the agent</span>}
                  </p>
                ) : <p className="muted" style={{ margin: 0 }}>No description. Ask the agent to review this layer for a summary.</p>}
                {fullBody.length > summaryText.length + 20 && (
                  <button className="btn btn-sm" style={{ alignSelf: "flex-start" }} onClick={() => setShowBody((v) => !v)}>{showBody ? "Show summary" : "Full description"}</button>
                )}
                {ordered.length > 1 && !railOpen && (
                  <div className="chips-scroll">
                    <span className="muted" style={{ marginRight: 4 }}>{review.brief?.readingOrder.length ? "Suggested reading order" : "Reading order"}</span>
                    {ordered.map((f, i) => (
                      <button key={f.path} className="btn btn-chip mono" onClick={() => selectFile(f.path)} style={{ borderColor: f === current ? "var(--accent-soft-bd)" : undefined, background: f === current ? "var(--accent-soft-bg)" : undefined, fontSize: 12 }}>
                        <span className="muted">{i + 1}</span> {f.path.split("/").pop()} {viewedByPath.get(f.path) && <span style={{ color: "var(--accent)" }}>✓</span>}
                      </button>
                    ))}
                  </div>
                )}
                {failingChecks.length > 0 ? (
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 10, alignItems: "center", padding: "8px 10px", borderRadius: 8, border: "1px solid var(--bad-bd)", background: "var(--bad-bg)" }}>
                    <span style={{ color: "var(--bad)", fontWeight: 600 }}>✕ {failingChecks.map((c) => c.name).join(", ")}</span>
                    <span className="spacer" />
                    <button className="btn btn-sm" onClick={() => setChecksOpen(failingChecks[0].id)}>Log</button>
                    <button className="btn btn-sm" onClick={() => setDockOpen(true)}>Ask the agent why</button>
                    <span style={{ color: "var(--ok)", fontSize: 12 }}>{(checksQ.data ?? []).filter((c) => checkRunState(c) === "pass").length} pass</span>
                  </div>
                ) : checksQ.data?.length ? (
                  <button className="btn btn-sm" style={{ alignSelf: "flex-start" }} onClick={() => setChecksOpen(null)}>
                    {checksQ.data.some((c) => checkRunState(c) === "pending") ? <span style={{ color: "var(--warn)" }}>● Checks running</span> : <span style={{ color: "var(--ok)" }}>✓ {checksQ.data.length} checks pass</span>}
                  </button>
                ) : null}
              </>
            )}
          </section>

          <section aria-label="File" className="card" style={{ flex: "1 1 auto", margin: "12px 16px 0", borderRadius: "12px 12px 0 0", borderBottom: 0, display: "flex", flexDirection: "column", minHeight: 0 }}>
            {filesQ.error ? <div style={{ padding: 16 }}><ErrorBox error={filesQ.error} /></div>
              : (mode === "since" ? sinceQ.isPending : filesQ.isPending) ? <div className="empty"><Spinner label="Loading files…" /></div>
              : !current ? <div className="empty">{mode === "since" ? "No changes since your review." : "This layer has no file changes."}</div>
              : (
                <>
                  <div className="row-nowrap" style={{ gap: 10, padding: "10px 14px", borderBottom: "1px solid var(--border)" }}>
                    {width >= 1180 && <span className="muted">File {currentIdx + 1} of {ordered.length}</span>}
                    <span className="mono shrink" title={current.path} style={{ fontSize: 13, fontWeight: 500, direction: "rtl", textAlign: "left" }}>{current.path}</span>
                    {current.previousPath && <span className="muted mono" style={{ fontSize: 12 }}>← {current.previousPath}</span>}
                    <span className="mono add" style={{ fontSize: 12 }}>+{current.additions}</span>
                    <span className="mono del" style={{ fontSize: 12 }}>−{current.deletions}</span>
                    {mode === "since" && <span className="pill" style={{ background: "#2f2914", color: "var(--warn-fg)" }}>since your review (includes any rebase)</span>}
                    <div className="spacer" />
                    <button className="btn btn-sm" aria-pressed={showMargin} onClick={() => setMarginPinned((v) => !v)} disabled={notesHere > 0} title={notesHere ? "Notes are shown while this file has any" : "Show the notes column"}>
                      Notes{notesHere ? ` · ${notesHere}` : ""}
                    </button>
                    <div role="group" aria-label="Diff layout" style={{ display: "flex", border: "1px solid var(--border-strong)", borderRadius: 6, overflow: "hidden" }}>
                      {(["unified", "split"] as const).map((l) => (
                        <button key={l} onClick={() => setLayout(l)} aria-pressed={layout === l} style={{ padding: "3px 9px", border: 0, fontSize: 12, background: layout === l ? "#232a35" : "transparent", color: layout === l ? "var(--text)" : "var(--muted)", textTransform: "capitalize" }}>{l}</button>
                      ))}
                    </div>
                    {mode === "layer" && (
                      <label style={{ display: "flex", gap: 6, alignItems: "center", color: "var(--text-2)" }}>
                        <input type="checkbox" checked={current.viewed} onChange={() => setViewed.mutate({ path: current.path, viewed: !current.viewed })} style={{ accentColor: "var(--accent)", margin: 0 }} /> Viewed <span className="kbd">v</span>
                      </label>
                    )}
                  </div>
                  <div style={{ flex: "1 1 auto", display: "flex", minHeight: 0 }}>
                    <div style={{ flex: "999 1 460px", minWidth: 0, minHeight: 0 }}>
                      <DiffView
                        file={current}
                        layout={layout}
                        marks={{ findings: findingsHere, threads: threadsHere, drafts: draftsHere }}
                        focusLine={focusLine}
                        composerLine={composerLine}
                        onFocusLine={setFocusLine}
                        onOpenComposer={(l) => { setFocusLine(l); setComposerLine(l); }}
                        onCloseComposer={() => setComposerLine(null)}
                        onSaveComment={(l, body) => { reviewStore.addDraft(key, { path: current.path, line: l, body, source: "me" }); setComposerLine(null); }}
                      />
                    </div>
                    {showMargin && <div style={{ flex: "0 0 290px", borderLeft: "1px solid var(--border)", minHeight: 0 }}>
                      <Margin
                        findings={findingsHere}
                        threads={threadsHere}
                        drafts={draftsHere}
                        focusLine={focusLine}
                        onFocus={setFocusLine}
                        onFinding={(id, status) => reviewStore.setFindingStatus(key, id, status)}
                        onEditDraft={(id, body) => reviewStore.editDraft(key, id, body)}
                        onRemoveDraft={(id) => reviewStore.removeDraft(key, id)}
                        onReply={async (id, body) => { await source.replyToThread(id, body); await threadsQ.refetch(); }}
                        onResolve={async (id, r) => { await source.setThreadResolved(id, r); await threadsQ.refetch(); }}
                      />
                    </div>}
                  </div>
                </>
              )}
          </section>

          <div className="row-nowrap" style={{ gap: 10, margin: "0 16px 14px", padding: "10px 14px", borderRadius: "0 0 12px 12px", border: "1px solid var(--border)", background: "var(--surface-2)" }}>
            <button className="btn" disabled={currentIdx <= 0} onClick={() => selectFile(ordered[currentIdx - 1].path)}>← Previous <span className="kbd">k</span></button>
            <button className="btn btn-primary" disabled={!current} onClick={markViewedAndNext}>
              {currentIdx === ordered.length - 1 ? "Mark viewed & finish" : "Mark viewed & next"} <span className="kbd" style={{ background: "rgba(0,0,0,.15)", color: "inherit" }}>j</span>
            </button>
            <div aria-hidden="true" style={{ display: width < 1280 ? "none" : undefined, width: 120, height: 6, borderRadius: 3, background: "#252a31", overflow: "hidden" }}>
              <div style={{ width: `${layerFiles.length ? (viewedCount / layerFiles.length) * 100 : 0}%`, height: 6, background: "var(--accent)" }} />
            </div>
            <span className="muted shrink">{viewedCount}/{layerFiles.length} viewed{openFindings.length ? ` · ${openFindings.length} to triage` : ""}</span>
            <div className="spacer" />
            <span className="muted" style={{ fontSize: 12, display: width < 1280 ? "none" : undefined }} title="j/k file · v viewed · n/p next/previous change · c comment · [ ] layer · a agent · f finish">Shortcuts <span className="kbd">?</span></span>
            <button className="btn btn-soft" onClick={() => setFinishOpen(true)}>Finish layer… <span className="kbd">f</span></button>
          </div>
        </main>

        {dockOpen && (
          <AgentDock stack={stack} layer={layer} repo={repo} currentFile={current?.path ?? null} openFindings={openFindings.length} onNextFinding={nextFinding} onClose={() => setDockOpen(false)} />
        )}
      </div>

      {finishOpen && (
        <FinishDialog
          layer={layer} drafts={review.drafts} viewed={viewedCount} total={layerFiles.length} openFindings={openFindings.length}
          nextLayer={next} summary={review.summary ?? ""} isOwn={layer.pr.author.toLowerCase() === me.toLowerCase()}
          onClose={() => setFinishOpen(false)} onSubmit={submit}
        />
      )}
      {checksOpen !== false && checksQ.data && <ChecksDialog repo={repo} checks={checksQ.data} initial={checksOpen} onClose={() => setChecksOpen(false)} />}
    </div>
  );
}
