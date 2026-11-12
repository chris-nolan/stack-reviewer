import { useMemo, useState } from "react";
import { useQueries } from "@tanstack/react-query";
import { useNav } from "../app/nav";
import { pinId, pinStore, usePinnedStacks } from "../lib/homeStore";
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
  const { up } = useNav();
  const stack = useStack(repo, stackKey);

  return (
    <div className="app">
      <header className="topbar">
        <button className="btn" onClick={() => up({ name: "home" })}><ChevronLeft /> Inbox</button>
        <nav aria-label="Breadcrumb" className="crumbs"><span>{repoKey(repo)}</span><span aria-hidden="true">›</span><span className="here">{stack.data?.title ?? "Stack"}</span></nav>
        <div className="spacer" />
        {stack.isFetching && <span className="spinner" aria-label="Refreshing" />}
      </header>
      <div style={{ flex: "1 1 auto", minHeight: 0 }}>
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
  const [hover, setHover] = useState<number | null>(null);
  const compact = stack.layers.length > 8;
  const pinned = usePinnedStacks().some((p) => pinId(p) === pinId({ repo: stack.repo, stackKey: stack.key }));

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

  // The page itself never scrolls: the layer list and the matrix scroll inside their panels,
  // so the header and the cross-layer notes stay on screen.
  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column", gap: 14, padding: "16px 20px 16px", minHeight: 0 }}>
      <section style={{ flex: "0 0 auto", display: "flex", flexWrap: "wrap", gap: "6px 16px", alignItems: "center" }}>
        <div style={{ flex: "1 1 420px", minWidth: 0, display: "flex", flexDirection: "column", gap: 4 }}>
          <h1 style={{ margin: 0, fontSize: 22, fontWeight: 600, letterSpacing: "-0.01em" }}>{stack.title}</h1>
          <div style={{ display: "flex", flexWrap: "wrap", gap: "2px 14px" }} className="muted">
            <span>{stack.author} · {stack.source === "native" ? "GitHub stack" : stack.source === "inferred" ? "inferred from branches" : "single PR"} on <span className="mono">{stack.baseRef}</span> · updated {timeAgo(stack.updatedAt)}</span>
            <span><strong style={{ color: "var(--text)" }}>{stack.layers.length}</strong> layers{open.length !== stack.layers.length ? ` (${open.length} open)` : ""}</span>
            <span className="mono"><span className="add">+{add}</span> <span className="del">−{del}</span></span>
            <span>{progressLabel(stack, viewer?.login ?? "").split(" · resume")[0]}{isMine ? "" : " by you"}</span>
            <ChecksLabel state={stack.checks} />
          </div>
        </div>
        <button
          className="btn"
          style={{ padding: "9px 12px" }}
          aria-pressed={pinned}
          title={pinned ? "Unpin this stack from Home" : "Pin this stack to Home"}
          onClick={() => pinStore.toggle({ repo: stack.repo, stackKey: stack.key, title: stack.title })}
        >
          {pinned ? "★ Pinned" : "☆ Pin"}
        </button>
        <button className="btn btn-primary" style={{ padding: "9px 16px" }} onClick={() => openReview(resume)}>
          {isMine ? `Open layer ${resume.index}` : resume.index > 1 ? `Resume review at layer ${resume.index}` : "Start review at layer 1"} →
        </button>
      </section>

      {allLoaded && <CrossLayerNotes stack={stack} files={filesByLayer as FileChange[][]} onLayer={(n) => openReview(stack.layers[n - 1])} />}

      <div style={{ flex: "1 1 auto", minHeight: 0, display: "flex", gap: 16 }}>
        <section aria-label="Layers" className="card" style={{ flex: compact ? "0 1 440px" : "0 1 480px", minWidth: 320, display: "flex", flexDirection: "column", minHeight: 0 }}>
          <div className="label" style={{ padding: "10px 14px 6px" }}>Layers · bottom first</div>
          <div className="scroll" style={{ flex: "1 1 auto", padding: compact ? "0 4px 6px" : "0 8px 8px", display: "flex", flexDirection: "column", gap: compact ? 1 : 8 }}>
            {stack.layers.map((l) => (
              <LayerCard
                key={l.pr.number} layer={l} stack={stack} current={l === resume} files={filesByLayer[l.index - 1]} compact={compact}
                highlighted={hover === l.index} onHover={(on) => setHover(on ? l.index : null)} onOpen={() => openReview(l)}
              />
            ))}
          </div>
        </section>

        {allLoaded ? (
          <Matrix stack={stack} files={filesByLayer as FileChange[][]} onOpen={openReview} hover={hover} onHover={setHover} />
        ) : (
          <div className="card" style={{ flex: "1 1 auto", padding: 16 }}><Spinner label="Loading files for every layer…" /></div>
        )}
      </div>
    </div>
  );
}

function LayerCard({ layer, stack, current, files, compact, highlighted, onHover, onOpen }: {
  layer: Layer; stack: Stack; current: boolean; files?: FileChange[]; compact: boolean; highlighted: boolean; onHover: (on: boolean) => void; onOpen: () => void;
}) {
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
        onMouseEnter={() => onHover(true)}
        onMouseLeave={() => onHover(false)}
        onFocus={() => onHover(true)}
        onBlur={() => onHover(false)}
        title={firstPara || layer.pr.title}
        style={{ flex: "0 0 auto", display: "flex", gap: 10, alignItems: "center", padding: "6px 10px", borderRadius: 8, textAlign: "left", border: `1px solid ${current ? "var(--accent-soft-bd)" : "transparent"}`, background: highlighted ? "var(--surface-2)" : current ? "#161d28" : "transparent" }}
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
    <button onClick={onOpen} onMouseEnter={() => onHover(true)} onMouseLeave={() => onHover(false)} onFocus={() => onHover(true)} onBlur={() => onHover(false)} className="card" style={{ flex: "0 0 auto", display: "flex", gap: 12, padding: "12px 14px", textAlign: "left", borderColor: current ? "var(--accent-soft-bd)" : undefined, background: highlighted ? "var(--surface-2)" : current ? "#161d28" : undefined }}>
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

function Matrix({ stack, files, onOpen, hover, onHover }: { stack: Stack; files: FileChange[][]; onOpen: (l: Layer, file?: string) => void; hover: number | null; onHover: (n: number | null) => void }) {
  const [sel, setSel] = useState<{ layer: number; path: string } | null>(null);
  const source = useSource();
  // Open agent findings per layer/file, and unresolved review threads (fetched once the files are in).
  const findings = useMemo(() => stack.layers.map((l) => {
    const m = new Map<string, number>();
    for (const f of reviewStore.get(prKey(stack.repo, l.pr.number)).findings) if (f.status === "open") m.set(f.path, (m.get(f.path) ?? 0) + 1);
    return m;
  }), [stack]);
  const threadsQ = useQueries({
    queries: stack.layers.map((l) => ({
      queryKey: ["threads", source.kind, repoKey(stack.repo), l.pr.number],
      queryFn: () => source.threads(stack.repo, l.pr.number),
      staleTime: 60_000,
      retry: false,
    })),
  });
  const threads = threadsQ.map((q) => {
    const m = new Map<string, number>();
    for (const t of q.data ?? []) if (!t.isResolved) m.set(t.path, (m.get(t.path) ?? 0) + 1);
    return m;
  });
  const rows = useMemo(() => {
    const paths = new Map<string, number>();
    files.forEach((list, i) => list.forEach((f) => !paths.has(f.path) && paths.set(f.path, i)));
    return [...paths.keys()].sort((a, b) => paths.get(a)! - paths.get(b)! || a.localeCompare(b));
  }, [files]);
  const cols = stack.layers.length;
  const dense = cols > 12;
  const colW = dense ? 36 : 64;
  const grid = `minmax(260px, 1fr) repeat(${cols}, ${colW}px)`;
  const cell = sel ? files[sel.layer - 1].find((f) => f.path === sel.path) : null;
  const colBg = (n: number) => (hover === n ? "rgba(122,176,255,.07)" : undefined);
  const stickyFile: React.CSSProperties = { position: "sticky", left: 0, zIndex: 1, background: "var(--surface)", paddingRight: 10 };
  return (
    <section aria-label="Files by layer" className="card" style={{ flex: "1 1 auto", minWidth: 0, display: "flex", flexDirection: "column", minHeight: 0 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 12, flexWrap: "wrap", padding: "10px 14px 6px" }}>
        <span className="label">Where the stack touches the code · {rows.length} files</span>
        <span className="muted" style={{ fontSize: 12 }}>Darker = bigger change · ✓ viewed · <span style={{ color: "var(--agent)" }}>●</span> open agent findings · <span style={{ color: "var(--accent)" }}>◆</span> open review threads · <span style={{ color: "var(--bad)" }}>✕</span> failing checks · double-click to open</span>
      </div>
      <div className="scroll" style={{ flex: "1 1 auto", padding: "0 14px 10px" }} onMouseLeave={() => onHover(null)}>
        <div style={{ minWidth: 260 + cols * (colW + 4), display: "flex", flexDirection: "column" }}>
          <div style={{ display: "grid", gridTemplateColumns: grid, gap: 4, fontSize: 12, position: "sticky", top: 0, zIndex: 2, background: "var(--surface)", padding: "4px 0 6px" }} className="muted">
            <span style={stickyFile}>File</span>
            {stack.layers.map((l) => (
              <button
                key={l.pr.number}
                onMouseEnter={() => onHover(l.index)}
                onClick={() => onOpen(l)}
                title={`#${l.pr.number} ${l.pr.title}`}
                style={{ border: 0, padding: "2px 0", borderRadius: 4, background: colBg(l.index) ?? "transparent", color: hover === l.index ? "var(--text)" : "var(--muted)", fontSize: 12, textAlign: "center", fontWeight: hover === l.index ? 600 : 400 }}
              >
                {l.pr.state === "OPEN" && l.pr.checks === "fail" && <span aria-label="checks failing" title="Checks failing" style={{ display: "block", color: "var(--bad)", fontSize: 10, lineHeight: 1 }}>✕</span>}
                {dense ? l.index : <><span style={{ display: "block" }}>{l.index}</span><span className="mono" style={{ display: "block", fontSize: 10.5 }}>#{l.pr.number}</span></>}
              </button>
            ))}
          </div>
          {rows.slice(0, 300).map((path) => (
            <div key={path} style={{ display: "grid", gridTemplateColumns: grid, gap: 4, alignItems: "center", padding: "2px 0" }}>
              <span className="mono" title={path} style={{ ...stickyFile, fontSize: 12, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", display: "flex", gap: 6, minWidth: 0 }}>
                <span style={{ flex: "0 0 auto", color: sel?.path === path ? "var(--accent-soft-fg)" : "var(--text-2)" }}>{path.split("/").pop()}</span>
                <span className="faint" style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis" }}>{path.split("/").slice(0, -1).join("/")}</span>
              </span>
              {stack.layers.map((l, i) => {
                const f = files[i].find((x) => x.path === path);
                if (!f) return <span key={l.pr.number} onMouseEnter={() => onHover(l.index)} style={{ height: 24, borderRadius: 5, background: colBg(l.index) }} />;
                const isSel = sel?.layer === l.index && sel.path === path;
                const nf = findings[i].get(path) ?? 0;
                const nt = threads[i].get(path) ?? 0;
                return (
                  <button
                    key={l.pr.number}
                    onMouseEnter={() => onHover(l.index)}
                    onClick={() => setSel({ layer: l.index, path })}
                    onDoubleClick={() => onOpen(l, path)}
                    aria-label={`${path} in layer ${l.index}, +${f.additions} −${f.deletions}${f.viewed ? ", viewed" : ""}${nf ? `, ${nf} open agent ${nf === 1 ? "finding" : "findings"}` : ""}${nt ? `, ${nt} open ${nt === 1 ? "thread" : "threads"}` : ""}`}
                    style={{ height: 24, display: "flex", alignItems: "center", justifyContent: dense ? "center" : "space-between", gap: 4, padding: "0 6px", borderRadius: 5, border: `1px solid ${isSel ? "var(--accent-soft-fg)" : hover === l.index ? "#3a5a86" : "transparent"}`, background: heat(f.additions + f.deletions), color: "#9be5b8", fontFamily: "var(--mono)", fontSize: 11, overflow: "hidden" }}
                  >
                    {!dense && <span>+{f.additions}</span>}
                    {f.viewed && <span style={{ color: "var(--accent)" }}>✓</span>}
                    {nf > 0 && <span style={{ color: "var(--agent)" }} title={`${nf} open agent findings`}>●{nf > 1 ? nf : ""}</span>}
                    {nt > 0 && <span style={{ color: "var(--accent)" }} title={`${nt} open threads`}>◆{nt > 1 ? nt : ""}</span>}
                  </button>
                );
              })}
            </div>
          ))}
          {rows.length > 300 && <span className="muted" style={{ padding: "6px 0" }}>…and {rows.length - 300} more files</span>}
        </div>
      </div>
      <div style={{ flex: "0 0 auto", borderTop: "1px solid var(--border)", padding: "8px 14px", display: "flex", gap: 10, alignItems: "center", minHeight: 44, whiteSpace: "nowrap" }}>
        {sel && cell ? (
          <>
            <span className="mono" style={{ fontSize: 12, overflow: "hidden", textOverflow: "ellipsis", minWidth: 0 }}>{sel.path}</span>
            <span className="muted">layer {sel.layer} · #{stack.layers[sel.layer - 1].pr.number} · <span className="add">+{cell.additions}</span> <span className="del">−{cell.deletions}</span></span>
            <span className="spacer" />
            <button className="btn btn-sm btn-soft" onClick={() => onOpen(stack.layers[sel.layer - 1], sel.path)}>Open in review →</button>
          </>
        ) : hover ? (
          <span className="muted" style={{ overflow: "hidden", textOverflow: "ellipsis" }}>Layer {hover} · #{stack.layers[hover - 1].pr.number} {stack.layers[hover - 1].pr.title} · {files[hover - 1].length} files</span>
        ) : (
          <span className="muted">Click a cell to see the change, or hover a layer to trace it.</span>
        )}
      </div>
    </section>
  );
}

function CrossLayerNotes({ stack, files, onLayer }: { stack: Stack; files: FileChange[][]; onLayer: (n: number) => void }) {
  const notes: { title: string; body: string; tone: "bad" | "warn" | "plain"; layer: number }[] = [];
  const failing = stack.layers.filter((l) => l.pr.state === "OPEN" && l.pr.checks === "fail");
  if (failing.length) {
    const lowest = failing[0];
    notes.push({ title: `Checks fail from layer ${lowest.index}`, body: failing.length > 1 ? `Layers ${formatRanges(failing.map((l) => l.index))} fail. Start with #${lowest.pr.number}; later failures may share its cause.` : `#${lowest.pr.number} has failing checks.`, tone: "bad", layer: lowest.index });
  }
  const stale = stack.layers.filter((l) => l.mine === "stale");
  if (stale.length) notes.push({ title: `${stale.length} ${stale.length === 1 ? "layer" : "layers"} changed since your review`, body: `Layer ${formatRanges(stale.map((l) => l.index))}. “Since my review” shows only what's new.`, tone: "warn", layer: stale[0].index });
  const churn = new Map<string, number[]>();
  files.forEach((list, i) => list.forEach((f) => churn.set(f.path, [...(churn.get(f.path) ?? []), i + 1])));
  const hot = [...churn.entries()].filter(([, ls]) => ls.length >= 3).sort((a, b) => b[1].length - a[1].length).slice(0, 4);
  for (const [path, ls] of hot) {
    notes.push({ title: `${path.split("/").pop()} · ${ls.length} layers`, body: `Edited in layers ${formatRanges(ls)}. Early findings here may be superseded later.`, tone: "plain", layer: ls[0] });
  }
  if (!notes.length) return null;
  const tone = { bad: ["var(--bad-bd)", "var(--bad-bg)"], warn: ["var(--warn-bd)", "var(--warn-bg)"], plain: ["#252a31", "#14181e"] };
  return (
    <section aria-label="Across layers" style={{ flex: "0 0 auto", display: "flex", gap: 8, alignItems: "stretch", minWidth: 0 }}>
      <span className="label" style={{ flex: "0 0 auto", writingMode: "vertical-rl", transform: "rotate(180deg)", textAlign: "center", padding: "2px 0" }}>Across layers</span>
      <div className="chips-scroll" style={{ flex: "1 1 auto", alignItems: "stretch", gap: 8 }}>
        {notes.map((n) => (
          <button key={n.title} onClick={() => onLayer(n.layer)} title={`Open layer ${n.layer}`} style={{ flex: "0 0 280px", padding: "9px 12px", borderRadius: 10, border: `1px solid ${tone[n.tone][0]}`, background: tone[n.tone][1], lineHeight: 1.45, textAlign: "left", display: "flex", flexDirection: "column", gap: 2, whiteSpace: "normal" }}>
            <strong style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{n.title}</strong>
            <span style={{ color: "var(--text-2)", fontSize: 12.5 }}>{n.body}</span>
          </button>
        ))}
      </div>
    </section>
  );
}
