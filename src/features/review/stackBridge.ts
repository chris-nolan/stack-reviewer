// Implements the agent review tools for one stack. It works on any layer (not just the one on
// screen) and shares React Query's cache with the UI, so tools and screens see the same data.

import { useEffect, useRef } from "react";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useSource } from "../../app/session";
import { guideStore } from "../../lib/guideStore";
import { validateLayerGuide, validateStackGuide } from "../../lib/guide";
import { reviewBridge, type FindingInput, type ReviewBridge } from "../../agent/bridge";
import { commentableLines, parsePatch } from "../../lib/diff";
import { failureExcerpt } from "../../lib/logs";
import type { Layer, Stack } from "../../lib/model";
import { repoKey } from "../../lib/model";
import { prKey, reviewStore } from "../../lib/reviewStore";
import type { DataSource } from "../../lib/source";
import { formatRanges } from "../../lib/stacks";
import { checkRunState } from "../../ui/bits";

export function registerStackBridge(stackId: string, source: DataSource, qc: QueryClient, getStack: () => Stack) {
  const repo = () => getStack().repo;
  const layerOf = (pr: number): Layer | undefined => getStack().layers.find((l) => l.pr.number === pr);
  const files = (l: Layer) =>
    qc.fetchQuery({ queryKey: ["files", source.kind, repoKey(repo()), l.pr.number, l.pr.headSha], queryFn: () => source.files(repo(), l.pr), staleTime: 5 * 60_000 });
  const threads = (l: Layer) =>
    qc.fetchQuery({ queryKey: ["threads", source.kind, repoKey(repo()), l.pr.number], queryFn: () => source.threads(repo(), l.pr.number), staleTime: 60_000 });
  const checks = (l: Layer) =>
    qc.fetchQuery({ queryKey: ["checks", source.kind, repoKey(repo()), l.pr.headSha], queryFn: () => source.checks(repo(), l.pr.headSha), staleTime: 30_000 });

  const bridge: ReviewBridge = {
    async context(pr) {
      guideStore.markReading(stackId, pr);
      const stack = getStack();
      const layer = layerOf(pr);
      if (!layer) return { error: `PR #${pr} is not part of this stack.` };
      const [fs, ts, cs] = await Promise.all([files(layer), threads(layer).catch(() => []), checks(layer).catch(() => [])]);
      const findings = reviewStore.get(prKey(stack.repo, pr)).findings;
      return {
        repository: repoKey(stack.repo),
        stack: {
          title: stack.title, kind: stack.source, base_branch: stack.baseRef,
          layers: stack.layers.map((l) => ({ index: l.index, pr: l.pr.number, title: l.pr.title, author: l.pr.author, state: l.pr.state, head_branch: l.pr.headRef, base_branch: l.pr.baseRef, checks: l.pr.checks })),
        },
        current_layer: {
          index: layer.index, pr, title: layer.pr.title, author: layer.pr.author, url: layer.pr.url,
          description: layer.pr.body.slice(0, 4000), base_sha: layer.pr.baseSha, head_sha: layer.pr.headSha,
          diff_command: layer.pr.baseSha ? `git diff ${layer.pr.baseSha}...HEAD` : `git diff refs/sr/base/${pr}...HEAD`,
          files: fs.map((f) => ({ path: f.path, status: f.status, additions: f.additions, deletions: f.deletions })),
        },
        open_review_threads: ts.filter((t) => !t.isResolved).map((t) => ({ path: t.path, line: t.line, comments: t.comments.map((c) => `${c.author}: ${c.body}`) })),
        checks: cs.map((c) => ({ name: c.name, state: checkRunState(c) })),
        findings_already_recorded: findings.filter((f) => f.status !== "dismissed").map((f) => ({ path: f.path, line: f.line, title: f.title })),
      };
    },

    async addFinding(pr, f: FindingInput, agent) {
      const layer = layerOf(pr);
      if (!layer) return { ok: false, error: `PR #${pr} is not part of this stack.` };
      const fs = await files(layer);
      const file = fs.find((x) => x.path === f.path);
      if (!file) return { ok: false, error: `${f.path} is not changed in #${pr}. Changed files: ${fs.map((x) => x.path).join(", ")}` };
      const lines = commentableLines(parsePatch(file.patch));
      if (!lines.has(Number(f.line))) {
        return { ok: false, error: `Line ${f.line} of ${f.path} is not in the diff of #${pr}. Use one of: ${formatRanges([...lines]) || "(no commentable lines)"}` };
      }
      const severity = (["High", "Medium", "Low"] as const).includes(f.severity) ? f.severity : "Medium";
      const created = reviewStore.addFinding(prKey(getStack().repo, pr), {
        pr, path: f.path, line: Number(f.line), severity, title: String(f.title).slice(0, 140), body: String(f.body ?? ""),
        suggestion: f.suggestion || undefined, agent,
      });
      return { ok: true, id: created.id.slice(0, 8) };
    },

    setBrief(pr, summary, readingOrder, agent) {
      reviewStore.setBrief(prKey(getStack().repo, pr), { summary, readingOrder, agent });
    },

    setSummary(pr, text) {
      reviewStore.setSummary(prKey(getStack().repo, pr), text);
    },

    async setLayerGuide(pr, input, agent) {
      const layer = layerOf(pr);
      if (!layer) return { ok: false, error: `PR #${pr} is not part of this stack.` };
      if (layer.pr.state !== "OPEN") return { ok: false, error: `#${pr} is ${layer.pr.state.toLowerCase()}; only open layers are guided.` };
      const v = validateLayerGuide(input, pr, layer.pr.headSha, await files(layer));
      if (!v.ok) return { ok: false, error: v.error };
      const { summary, ...guide } = v.value;
      guideStore.setLayer(stackId, { ...guide, agent, createdAt: Date.now() });
      // The layer summary also feeds the brief card (no reading order from a guide).
      reviewStore.setBrief(prKey(getStack().repo, pr), { summary, readingOrder: [], agent });
      return { ok: true, id: `#${pr} (${guide.tier}, ${guide.focus.length} focus areas)` };
    },

    async setStackGuide(input, agent) {
      const open = getStack().layers.filter((l) => l.pr.state === "OPEN").map((l) => l.pr.number);
      const doc = guideStore.get(stackId);
      const guided = open.filter((n) => doc.layers[n]);
      const v = validateStackGuide(input, open, guided);
      if (!v.ok) return { ok: false, error: v.error };
      guideStore.setStack(stackId, { ...v.value, agent, createdAt: Date.now() });
      return { ok: true, id: `ranked ${v.value.ranking.length} layers` };
    },

    async checkFailures(pr) {
      const layer = layerOf(pr);
      if (!layer) return `PR #${pr} is not part of this stack.`;
      const cs = await source.checks(repo(), layer.pr.headSha);
      const failing = cs.filter((c) => checkRunState(c) === "fail");
      if (!failing.length) return `No failing checks on #${pr}.`;
      const parts = await Promise.all(failing.slice(0, 4).map(async (c) => {
        if (!c.isActions) return `## ${c.name}\n(not a GitHub Actions job; no log available)`;
        try {
          const ex = failureExcerpt(await source.jobLog(repo(), c.id), 80);
          return `## ${c.name}\n${ex.lines.join("\n")}`;
        } catch (e) {
          return `## ${c.name}\n(log unavailable: ${e instanceof Error ? e.message : e})`;
        }
      }));
      return `Failing checks on #${pr}:\n\n${parts.join("\n\n")}`;
    },
  };
  reviewBridge.set(stackId, bridge);
}

/** Registers this stack's agent tools while the caller is mounted (and after: bridges outlive screens). */
export function useStackBridge(stack: Stack) {
  const source = useSource();
  const qc = useQueryClient();
  const ref = useRef(stack);
  ref.current = stack;
  const stackId = `${repoKey(stack.repo)}#${stack.key}`;
  useEffect(() => {
    registerStackBridge(stackId, source, qc, () => ref.current);
  }, [stackId, source, qc]);
}
