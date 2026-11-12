import { useMemo, useState } from "react";
import { useQueries } from "@tanstack/react-query";
import { useNav } from "../app/nav";
import { useSource } from "../app/session";
import { useStack } from "../app/queries";
import type { FileChange, Layer, RepoRef, Stack } from "../lib/model";
import { repoKey } from "../lib/model";
import { prKey, reviewStore } from "../lib/reviewStore";
import { formatRanges, progressLabel, resumeLayer } from "../lib/stacks";
import { splitConventional, summarize } from "../lib/markdown";
import { useSession } from "../app/session";
import { CHECK_STYLE, ChecksLabel, ChevronLeft, ErrorBox, LAYER_STYLE, LayerRing, Spinner, timeAgo } from "../ui/bits";

export function Overview({ repo, stackKey }: { repo: RepoRef; stackKey: string }) {
  const { go, back, canGoBack } = useNav();
  const stack = useStack(repo, stackKey);

  return (
    <div className="app">
      <header className="topbar">
        <button className="btn" onClick={() => (canGoBack ? back() : go({ name: "home" }))}><ChevronLeft /> Inbox</button>
        <nav aria-label="Breadcrumb" className="crumbs"><span>{repoKey(repo)}</span><span aria-hidden="true">›</span><span className="here">{stack.data?.title ?? "Stack"}</span></nav>
        <div className="spacer" />
        {stack.isFetching && <span className="spinner" aria-label="Refreshing" />}
      </header>
      <div className="scroll" style={{ flex: "1 1 auto" }}>
        {stack.isPending ? <div className="empty"><Spinner label="Loading stack…" /></div>
          : stack.error ? <div style={{ padding: 24 }}><ErrorBox error={stack.error} /></div>
          : <OverviewBody stack={stack.data} />}
      </div>
    </div>
  );
}

function OverviewBody({ stack }: { stack: Stack }) {
  const { go } = useNav();
  const source = useSource();
  const { viewer } = useSession();
  const isMine = stack.author.toLowerCase() === (viewer?.login ?? "").toLowerCase();
  const resume = resumeLayer(stack);
  const open = stack.layers.filter((l) => l.pr.state === "OPEN");
  const add = stack.layers.reduce((n, l) => n + l.pr.additions, 0);
  const del = stack.layers.reduce((n, l) => n + l.pr.deletions, 0);

  const filesQ = useQueries({
    queries: stack.layers.map((l) => ({
      queryKey: ["files", source.kind, repoKey(stack.repo), l.pr.number, l.pr.headSha],
      queryFn: () => source.files(stack.repo, l.pr),
      staleTime: 5 * 60_000,
    })),
  });
  const filesByLayer = filesQ.map((q) => q.data);
  const allLoaded = filesByLayer.every(Boolean);

  const openReview = (layer: Layer, file?: string) => go({ name: "review", repo: stack.repo, stackKey: stack.key, layer: layer.index, file });

  return (
    <div style={{ padding: "20px 24px 32px", display: "flex", flexDirection: "column", gap: 18, maxWidth: 1600 }}>
      <section style={{ display: "flex", flexWrap: "wrap", gap: 16, alignItems: "flex-end" }}>
        <div style={{ flex: "1 1 420px", display: "flex", flexDirection: "column", gap: 6 }}>
          <span className="muted">{stack.author} · {stack.source === "native" ? "GitHub stack" : stack.source === "inferred" ? "inferred from branch chain" : "single PR"} · updated {timeAgo(stack.updatedAt)}</span>
          <h1 style={{ margin: 0, fontSize: 26, fontWeight: 600, letterSpacing: "-0.01em" }}>{stack.title}</h1>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 16 }} className="muted">
            <span><strong style={{ color: "var(--text)" }}>{stack.layers.length}</strong> layers ({open.length} open)</span>
            <span className="mono"><span className="add">+{add}</span> <span className="del">−{del}</span></span>
            <span>{progressLabel(stack, viewer?.login ?? "").split(" · resume")[0]}{isMine ? "" : " by you"}</span>
            <ChecksLabel state={stack.checks} />
          </div>
        </div>
        <button className="btn btn-primary" style={{ padding: "9px 16px" }} onClick={() => openReview(resume)}>
          {isMine ? `Open layer ${resume.index}` : resume.index > 1 ? `Resume review at layer ${resume.index}` : "Start review at layer 1"} →
        </button>
      </section>

      <div style={{ display: "flex", flexWrap: "wrap", gap: 20 }}>
        <section aria-label="Layers" style={{ flex: "1 1 400px", maxWidth: 560, display: "flex", flexDirection: "column", gap: 8 }}>
          <div className="muted" style={{ fontSize: 12, paddingLeft: 4 }}>based on <span className="mono">{stack.baseRef}</span> · review from layer 1 upward{stack.layers.length > 8 ? " · hover a layer for its summary" : ""}</div>
          <div className={stack.layers.length > 8 ? "card" : undefined} style={stack.layers.length > 8 ? { padding: 4, display: "flex", flexDirection: "column", gap: 1 } : { display: "contents" }}>
            {stack.layers.map((l) => <LayerCard key={l.pr.number} layer={l} stack={stack} current={l === resume} files={filesByLayer[l.index - 1]} compact={stack.layers.length > 8} onOpen={() => openReview(l)} />)}
          </div>
        </section>

        <div style={{ flex: "999 1 560px", minWidth: 0, display: "flex", flexDirection: "column", gap: 16 }}>
          {allLoaded ? (
            <Matrix stack={stack} files={filesByLayer as FileChange[][]} onOpen={openReview} />
          ) : (
            <div className="card" style={{ padding: 16 }}><Spinner label="Loading files for every layer…" /></div>
          )}
          {allLoaded && <CrossLayerNotes stack={stack} files={filesByLayer as FileChange[][]} />}
        </div>
      </div>
    </div>
  );
}

function LayerCard({ layer, stack, current, files, compact, onOpen }: { layer: Layer; stack: Stack; current: boolean; files?: FileChange[]; compact: boolean; onOpen: () => void }) {
  const s = LAYER_STYLE[layer.mine];
  const c = CHECK_STYLE[layer.pr.checks];
  const brief = reviewStore.get(prKey(stack.repo, layer.pr.number)).brief;
  const firstPara = brief?.summary ?? summarize(layer.pr.body, 220);
  const viewed = files?.filter((f) => f.viewed).length;
  const title = splitConventional(layer.pr.title);
  if (compact) {
    return (
      <button
        onClick={onOpen}
        title={firstPara || layer.pr.title}
        style={{ display: "flex", gap: 10, alignItems: "center", padding: "7px 10px", borderRadius: 8, textAlign: "left", border: `1px solid ${current ? "var(--accent-soft-bd)" : "transparent"}`, background: current ? "#161d28" : "transparent" }}
      >
        <LayerRing layer={layer} size={22} />
        <span className="mono muted" style={{ fontSize: 12, flex: "0 0 auto" }}>#{layer.pr.number}</span>
        <span style={{ flex: "1 1 auto", minWidth: 0, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
          {title.tag && <span className="faint mono" style={{ fontSize: 11, marginRight: 6 }}>{title.tag}</span>}
          <span style={{ fontWeight: 500 }}>{title.text}</span>
        </span>
        <span style={{ flex: "0 0 auto", fontSize: 12, color: c.color }} title={c.word}>{c.glyph}</span>
        <span className="muted mono" style={{ flex: "0 0 auto", minWidth: 64, fontSize: 11, textAlign: "right", whiteSpace: "nowrap" }}>{viewed != null ? `${viewed}/` : ""}{layer.pr.changedFiles} files</span>
      </button>
    );
  }
  return (
    <button onClick={onOpen} className="card" style={{ display: "flex", gap: 12, padding: "12px 14px", textAlign: "left", borderColor: current ? "var(--accent-soft-bd)" : undefined, background: current ? "#161d28" : undefined }}>
      <LayerRing layer={layer} size={28} />
      <span style={{ flex: "1 1 auto", minWidth: 0, display: "flex", flexDirection: "column", gap: 5 }}>
        <span style={{ display: "flex", gap: 8, alignItems: "baseline" }}>
          <span className="mono muted" style={{ fontSize: 12 }}>#{layer.pr.number}</span>
          {title.tag && <span className="faint mono" style={{ fontSize: 11 }}>{title.tag}</span>}
          <strong style={{ fontWeight: 600 }}>{title.text}</strong>
          {layer.pr.isDraft && <span className="pill" style={{ background: "var(--surface-2)", color: "var(--muted)" }}>draft</span>}
        </span>
        {firstPara && <span className="prose" style={{ display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden" }}>{firstPara}{brief ? <span className="muted"> · {brief.agent}</span> : null}</span>}
        <span style={{ display: "flex", flexWrap: "wrap", gap: 10, fontSize: 12 }}>
          <span style={{ color: s.fg }}>{s.glyph} {s.word}</span>
          <span style={{ color: CHECK_STYLE[layer.pr.checks].color }}>{CHECK_STYLE[layer.pr.checks].glyph} {CHECK_STYLE[layer.pr.checks].word}</span>
          <span className="muted">{layer.pr.changedFiles} files{viewed != null ? ` · ${viewed} viewed` : ""} · <span className="add">+{layer.pr.additions}</span> <span className="del">−{layer.pr.deletions}</span></span>
        </span>
      </span>
      {current && <span className="btn btn-sm" style={{ alignSelf: "center", background: "#2b3a52", border: 0, color: "var(--text)" }}>Resume</span>}
    </button>
  );
}

function heat(t: number) {
  return t < 10 ? "#18212e" : t < 30 ? "#1c2b40" : t < 80 ? "#223652" : "#2a4467";
}

function Matrix({ stack, files, onOpen }: { stack: Stack; files: FileChange[][]; onOpen: (l: Layer, file?: string) => void }) {
  const [sel, setSel] = useState<{ layer: number; path: string } | null>(null);
  const rows = useMemo(() => {
    const paths = new Map<string, number>();
    files.forEach((list, i) => list.forEach((f) => !paths.has(f.path) && paths.set(f.path, i)));
    return [...paths.keys()].sort((a, b) => paths.get(a)! - paths.get(b)! || a.localeCompare(b));
  }, [files]);
  const cols = stack.layers.length;
  const tooMany = cols > 12;
  const grid = `minmax(220px, 2fr) repeat(${cols}, minmax(${tooMany ? 34 : 64}px, 1fr))`;
  const cell = sel ? files[sel.layer - 1].find((f) => f.path === sel.path) : null;
  return (
    <section aria-label="Files by layer" className="card" style={{ overflowX: "auto" }}>
      <div style={{ minWidth: 220 + cols * (tooMany ? 38 : 70), padding: "12px 14px", display: "flex", flexDirection: "column", gap: 4 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 6, gap: 12, flexWrap: "wrap" }}>
          <strong>Where the stack touches the code</strong>
          <span className="muted" style={{ fontSize: 12 }}>Darker = bigger change · ✓ viewed · double-click to open</span>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: grid, gap: 4, fontSize: 12 }} className="muted">
          <span>File ({rows.length})</span>
          {stack.layers.map((l) => <span key={l.pr.number} title={`#${l.pr.number} ${l.pr.title}`}>{tooMany ? l.index : `${l.index} · #${l.pr.number}`}</span>)}
        </div>
        {rows.slice(0, 200).map((path) => (
          <div key={path} style={{ display: "grid", gridTemplateColumns: grid, gap: 4, alignItems: "center" }}>
            <span className="mono" title={path} style={{ fontSize: 12, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", display: "flex", gap: 6, minWidth: 0 }}>
              <span style={{ flex: "0 0 auto", color: sel?.path === path ? "var(--accent-soft-fg)" : "var(--text-2)" }}>{path.split("/").pop()}</span>
              <span className="faint" style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis" }}>{path.split("/").slice(0, -1).join("/")}</span>
            </span>
            {stack.layers.map((l, i) => {
              const f = files[i].find((x) => x.path === path);
              if (!f) return <span key={l.pr.number} />;
              const isSel = sel?.layer === l.index && sel.path === path;
              return (
                <button
                  key={l.pr.number}
                  onClick={() => setSel({ layer: l.index, path })}
                  onDoubleClick={() => onOpen(l, path)}
                  aria-label={`${path} in layer ${l.index}, +${f.additions} −${f.deletions}${f.viewed ? ", viewed" : ""}`}
                  style={{ height: 26, display: "flex", alignItems: "center", gap: 4, padding: "0 6px", borderRadius: 5, border: `1px solid ${isSel ? "var(--accent-soft-fg)" : "transparent"}`, background: heat(f.additions + f.deletions), color: "#9be5b8", fontFamily: "var(--mono)", fontSize: 11, overflow: "hidden" }}
                >
                  {!tooMany && `+${f.additions}`}
                  <span className="spacer" />
                  {f.viewed && <span style={{ color: "var(--accent)" }}>✓</span>}
                </button>
              );
            })}
          </div>
        ))}
        {rows.length > 200 && <span className="muted">…and {rows.length - 200} more files</span>}
        {sel && cell && (
          <div style={{ marginTop: 8, padding: "10px 12px", borderRadius: 8, background: "#171b22", display: "flex", flexWrap: "wrap", gap: 10, alignItems: "center" }}>
            <span className="mono" style={{ fontSize: 12 }}>{sel.path}</span>
            <span className="muted">in layer {sel.layer} · #{stack.layers[sel.layer - 1].pr.number} · +{cell.additions} −{cell.deletions}</span>
            <span className="spacer" />
            <button className="btn btn-sm btn-soft" onClick={() => onOpen(stack.layers[sel.layer - 1], sel.path)}>Open in review →</button>
          </div>
        )}
      </div>
    </section>
  );
}

function CrossLayerNotes({ stack, files }: { stack: Stack; files: FileChange[][] }) {
  const notes: { title: string; body: string; tone: "bad" | "warn" | "plain" }[] = [];
  const churn = new Map<string, number[]>();
  files.forEach((list, i) => list.forEach((f) => churn.set(f.path, [...(churn.get(f.path) ?? []), i + 1])));
  const hot = [...churn.entries()].filter(([, ls]) => ls.length >= 3).sort((a, b) => b[1].length - a[1].length).slice(0, 3);
  for (const [path, ls] of hot) {
    notes.push({ title: `${path.split("/").pop()} changes in ${ls.length} layers`, body: `Layers ${formatRanges(ls)} all edit this file. Review those diffs back to back; findings on an early layer may be superseded later.`, tone: "plain" });
  }
  const failing = stack.layers.filter((l) => l.pr.state === "OPEN" && l.pr.checks === "fail");
  if (failing.length) {
    const lowest = failing[0];
    notes.push({ title: `Checks fail from layer ${lowest.index} up`, body: failing.length > 1 ? `Layers ${formatRanges(failing.map((l) => l.index))} fail. Start with #${lowest.pr.number}; later failures may be the same cause.` : `#${lowest.pr.number} has failing checks.`, tone: "bad" });
  }
  const stale = stack.layers.filter((l) => l.mine === "stale");
  if (stale.length) notes.push({ title: `${stale.length} ${stale.length === 1 ? "layer has" : "layers have"} new commits since your review`, body: `Layer ${formatRanges(stale.map((l) => l.index))}. Use “Since my review” to see only what changed.`, tone: "warn" });
  if (!notes.length) return null;
  const tone = { bad: ["var(--bad-bd)", "var(--bad-bg)"], warn: ["var(--warn-bd)", "var(--warn-bg)"], plain: ["#252a31", "#14181e"] };
  return (
    <section aria-label="Across layers" style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <strong>Across layers</strong>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
        {notes.map((n) => (
          <article key={n.title} style={{ flex: "1 1 260px", padding: "12px 14px", borderRadius: 10, border: `1px solid ${tone[n.tone][0]}`, background: tone[n.tone][1], lineHeight: 1.5 }}>
            <strong>{n.title}</strong>
            <p style={{ margin: "4px 0 0", color: "var(--text-2)" }}>{n.body}</p>
          </article>
        ))}
      </div>
    </section>
  );
}
