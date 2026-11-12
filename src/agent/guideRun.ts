// Runs "guide me" for a stack: sends the prompt to the stack's agent chat, tracks the run
// (queued → reading → guided per layer) and handles Stop / Continue / Refresh.
// In ?demo there is no agent, so a simulated run feeds the fixture guide through the same tools.

import { useCallback, useEffect } from "react";
import { useNav } from "../app/nav";
import { useSession, useSource } from "../app/session";
import { demoGuide } from "../lib/guideFixtures";
import { guideTargets, type GuideDoc, type GuideRun } from "../lib/guide";
import { guideStore, useGuide } from "../lib/guideStore";
import type { Layer, Stack } from "../lib/model";
import { local } from "../lib/platform";
import { reviewBridge } from "./bridge";
import { getAgentSession, guideRefreshPrompt, guideStackPrompt, type AgentSession } from "./session";
import { stackIdOf, useStackAgent } from "./useStackAgent";

export type GuideLaunch = {
  agentId: string;
  agentName: string;
  model?: string;
  effort?: string;
  mode: "all" | "refresh" | "continue";
  /** Demo only: apply instantly, or stop after this many layers so a "running" state stays on screen. */
  demo?: { instant?: boolean; holdAfter?: number };
};

// Sessions with a guide run in flight, so Stop works from any screen.
const g = globalThis as typeof globalThis & { __srGuideSessions?: Map<string, AgentSession>; __srGuideDemo?: Map<string, { cancelled: boolean }> };
const activeSessions = (g.__srGuideSessions ??= new Map());
const demoRuns = (g.__srGuideDemo ??= new Map());

/** The agent last used in this app (the dock's choice), for runs started without the launcher. */
export function lastAgent(): { agentId: string; agentName: string } {
  const agentId = local.get<string>("agent", "claude");
  return { agentId, agentName: agentId === "gemini" ? "Gemini CLI" : agentId === "claude" ? "Claude Code" : agentId };
}

const info = (l: Layer) => ({ index: l.index, number: l.pr.number, title: l.pr.title });

/** Which layers a run of this kind guides, in bottom-up order. */
export function layersFor(stack: Stack, doc: GuideDoc, mode: GuideLaunch["mode"]): Layer[] {
  const open = stack.layers.filter((l) => l.pr.state === "OPEN");
  if (mode === "all") return open;
  if (mode === "continue") {
    const pending = new Set(doc.run?.pending ?? []);
    return open.filter((l) => pending.has(l.pr.number));
  }
  const t = guideTargets(doc, stack.layers);
  const want = new Set([...t.stale, ...t.missing]);
  return open.filter((l) => want.has(l.pr.number));
}

export function useGuideRun(stack: Stack) {
  const source = useSource();
  const login = useSession().viewer?.login ?? "";
  const { go } = useNav();
  const { ensureRunning, prefetch, preparing } = useStackAgent(stack);
  const stackId = stackIdOf(stack);
  const doc = useGuide(stackId);

  const start = useCallback(
    async (o: GuideLaunch) => {
      const current = guideStore.get(stackId);
      const targets = layersFor(stack, current, o.mode);
      if (!targets.length) return;
      const kind: GuideRun["kind"] = o.mode === "all" ? "all" : o.mode === "refresh" ? "refresh" : "continue";
      const pending = targets.map((l) => l.pr.number);
      const session = source.kind === "fixtures" ? null : getAgentSession(login, stackId, o.agentId, o.agentName);
      // One prompt at a time per chat: never start a guide over a turn that is still running.
      if (session?.getSnapshot().status === "busy") {
        session.notice("The guide didn't start: this chat is busy. Wait for the current reply or stop it, then try again.", "error");
        return;
      }
      if (session) {
        if (o.model) await session.setSetting("model", o.model);
        if (o.effort) await session.setSetting("effort", o.effort);
      }
      guideStore.startRun(stackId, { pending, total: pending.length, kind, agent: session?.label() ?? "Claude Code · Opus 5.5 · high" });
      local.set("agent", o.agentId);

      if (!session) return simulate(stack, stackId, pending, o);

      activeSessions.set(stackId, session);
      try {
        await ensureRunning(session, targets[0]);
        // Fetch every target layer up front so the agent never has to ask to run `git fetch`.
        const local = await prefetch(targets);
        const open = stack.layers.filter((l) => l.pr.state === "OPEN");
        const kept = open
          .filter((l) => !pending.includes(l.pr.number) && current.layers[l.pr.number])
          .map((l) => ({ number: l.pr.number, tier: current.layers[l.pr.number].tier, reason: current.layers[l.pr.number].tierReason, role: current.stack?.layerRoles.find((r) => r.pr === l.pr.number)?.role }));
        const prompt = o.mode === "all" ? guideStackPrompt(targets.map(info), { local }) : guideRefreshPrompt(targets.map(info), kept, { resume: o.mode === "continue", local });
        const display = o.mode === "all" ? "Guide me through the stack" : o.mode === "refresh" ? "Refresh the guide" : "Continue the guide";
        await session.send(prompt, display, { guide: true });
        const d = guideStore.get(stackId);
        if (d.run?.status === "running") {
          if (d.run.pending.length) guideStore.finishRun(stackId, session.getSnapshot().status === "error" ? "error" : "stopped", `The agent stopped with ${d.run.pending.length} ${d.run.pending.length === 1 ? "layer" : "layers"} unguided.`);
          else if (!d.stack || d.stack.createdAt < d.run.startedAt) guideStore.finishRun(stackId, "error", "The agent finished without writing the stack guide.");
          else guideStore.finishRun(stackId, "done");
        }
      } catch (e) {
        guideStore.finishRun(stackId, "error", e instanceof Error ? e.message : String(e));
      } finally {
        activeSessions.delete(stackId);
      }
    },
    [stack, stackId, login, source, ensureRunning, prefetch],
  );

  // ?demo&guide=1 shows a finished guide (with two layers out of date); ?demo&guide=running freezes a run mid-way.
  useEffect(() => {
    const want = source.kind === "fixtures" ? new URLSearchParams(window.location.search).get("guide") : null;
    const d = guideStore.get(stackId);
    if (!want || d.run || Object.keys(d.layers).length) return;
    void (async () => {
      const agent = { agentId: "claude", agentName: "Claude Code", mode: "all" as const };
      if (want === "running") return start({ ...agent, demo: { instant: true, holdAfter: 2 } });
      await start({ ...agent, demo: { instant: true } });
      const open = stack.layers.filter((l) => l.pr.state === "OPEN");
      for (const l of new Set([open[3], open[open.length - 2]])) {
        const g = guideStore.get(stackId).layers[l?.pr.number];
        if (g) guideStore.setLayer(stackId, { ...g, headSha: "older-head" });
      }
    })();
  }, [source, stackId, start, stack]);

  const stop = useCallback(() => {
    const demo = demoRuns.get(stackId);
    if (demo) demo.cancelled = true;
    activeSessions.get(stackId)?.cancel();
    guideStore.finishRun(stackId, "stopped");
  }, [stackId]);

  /** Opens the review page with the agent dock showing the guide conversation. */
  const viewChat = useCallback(() => {
    local.set("dockOpen", true);
    const open = stack.layers.find((l) => l.pr.state === "OPEN") ?? stack.layers[0];
    go({ name: "review", repo: stack.repo, stackKey: stack.key, layer: open.index });
  }, [stack, go]);

  return { doc, start, stop, viewChat, preparing, stackId };
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Demo: feeds the fixture guide through the real bridge (so validation runs) with realistic pacing. */
async function simulate(stack: Stack, stackId: string, pending: number[], o: GuideLaunch) {
  const fix = demoGuide(stack.layers.map((l) => l.pr.number));
  const tok = { cancelled: false };
  demoRuns.set(stackId, tok);
  const fail = (msg: string) => guideStore.finishRun(stackId, "error", msg);
  const b = reviewBridge.get(stackId);
  if (!fix || !b) return fail("No demo guide for this stack.");
  const agent = guideStore.get(stackId).run?.agent ?? "Claude Code";
  const pace = o.demo?.instant ? 0 : 1100;
  let done = 0;
  for (const pr of pending) {
    if (o.demo?.holdAfter != null && done >= o.demo.holdAfter) {
      guideStore.markReading(stackId, pr);
      return; // leave the run "running" for screenshots; Stop still works
    }
    guideStore.markReading(stackId, pr);
    await wait(pace);
    if (tok.cancelled) return;
    const r = await b.setLayerGuide(pr, fix.layers[pr], agent);
    if (!r.ok) return fail(r.error);
    done++;
  }
  await wait(pace);
  if (tok.cancelled) return;
  const r = await b.setStackGuide(fix.stack, agent);
  if (!r.ok) return fail(r.error);
  demoRuns.delete(stackId);
}
