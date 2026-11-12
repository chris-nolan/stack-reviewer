import { useEffect, useRef, useState } from "react";
import { useJobLog } from "../../app/queries";
import { useSource } from "../../app/session";
import type { CheckRun, DraftComment, Layer, RepoRef, ReviewEvent } from "../../lib/model";
import { failureExcerpt } from "../../lib/logs";
import { checkRunState, CHECK_STYLE, ErrorBox, Spinner } from "../../ui/bits";

function Modal({ label, onClose, children, width = 560 }: { label: string; onClose: () => void; children: React.ReactNode; width?: number }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    ref.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      prev?.focus?.();
    };
  }, [onClose]);
  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(5,6,8,.55)", display: "grid", placeItems: "start center", paddingTop: "10vh", zIndex: 50 }}>
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-label={label}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
        style={{ width: `min(${width}px, calc(100% - 32px))`, maxHeight: "78vh", overflow: "auto", padding: 18, borderRadius: 14, border: "1px solid var(--border-strong)", background: "var(--surface-3)", boxShadow: "0 24px 70px rgba(0,0,0,.6)", display: "flex", flexDirection: "column", gap: 12 }}
      >
        {children}
      </div>
    </div>
  );
}

export function FinishDialog({
  layer, drafts, viewed, total, openFindings, nextLayer, summary, isOwn, onClose, onSubmit,
}: {
  layer: Layer; drafts: DraftComment[]; viewed: number; total: number; openFindings: number; nextLayer: Layer | null; summary: string;
  isOwn: boolean; onClose: () => void; onSubmit: (event: ReviewEvent, body: string) => Promise<void>;
}) {
  const isMine = isOwn; // GitHub only allows comment reviews on your own PRs
  const [event, setEvent] = useState<ReviewEvent>(isOwn ? "COMMENT" : drafts.length ? "REQUEST_CHANGES" : "APPROVE");
  const [body, setBody] = useState(summary);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  useEffect(() => setBody((b) => b || summary), [summary]);
  const needsBody = event !== "APPROVE" && !drafts.length && !body.trim();
  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await onSubmit(event, body.trim());
    } catch (e) {
      setError(e);
      setBusy(false);
    }
  };
  return (
    <Modal label={`Finish #${layer.pr.number}`} onClose={onClose}>
      <strong style={{ fontSize: 15 }}>Finish #{layer.pr.number}</strong>
      <div style={{ display: "flex", flexDirection: "column", gap: 4, color: "var(--text-2)" }}>
        <span>{viewed} of {total} files viewed</span>
        <span>{drafts.length} draft {drafts.length === 1 ? "comment" : "comments"} will be published</span>
        {openFindings > 0 && <span className="muted">{openFindings} agent {openFindings === 1 ? "finding" : "findings"} not triaged (they stay private)</span>}
      </div>
      <fieldset style={{ border: 0, padding: 0, margin: 0, display: "flex", gap: 8, flexWrap: "wrap" }}>
        <legend className="sr-only">Verdict</legend>
        {([["COMMENT", "Comment"], ["APPROVE", "Approve"], ["REQUEST_CHANGES", "Request changes"]] as const).map(([v, label]) => (
          <label key={v} style={{ display: "flex", gap: 6, alignItems: "center", padding: "8px 12px", borderRadius: 8, border: `1px solid ${event === v ? "var(--accent-soft-bd)" : "var(--border-strong)"}`, background: event === v ? "var(--accent-soft-bg)" : "transparent" }}>
            <input type="radio" name="verdict" checked={event === v} onChange={() => setEvent(v)} disabled={isMine && v !== "COMMENT"} /> {label}
          </label>
        ))}
      </fieldset>
      <label htmlFor="summary" className="muted" style={{ fontSize: 12 }}>Summary{summary ? " (drafted by the agent, so edit freely)" : ""}</label>
      <textarea id="summary" className="input" rows={4} value={body} onChange={(e) => setBody(e.target.value)} />
      {error != null && <ErrorBox error={error} />}
      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", flexWrap: "wrap" }}>
        <button className="btn" onClick={onClose}>Keep reviewing</button>
        <button className="btn btn-primary" disabled={busy || needsBody} onClick={submit} title={needsBody ? "Add a summary or a comment" : undefined}>
          {busy ? "Submitting…" : nextLayer ? `Submit and go to #${nextLayer.pr.number} →` : "Submit review"}
        </button>
      </div>
    </Modal>
  );
}

export function ChecksDialog({ repo, checks, initial, onClose }: { repo: RepoRef; checks: CheckRun[]; initial: number | null; onClose: () => void }) {
  const source = useSource();
  const failing = checks.filter((c) => checkRunState(c) === "fail");
  const [sel, setSel] = useState<number | null>(initial ?? failing.find((c) => c.isActions)?.id ?? null);
  const selected = checks.find((c) => c.id === sel) ?? null;
  const log = useJobLog(repo, selected?.isActions ? selected.id : null);
  const [rerun, setRerun] = useState<"idle" | "busy" | "done" | Error>("idle");
  const excerpt = log.data ? failureExcerpt(log.data) : null;
  const sorted = [...checks].sort((a, b) => ["fail", "pending", "pass", "none"].indexOf(checkRunState(a)) - ["fail", "pending", "pass", "none"].indexOf(checkRunState(b)));
  return (
    <Modal label="Checks" onClose={onClose} width={900}>
      <strong style={{ fontSize: 15 }}>Checks</strong>
      <div style={{ display: "flex", gap: 12, flexWrap: "wrap", minHeight: 0 }}>
        <div style={{ flex: "1 1 240px", maxWidth: 300, display: "flex", flexDirection: "column", gap: 4 }}>
          {sorted.map((c) => {
            const st = CHECK_STYLE[checkRunState(c)];
            return (
              <button key={c.id} onClick={() => setSel(c.id)} style={{ display: "flex", gap: 8, alignItems: "center", padding: "8px 10px", borderRadius: 8, border: `1px solid ${sel === c.id ? "var(--accent-soft-bd)" : "var(--border)"}`, background: sel === c.id ? "var(--accent-soft-bg)" : "var(--surface-2)", textAlign: "left" }}>
                <span style={{ color: st.color, fontWeight: 700 }} aria-label={st.word}>{st.glyph}</span>
                <span style={{ flex: "1 1 auto", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{c.name}</span>
              </button>
            );
          })}
        </div>
        <div style={{ flex: "999 1 420px", minWidth: 0, display: "flex", flexDirection: "column", gap: 8 }}>
          {!selected ? <p className="muted">Pick a check.</p> : (
            <>
              <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                <strong>{selected.name}</strong>
                <span className="muted">{selected.conclusion ?? selected.status}</span>
                <span className="spacer" />
                {selected.isActions && checkRunState(selected) === "fail" && (
                  <button className="btn btn-sm" disabled={rerun === "busy" || rerun === "done"} onClick={async () => {
                    setRerun("busy");
                    try { await source.rerunJob(repo, selected.id); setRerun("done"); } catch (e) { setRerun(e as Error); }
                  }}>{rerun === "done" ? "Re-run requested" : rerun === "busy" ? "Requesting…" : "Re-run job"}</button>
                )}
                {selected.detailsUrl && <a className="btn btn-sm" href={selected.detailsUrl} target="_blank" rel="noreferrer">Open on GitHub</a>}
              </div>
              {rerun instanceof Error && <ErrorBox error={rerun} />}
              {!selected.isActions ? <p className="muted">Logs are only available for GitHub Actions jobs.</p>
                : log.isPending ? <Spinner label="Fetching log…" />
                : log.error ? <ErrorBox error={log.error} />
                : excerpt && (
                  <pre style={{ margin: 0, padding: 12, borderRadius: 8, background: "#0f1115", border: "1px solid var(--border)", fontSize: 12, lineHeight: 1.6, color: "var(--del-fg)", whiteSpace: "pre-wrap", maxHeight: "52vh", overflow: "auto" }}>
                    {excerpt.truncated && <span className="muted">…{"\n"}</span>}
                    {excerpt.lines.join("\n")}
                  </pre>
                )}
            </>
          )}
        </div>
      </div>
    </Modal>
  );
}
