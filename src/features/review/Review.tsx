import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { rememberRecent, useNav } from "../../app/nav";
import { useCommands, type Command } from "../../app/commands";
import { PaletteButton } from "../../app/Palette";
import { applyFileFilters, extensionChips, filterCounts, NO_FILTER, type FileFilter, type FileFilters } from "../../lib/fileFilters";
import { useChecks, useConversation, useFiles, useSetViewed, useStack, useThreads } from "../../app/queries";
import { useSession, useSource } from "../../app/session";
import { AgentDock, type AgentRequest } from "../../agent/AgentDock";
import { checkFailurePrompt } from "../../agent/session";
import { lastAgent, useGuideRun } from "../../agent/guideRun";
import { guideTargets, rankOf } from "../../lib/guide";
import { TierMeter } from "../../ui/guide";
import { FocusChecklist, GuideLine, type FocusItem } from "./GuideReview";
import { changeStarts, clampRange, parsePatch, rangeLabel, validRange } from "../../lib/diff";
import { plainText, splitConventional, stripStackBoilerplate, summarize } from "../../lib/markdown";
import type { FileChange, Layer, RepoRef, ReviewEvent, Stack } from "../../lib/model";
import { repoKey } from "../../lib/model";
import { local } from "../../lib/platform";
import { prKey, reviewStore, useReviewState } from "../../lib/reviewStore";
import { Markdown } from "../../ui/Markdown";
import { checkRunState, CHECK_STYLE, ChevronLeft, ErrorBox, LAYER_STYLE, LayerRing, Spinner } from "../../ui/bits";
import { mergeability, restackPairs } from "../../lib/stacks";
import { ChecksDialog, ConversationDialog, FinishDialog } from "./Dialogs";
import { FindingsPanel } from "./FindingsPanel";
import { DiffView } from "./DiffView";
import { Margin } from "./Margin";

type Props = { repo: RepoRef; stackKey: string; layer: number; file?: string; line?: number };

export function Review(p: Props) {
  const stack = useStack(p.repo, p.stackKey);
  const { up } = useNav();
  if (stack.isPending) return <div className="empty"><Spinner label="Loading stack…" /></div>;
  if (stack.error) return (
    <div style={{ padding: 24, display: "flex", flexDirection: "column", gap: 12, alignItems: "flex-start" }}>
      <ErrorBox error={stack.error} />
      <button className="btn" onClick={() => up({ name: "home" })}>Back to inbox</button>
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
  const { go, up } = useNav();
  const qc = useQueryClient();
  const key = prKey(repo, layer.pr.number);
  const review = useReviewState(key);
  const me = viewer?.login ?? "";
  const guide = useGuideRun(stack);
  const lg = guide.doc.layers[layer.pr.number];
  const lgStale = !!lg && lg.headSha !== layer.pr.headSha;
  const lgRank = rankOf(guide.doc.stack?.ranking, layer.pr.number);
  const guideChanged = useMemo(() => { const t = guideTargets(guide.doc, stack.layers); return new Set([...t.stale, ...t.missing, ...t.removed]).size; }, [guide.doc, stack.layers]);
  const focusItems: FocusItem[] = useMemo(() => (lg?.focus ?? []).map((f, i) => ({ ...f, n: i + 1, done: (review.focusDone ?? []).includes(f.id) })), [lg, review.focusDone]);
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
  const [agentRequest, setAgentRequest] = useState<AgentRequest | null>(null);
  const [findingsOpen, setFindingsOpen] = useState(false);
  const [conversationOpen, setConversationOpen] = useState(false);
  const [path, setPath] = useState<string | null>(initialFile ?? null);
  const [focusLine, setFocusLine] = useState<number | null>(initialLine ?? null);
  const [composer, setComposer] = useState<{ start: number; end: number } | null>(null);
  // Where shift+c / shift-click ranges start: the last line plainly clicked or commented on.
  const [anchorLine, setAnchorLine] = useState<number | null>(null);

  const [filters, setFilters] = useState<FileFilters>(() => local.get("fileFilters", NO_FILTER));
  useEffect(() => local.set("fileFilters", filters), [filters]);
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
  const conversationQ = useConversation(repo, layer.pr.number);

  // Layers that don't contain the head of the layer below: compared lazily, cached by SHA pair.
  const pairs = useMemo(() => restackPairs(stack), [stack]);
  const restackQs = useQueries({
    queries: pairs.map((p) => ({
      queryKey: ["behindBase", source.kind, repoKey(repo), p.lowerSha, p.upperSha],
      queryFn: () => source.behindBase(repo, p.lowerSha, p.upperSha),
      staleTime: Infinity,
    })),
  });
  const needsRestack = new Set(pairs.filter((_, i) => restackQs[i]?.data === true).map((p) => p.layer));
  const merge = mergeability(layer.pr);
  const reviewers = useMemo(() => {
    const reviewed = new Set(layer.pr.latestReviews.map((r) => r.author.toLowerCase()));
    return [
      ...layer.pr.latestReviews.filter((r) => r.state !== "PENDING").map((r) => ({ name: r.author, state: r.state })),
      ...layer.pr.requestedReviewers.filter((r) => !reviewed.has(r.toLowerCase())).map((r) => ({ name: r, state: "REQUESTED" })),
    ];
  }, [layer.pr.latestReviews, layer.pr.requestedReviewers]);

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
  // Focus ranges in this file. On a guide that's out of date, only ranges still valid in the current diff.
  const focusHere = useMemo(() => {
    if (mode !== "layer" || !current) return [];
    const here = focusItems.filter((f) => f.path === current.path);
    if (!lgStale) return here;
    const rows = parsePatch(current.patch);
    return here.filter((f) => validRange(rows, f.startLine ?? f.line, f.line));
  }, [focusItems, current, mode, lgStale]);
  const notesHere = findingsHere.length + threadsHere.length + draftsHere.filter((d) => d.source === "me").length;
  const [marginPinned, setMarginPinned] = useState(() => local.get("marginPinned", false));
  useEffect(() => local.set("marginPinned", marginPinned), [marginPinned]);
  const showMargin = notesHere > 0 || marginPinned || composer != null;
  const failingChecks = (checksQ.data ?? []).filter((c) => checkRunState(c) === "fail");
  // Sidebar filters. They shape the list and j/k order, but the current file always stays in it.
  const facts = useMemo(() => ordered.map((f) => ({
    path: f.path,
    viewed: viewedByPath.get(f.path) ?? false,
    openFindings: review.findings.filter((x) => x.path === f.path && x.status === "open").length,
    openThreads: (threadsQ.data ?? []).filter((t) => t.path === f.path && !t.isResolved).length,
    drafts: review.drafts.filter((d) => d.path === f.path).length,
    focus: focusItems.filter((x) => x.path === f.path).length,
    skim: lg?.skim.some((x) => x.path === f.path) ?? false,
  })), [ordered, viewedByPath, review.findings, review.drafts, threadsQ.data, focusItems, lg]);
  const counts = useMemo(() => filterCounts(facts), [facts]);
  const extChips = useMemo(() => extensionChips(ordered), [ordered]);
  const navFiles = useMemo(() => {
    const eff = !lg && (filters.kind === "focus" || filters.hideSkim) ? { ...filters, kind: filters.kind === "focus" ? "all" as const : filters.kind, hideSkim: false } : filters;
    const keep = new Set(applyFileFilters(facts, eff, current?.path).map((x) => x.path));
    return ordered.filter((f) => keep.has(f.path));
  }, [facts, filters, current?.path, ordered, lg]);
  const navIdx = current ? navFiles.indexOf(current) : -1;
  const setKind = (kind: FileFilter) => setFilters((f) => ({ ...f, kind }));
  const setExt = (ext: string | null) => setFilters((f) => ({ ...f, ext: f.ext === ext ? null : ext }));
  const filtered = filters.kind !== "all" || !!filters.hideSkim || (filters.ext != null && extChips.length > 0);
  const prev = stack.layers[layer.index - 2] ?? null;
  const next = stack.layers[layer.index] ?? null;

  const selectFile = useCallback((p: string, line: number | null = null) => {
    setPath(p);
    setFocusLine(line);
    setComposer(null);
    setAnchorLine(null);
  }, []);

  const goLayer = (l: Layer | null) => l && go({ name: "review", repo, stackKey: stack.key, layer: l.index });

  const markViewedAndNext = () => {
    if (!current) return;
    if (mode === "layer" && !current.viewed) setViewed.mutate({ path: current.path, viewed: true });
    const after = navFiles.slice(navIdx + 1);
    // With a filter on, running out of matching files isn't the end of the layer: carry on to the
    // next unviewed file anywhere (the filter never hides the current file, so it stays visible).
    const target = after.find((f) => !viewedByPath.get(f.path)) ?? after[0]
      ?? (filtered ? ordered.find((f) => f !== current && !viewedByPath.get(f.path)) : undefined);
    if (target) selectFile(target.path);
    else setFinishOpen(true);
  };

  const nextFinding = () => {
    const sorted = [...openFindings].sort((a, b) => ordered.findIndex((f) => f.path === a.path) - ordered.findIndex((f) => f.path === b.path) || a.line - b.line);
    const f = sorted.find((x) => x.path === current?.path && x.line > (focusLine ?? 0)) ?? sorted[0];
    if (f) selectFile(f.path, f.line);
  };

  // Agent tools for this stack are registered by useGuideRun (via useStackAgent), per stack and kept
  // after leaving the screen, so an agent still working writes to the right place.

  const jumpFocus = (f: FocusItem) => { setMode("layer"); selectFile(f.path, f.startLine ?? f.line); };
  const tickFocus = (id: string) => reviewStore.setFocusDone(key, id, !(review.focusDone ?? []).includes(id));
  /** Next focus area after the current file and line, in file order; wraps round to the first. */
  const nextFocusArea = () => {
    const order = (f: FocusItem) => [ordered.findIndex((x) => x.path === f.path), f.startLine ?? f.line] as const;
    const list = focusItems.filter((f) => order(f)[0] >= 0).sort((a, b) => order(a)[0] - order(b)[0] || order(a)[1] - order(b)[1]);
    if (!list.length) return;
    const ci = current ? ordered.indexOf(current) : -1;
    const cl = focusLine ?? 0;
    jumpFocus(list.find((f) => { const [fi, l] = order(f); return fi > ci || (fi === ci && l > cl); }) ?? list[0]);
  };
  const askAuthor = (q: string) => reviewStore.setSummary(key, [review.summary?.trim(), `Question for the author: ${q}`].filter(Boolean).join("\n\n"));
  const asked = new Set((lg?.questions ?? []).filter((q) => review.summary?.includes(`Question for the author: ${q}`)));
  const focusDone = focusItems.filter((f) => f.done).length;

  // Palette commands for this screen.
  const toggleRail = () => (railOpen ? (setRailOpen(false), setRailForced(false)) : (setRailOpen(true), setRailForced(true)));
  const commands: Command[] = [
    { id: "r-agent", group: "Actions", title: dockOpen ? "Hide agent panel" : "Show agent panel", shortcut: "a", keywords: "toggle", run: () => setDockOpen((o) => !o) },
    { id: "r-findings", group: "Actions", title: "Open findings", hint: review.findings.length ? `${openFindings.length} to triage` : "none yet", keywords: "agent triage", run: () => setFindingsOpen(true) },
    { id: "r-guide", group: "Actions", title: guide.doc.stack ? "Re-run the guide…" : "Guide me…", keywords: "guide agent summary complexity", run: () => { local.set("guideLaunch", `${repoKey(repo)}#${stack.key}`); go({ name: "overview", repo, stackKey: stack.key }); } },
    ...(guideChanged && guide.doc.run?.status !== "running" ? [{ id: "r-guide-refresh", group: "Actions" as const, title: "Refresh guide", hint: `${guideChanged} out of date`, keywords: "guide stale", run: () => void guide.start({ ...lastAgent(), mode: "refresh" }) }] : []),
    ...(focusItems.length ? [{ id: "r-focus", group: "Actions" as const, title: "Next focus area", hint: `${focusDone}/${focusItems.length} ticked`, shortcut: ".", keywords: "guide", run: nextFocusArea }] : []),
    { id: "r-finish", group: "Actions", title: "Finish layer…", shortcut: "f", keywords: "submit review approve", run: () => setFinishOpen(true) },
    ...(current && mode === "layer" ? [{ id: "r-viewed", group: "Actions" as const, title: current.viewed ? "Mark file not viewed" : "Mark file viewed", hint: current.path.split("/").pop(), shortcut: "v", run: () => setViewed.mutate({ path: current.path, viewed: !current.viewed }) }] : []),
    { id: "r-layout", group: "Actions", title: layout === "unified" ? "Switch to split diff" : "Switch to unified diff", keywords: "layout side by side", run: () => setLayout((l) => (l === "unified" ? "split" : "unified")) },
    { id: "r-rail", group: "Actions", title: railOpen ? "Collapse sidebar" : "Expand sidebar", run: toggleRail },
    ...stack.layers.map((l): Command => ({ id: `layer:${l.index}`, group: "Layers", title: `Layer ${l.index}: ${l.pr.title}`, hint: `#${l.pr.number}`, keywords: `${l.pr.number}`, current: l === layer, run: () => goLayer(l) })),
    ...ordered.map((f): Command => ({ id: `file:${f.path}`, group: "Files", title: f.path.split("/").pop() ?? f.path, hint: f.path.split("/").slice(0, -1).join("/"), keywords: f.path, current: f === current, run: () => selectFile(f.path) })),
  ];
  useCommands(commands);

  // Keyboard shortcuts.
  const keys = useRef<(e: KeyboardEvent) => void>(() => {});
  keys.current = (e: KeyboardEvent) => {
    const t = e.target as HTMLElement;
    if (e.metaKey || e.ctrlKey || e.altKey || finishOpen || findingsOpen || conversationOpen || checksOpen !== false) return;
    if (t.closest("input, textarea, select, [contenteditable=true]")) return;
    const k = e.key;
    if (k === "j") markViewedAndNext();
    else if (k === "k" && navIdx > 0) selectFile(navFiles[navIdx - 1].path);
    else if (k === "v" && current && mode === "layer") setViewed.mutate({ path: current.path, viewed: !current.viewed });
    else if (k === "a") setDockOpen((o) => !o);
    else if (k === "]") goLayer(next);
    else if (k === "[") goLayer(prev);
    else if ((k === "C" || (k === "c" && e.shiftKey)) && focusLine != null) {
      const r = clampRange(parsePatch(current?.patch), anchorLine ?? focusLine, focusLine);
      setComposer(r);
      setAnchorLine((a) => a ?? focusLine);
    }
    else if (k === "c" && focusLine != null) { setComposer({ start: focusLine, end: focusLine }); setAnchorLine(focusLine); }
    else if (k === "f") setFinishOpen(true);
    else if (k === ".") nextFocusArea();
    else if (k === "n" || k === "p") {
      if (!current) return;
      const starts = changeStarts(parsePatch(current.patch));
      const cur = focusLine ?? 0;
      const target = k === "n" ? starts.find((n) => n > cur) ?? starts[0] : [...starts].reverse().find((n) => n < cur) ?? starts[starts.length - 1];
      if (target != null) setFocusLine(target);
    } else if (k === "Escape") setComposer(null);
    else return;
    e.preventDefault();
  };
  useEffect(() => {
    const h = (e: KeyboardEvent) => keys.current(e);
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, []);

  const submit = async (event: ReviewEvent, body: string) => {
    const byPath = new Map(layerFiles.map((f) => [f.path, parsePatch(f.patch)]));
    const valid = review.drafts.filter((d) => validRange(byPath.get(d.path) ?? [], d.startLine ?? d.line, d.line));
    const orphan = review.drafts.filter((d) => !valid.includes(d));
    const fullBody = [body, ...orphan.map((d) => `**${d.path}${rangeLabel(d.line, d.startLine, ":")}**\n${d.body}`)].filter(Boolean).join("\n\n---\n\n");
    await source.submitReview(repo, layer.pr.number, { event, body: fullBody, commitId: layer.pr.headSha, comments: valid.map((d) => ({ path: d.path, line: d.line, startLine: d.startLine != null && d.startLine < d.line ? d.startLine : undefined, body: d.body })) });
    reviewStore.clearDrafts(key);
    reviewStore.setSummary(key, "");
    await qc.invalidateQueries({ queryKey: ["stack"] });
    await qc.invalidateQueries({ queryKey: ["inbox"] });
    setFinishOpen(false);
    if (next) goLayer(next);
    else up({ name: "overview", repo, stackKey: stack.key });
  };

  const summaryText = review.brief?.summary ?? summarize(layer.pr.body, 600);
  const fullBody = useMemo(() => plainText(stripStackBoilerplate(layer.pr.body)).replace(/\n{3,}/g, "\n\n").trim(), [layer.pr.body]);
  const [showBody, setShowBody] = useState(false);
  // Full description as Markdown, minus the "Part N of M in stack…" line stacking tools add.
  const fullBodyMd = useMemo(() => layer.pr.body.replace(/^[ \t]*part \d+ of \d+\b.*$/im, "").trim(), [layer.pr.body]);
  const manyLayers = stack.layers.length > 8;
  const railLayersRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    railLayersRef.current?.querySelector("[data-current]")?.scrollIntoView({ block: "nearest" });
  }, [railOpen, layer.index]);
  const titleParts = splitConventional(layer.pr.title);

  return (
    <div className="app">
      <header className="topbar">
        <button className="btn" onClick={() => up({ name: "overview", repo, stackKey: stack.key })}><ChevronLeft /> Overview</button>
        <nav aria-label="Breadcrumb" className="crumbs"><span>{repo.repo}</span><span aria-hidden="true">›</span><span>{stack.title}</span><span aria-hidden="true">›</span><span className="here">#{layer.pr.number}</span></nav>
        <div className="spacer" />
        <PaletteButton />
        {review.findings.length > 0 && (
          <button className={openFindings.length ? "btn btn-agent" : "btn"} onClick={() => setFindingsOpen(true)} title="All agent findings on this layer">
            Findings · {openFindings.length ? `${openFindings.length} to triage` : review.findings.length}
          </button>
        )}
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
                    className="rail-layer"
                    data-current={sel || undefined}
                    onClick={() => goLayer(l)}
                    aria-current={sel ? "true" : undefined}
                    title={`#${l.pr.number} ${l.pr.title} — ${s.word} · ${CHECK_STYLE[l.pr.checks].word}${needsRestack.has(l.index) ? " · needs restack" : ""}`}
                    style={{ display: "flex", gap: manyLayers ? 8 : 10, alignItems: "center", textAlign: "left", padding: manyLayers ? "4px 6px" : "7px 8px", borderRadius: 8, border: `1px solid ${sel ? "var(--accent-soft-bd)" : "transparent"}`, background: sel ? "var(--accent-soft-bg)" : "transparent", flex: "0 0 auto" }}
                  >
                    <LayerRing layer={l} size={manyLayers ? 20 : 22} />
                    {manyLayers ? (
                      <span style={{ minWidth: 0, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", fontWeight: sel ? 600 : 400, color: sel ? "var(--text)" : "var(--text-2)" }}>{t.text}</span>
                    ) : (
                      <span style={{ display: "flex", flexDirection: "column", minWidth: 0 }}>
                        <span style={{ fontWeight: 500, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{t.text}</span>
                        <span style={{ fontSize: 12, color: s.fg }}>#{l.pr.number} · {s.word}{needsRestack.has(l.index) && <span style={{ color: "var(--warn)" }}> · needs restack</span>}</span>
                      </span>
                    )}
                    <span className="spacer" />
                    {guide.doc.layers[l.pr.number] && <TierMeter tier={guide.doc.layers[l.pr.number].tier} size={manyLayers ? 9 : 11} dim={guide.doc.layers[l.pr.number].headSha !== l.pr.headSha} />}
                    <span title={CHECK_STYLE[l.pr.checks].word} aria-label={CHECK_STYLE[l.pr.checks].word} style={{ color: CHECK_STYLE[l.pr.checks].color, fontSize: 12 }}>{CHECK_STYLE[l.pr.checks].glyph}</span>
                  </button>
                );
              })}
            </div>
            {focusItems.length > 0 && <FocusChecklist items={focusItems} stale={lgStale} onJump={jumpFocus} onTick={(f) => tickFocus(f.id)} />}
            <div style={{ borderTop: "1px solid var(--border)", padding: "12px 14px 6px", display: "flex", justifyContent: "space-between" }}>
              <span className="label">Files · reading order</span>
              <span className="muted" style={{ fontSize: 12 }}>{viewedCount}/{layerFiles.length}</span>
            </div>
            <div role="group" aria-label="Filter files" className="chips-scroll" style={{ padding: "0 10px 6px", flexWrap: "wrap", overflowX: "visible" }}>
              {([["all", "All"], ["unviewed", "Unviewed"], ["findings", "Findings"], ["comments", "Comments"], ...(lg ? [["focus", "Focus"] as const] : [])] as const).map(([k, label]) => (
                <button key={k} className="btn btn-chip" aria-pressed={filters.kind === k} onClick={() => setKind(k)} style={{ padding: "2px 8px", borderColor: filters.kind === k ? "var(--accent-soft-bd)" : undefined, background: filters.kind === k ? "var(--accent-soft-bg)" : undefined }}>
                  {label} {counts[k]}
                </button>
              ))}
              {lg && lg.skim.length > 0 && (
                <button className="btn btn-chip" aria-pressed={!!filters.hideSkim} onClick={() => setFilters((f) => ({ ...f, hideSkim: !f.hideSkim }))} title="Hide the files the guide says are safe to skim" style={{ padding: "2px 8px", borderColor: filters.hideSkim ? "var(--agent-bd)" : undefined, background: filters.hideSkim ? "var(--agent-bg)" : undefined, color: filters.hideSkim ? "var(--agent)" : undefined }}>
                  Hide skim {lg.skim.length}
                </button>
              )}
              {extChips.map((c) => (
                <button key={c.ext} className="btn btn-chip mono" aria-pressed={filters.ext === c.ext} onClick={() => setExt(c.ext)} title={`Only .${c.ext} files`} style={{ padding: "2px 8px", borderColor: filters.ext === c.ext ? "var(--accent-soft-bd)" : undefined, background: filters.ext === c.ext ? "var(--accent-soft-bg)" : undefined }}>
                  .{c.ext} {c.count}
                </button>
              ))}
            </div>
            <div className="scroll" style={{ flex: "1 1 auto", display: "flex", flexDirection: "column", gap: 1, padding: "0 8px 12px" }}>
              {filesQ.isPending && <span style={{ padding: 8 }}><Spinner /></span>}
              {filtered && navFiles.length <= 1 && ordered.length > 1 && <span className="muted" style={{ padding: "4px 8px", fontSize: 12 }}>No other files match this filter.</span>}
              {navFiles.map((f) => {
                const sel = f === current;
                const nOpen = review.findings.filter((x) => x.path === f.path && x.status === "open").length;
                const nThreads = (threadsQ.data ?? []).filter((t) => t.path === f.path && !t.isResolved).length;
                const viewed = viewedByPath.get(f.path) ?? false;
                const nFocus = focusItems.filter((x) => x.path === f.path).length;
                const isSkim = lg?.skim.some((x) => x.path === f.path) ?? false;
                return (
                  <div key={f.path} style={{ display: "flex", alignItems: "center", gap: 8, padding: "3px 6px", borderRadius: 6, background: sel ? "var(--accent-soft-bg)" : "transparent" }}>
                    <input type="checkbox" checked={viewed} disabled={mode === "since" && !viewedByPath.has(f.path)} onChange={() => setViewed.mutate({ path: f.path, viewed: !viewed })} aria-label={`Mark ${f.path} viewed`} style={{ accentColor: "var(--accent)", margin: 0 }} />
                    <button onClick={() => selectFile(f.path)} title={f.path} style={{ flex: "1 1 auto", minWidth: 0, textAlign: "left", padding: "5px 2px", border: 0, background: "transparent", color: viewed && !sel ? "var(--muted)" : "var(--text)", display: "flex", flexDirection: "column" }}>
                      <span className="mono" style={{ fontSize: 12, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{f.path.split("/").pop()}</span>
                      <span className="faint" style={{ fontSize: 11, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{f.path.split("/").slice(0, -1).join("/")}</span>
                    </button>
                    {nFocus > 0 && <span className="pill" style={{ fontSize: 10.5, padding: "0 6px", border: "1px solid var(--agent-bd)", background: "var(--agent-bg)", color: "var(--agent)" }} title={`${nFocus} focus ${nFocus === 1 ? "area" : "areas"} in this file`}>focus {nFocus}</span>}
                    {isSkim && <span className="pill" style={{ fontSize: 10.5, padding: "0 6px", border: "1px solid var(--border-strong)", color: "var(--muted)" }} title={lg?.skim.find((x) => x.path === f.path)?.why}>skim</span>}
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
              <button key={l.pr.number} className="rail-layer" data-current={l === layer || undefined} onClick={() => goLayer(l)} aria-label={`Layer ${l.index}: ${l.pr.title}`} aria-current={l === layer ? "true" : undefined} style={{ border: 0, background: "transparent", padding: 0 }}>
                <span style={{ position: "relative", display: "inline-flex" }} title={`#${l.pr.number} — ${CHECK_STYLE[l.pr.checks].word}${needsRestack.has(l.index) ? " · needs restack" : ""}`}>
                  <LayerRing layer={l} size={28} outline={l === layer} />
                  <span aria-hidden="true" style={{ position: "absolute", right: -5, bottom: -4, fontSize: 10, lineHeight: 1, fontWeight: 700, color: CHECK_STYLE[l.pr.checks].color, background: "var(--chrome)", borderRadius: 6, padding: "1px 2px" }}>{CHECK_STYLE[l.pr.checks].glyph}</span>
                  {needsRestack.has(l.index) && <span aria-hidden="true" style={{ position: "absolute", left: -5, top: -5, fontSize: 11, lineHeight: 1, color: "var(--warn)", background: "var(--chrome)", borderRadius: 6 }}>⟳</span>}
                </span>
                <span className="sr-only" style={{ position: "absolute", width: 1, height: 1, overflow: "hidden" }}>{CHECK_STYLE[l.pr.checks].word}{needsRestack.has(l.index) ? ", needs restack" : ""}</span>
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
              {merge && <span className="pill" title={merge.hint} style={{ background: `var(--${merge.tone === "muted" ? "surface-2" : merge.tone === "ok" ? "ok-bg" : merge.tone === "bad" ? "del-bg" : "warn-bg, #2f2914"})`, color: `var(--${merge.tone === "muted" ? "muted" : merge.tone === "ok" ? "ok-fg" : merge.tone === "bad" ? "bad-fg" : "warn-fg"})` }}>{merge.label}</span>}
              {(layer.pr.labels ?? []).map((lb) => <span key={lb.name} className="pill" style={{ background: "var(--surface-2)", border: `1px solid #${lb.color}`, color: "var(--text-2)" }}>{lb.name}</span>)}
              {canSince && (
                <div role="group" aria-label="Diff range" style={{ display: "flex", border: "1px solid var(--border-strong)", borderRadius: 6, overflow: "hidden" }}>
                  <button className="btn-sm" style={{ border: 0, padding: "3px 9px", background: mode === "layer" ? "#232a35" : "transparent", color: mode === "layer" ? "var(--text)" : "var(--muted)" }} onClick={() => setMode("layer")}>Whole layer</button>
                  <button className="btn-sm" style={{ border: 0, padding: "3px 9px", background: mode === "since" ? "#2f2914" : "transparent", color: mode === "since" ? "var(--warn-fg)" : "var(--muted)" }} onClick={() => setMode("since")}>Since my review</button>
                </div>
              )}
              <div className="spacer" />
              <button className="btn btn-sm" onClick={() => setConversationOpen(true)}>Conversation · {conversationQ.data?.length ?? "…"}</button>
              <button className="btn btn-sm" aria-expanded={briefOpen} onClick={() => setBriefOpen((o) => !o)}>{briefOpen ? "Collapse" : "Expand"}</button>
            </div>
            <h1 style={{ margin: 0, fontSize: 19, fontWeight: 600 }}>
              {titleParts.tag && <span className="mono faint" style={{ fontSize: 13, fontWeight: 400, marginRight: 8 }}>{titleParts.tag}</span>}
              {titleParts.text}
            </h1>
            {briefOpen && (
              <>
                {needsRestack.has(layer.index) && (
                  <div style={{ color: "var(--warn-fg)", fontSize: 13 }}>⟳ Needs restack: this layer doesn't contain the latest head of layer {layer.index - 1}, so its diff may not match what lands.</div>
                )}
                {reviewers.length > 0 && (
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center" }}>
                    <span className="muted">Reviewers</span>
                    {reviewers.map((r) => {
                      const st = r.state === "APPROVED" ? { g: "✓", c: "var(--ok)", w: "approved" } : r.state === "CHANGES_REQUESTED" ? { g: "✕", c: "var(--bad)", w: "requested changes" } : r.state === "REQUESTED" ? { g: "○", c: "var(--muted)", w: "review requested" } : r.state === "DISMISSED" ? { g: "–", c: "var(--muted)", w: "dismissed" } : { g: "●", c: "var(--accent-soft-fg)", w: "commented" };
                      return <span key={r.name} className="pill" title={`${r.name}: ${st.w}`} style={{ background: "var(--surface-2)", color: "var(--text-2)" }}><span style={{ color: st.c }} aria-hidden="true">{st.g}</span> {r.name}<span className="sr-only" style={{ position: "absolute", width: 1, height: 1, overflow: "hidden" }}>, {st.w}</span></span>;
                    })}
                  </div>
                )}
                {showBody ? (
                  <div className="scroll" style={{ maxWidth: 900, maxHeight: 260, padding: "8px 12px", borderRadius: 8, background: "var(--surface-2)" }}><Markdown text={fullBodyMd} /></div>
                ) : summaryText ? (
                  <p className="prose" style={{ margin: 0, maxWidth: 900, display: "-webkit-box", WebkitLineClamp: 3, WebkitBoxOrient: "vertical", overflow: "hidden" }}>
                    {summaryText}
                    {review.brief && <span className="muted"> · summary by the agent</span>}
                  </p>
                ) : <p className="muted" style={{ margin: 0 }}>No description. Ask the agent to review this layer for a summary.</p>}
                {lg && (
                  <GuideLine guide={lg} rank={lgRank} stale={lgStale} questions={lg.questions} askedQuestions={asked} onAsk={askAuthor} onSkim={(p2) => { setMode("layer"); selectFile(p2); }} />
                )}
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
                    <button className="btn btn-sm" onClick={() => { setDockOpen(true); setAgentRequest({ id: Date.now(), text: checkFailurePrompt(layer.pr.number, failingChecks.map((c) => c.name)), display: `Why is ${failingChecks.length === 1 ? failingChecks[0].name : "CI"} failing?` }); }}>Ask the agent why</button>
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
                        repo={repo}
                        file={current}
                        newRef={layer.pr.headSha}
                        oldRef={mode === "since" ? myReview?.commit ?? undefined : layer.pr.baseSha}
                        layout={layout}
                        marks={{ findings: findingsHere, threads: threadsHere, drafts: draftsHere, focus: focusHere }}
                        onTickFocus={tickFocus}
                        focusLine={focusLine}
                        composer={composer}
                        anchorLine={anchorLine}
                        onFocusLine={(l) => { setFocusLine(l); setAnchorLine(l); }}
                        onOpenComposer={(s, e) => { setFocusLine(e); setComposer(s === e ? { start: s, end: e } : clampRange(parsePatch(current.patch), s, e)); setAnchorLine(s); }}
                        onCloseComposer={() => setComposer(null)}
                        onSaveComment={(s, e, body) => { reviewStore.addDraft(key, { path: current.path, line: e, startLine: s < e ? s : undefined, body, source: "me" }); setComposer(null); }}
                      />
                    </div>
                    {showMargin && <div style={{ flex: "0 0 290px", width: 290, minWidth: 0, overflow: "hidden", borderLeft: "1px solid var(--border)", minHeight: 0 }}>
                      <Margin
                        findings={findingsHere}
                        threads={threadsHere}
                        drafts={draftsHere}
                        focusLine={focusLine}
                        onFocus={setFocusLine}
                        onFinding={(id, status, body) => reviewStore.setFindingStatus(key, id, status, body)}
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
            <button className="btn" disabled={navIdx <= 0} onClick={() => selectFile(navFiles[navIdx - 1].path)}>← Previous <span className="kbd">k</span></button>
            <button className="btn btn-primary" disabled={!current} onClick={markViewedAndNext}>
              {navIdx === navFiles.length - 1 ? "Mark viewed & finish" : "Mark viewed & next"} <span className="kbd" style={{ background: "rgba(0,0,0,.15)", color: "inherit" }}>j</span>
            </button>
            <div aria-hidden="true" style={{ display: width < 1280 ? "none" : undefined, width: 120, height: 6, borderRadius: 3, background: "#252a31", overflow: "hidden" }}>
              <div style={{ width: `${layerFiles.length ? (viewedCount / layerFiles.length) * 100 : 0}%`, height: 6, background: "var(--accent)" }} />
            </div>
            <span className="muted shrink">{viewedCount}/{layerFiles.length} viewed{openFindings.length ? ` · ${openFindings.length} to triage` : ""}{focusItems.length ? <span style={{ color: "var(--agent)" }}> · focus {focusDone}/{focusItems.length}</span> : ""}</span>
            <div className="spacer" />
            <span className="muted" style={{ fontSize: 12, display: width < 1280 ? "none" : undefined }} title="j/k file · v viewed · n/p next/previous change · . next focus area · c comment · [ ] layer · a agent · f finish">Shortcuts <span className="kbd">?</span></span>
            <button className="btn btn-soft" onClick={() => setFinishOpen(true)}>Finish layer… <span className="kbd">f</span></button>
          </div>
        </main>

        {dockOpen && (
          <AgentDock stack={stack} layer={layer} repo={repo} currentFile={current?.path ?? null} openFindings={openFindings.length} onNextFinding={nextFinding} onClose={() => setDockOpen(false)} request={agentRequest} onRequestHandled={(id) => setAgentRequest((r) => (r?.id === id ? null : r))} />
        )}
      </div>

      {finishOpen && (
        <FinishDialog
          layer={layer} drafts={review.drafts} viewed={viewedCount} total={layerFiles.length} openFindings={openFindings.length}
          nextLayer={next} summary={review.summary ?? ""} isOwn={layer.pr.author.toLowerCase() === me.toLowerCase()}
          onClose={() => setFinishOpen(false)} onSubmit={submit}
          onEditDraft={(id, body) => reviewStore.editDraft(key, id, body)}
          onRemoveDraft={(id) => reviewStore.removeDraft(key, id)}
          onReviewFindings={() => { setFinishOpen(false); setFindingsOpen(true); }}
          focusLeft={focusItems.filter((f) => !f.done)} focusTotal={focusItems.length}
          onJumpFocus={(f) => { setFinishOpen(false); jumpFocus(f); }} onTickFocus={tickFocus}
        />
      )}
      {findingsOpen && (
        <FindingsPanel
          pr={layer.pr.number}
          findings={review.findings}
          drafts={review.drafts}
          fileOrder={ordered.map((f) => f.path)}
          onJump={(f) => { setFindingsOpen(false); setMode("layer"); selectFile(f.path, f.line); }}
          onStatus={(id, status, body) => reviewStore.setFindingStatus(key, id, status, body)}
          onEditDraft={(id, body) => reviewStore.editDraft(key, id, body)}
          onClose={() => setFindingsOpen(false)}
        />
      )}
      {conversationOpen && (
        <ConversationDialog
          number={layer.pr.number}
          entries={conversationQ.data ?? []}
          loading={conversationQ.isPending}
          error={conversationQ.error}
          onPost={async (body) => { await source.postComment(repo, layer.pr.number, body); await conversationQ.refetch(); }}
          onClose={() => setConversationOpen(false)}
        />
      )}
      {checksOpen !== false && checksQ.data && <ChecksDialog repo={repo} checks={checksQ.data} initial={checksOpen} onClose={() => setChecksOpen(false)} />}
    </div>
  );
}
