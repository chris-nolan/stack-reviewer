// Starting a stack's agent (checkout + session) and registering its tools, shared by the review
// page's dock and the overview's "Guide me", so a guide can run without opening the review page.

import { useCallback, useState } from "react";
import { useSource } from "../app/session";
import { useStackBridge } from "../features/review/stackBridge";
import type { Layer, Stack } from "../lib/model";
import { invoke } from "../lib/platform";
import type { AgentSession } from "./session";

type Worktree = { path: string; head: string; base: string };

export const stackIdOf = (stack: Pick<Stack, "repo" | "key">) => `${stack.repo.owner}/${stack.repo.repo}#${stack.key}`;

export function useStackAgent(stack: Stack) {
  const source = useSource();
  useStackBridge(stack);
  const [preparing, setPreparing] = useState<string | null>(null);

  /** One checkout per stack (and agent) that moves to whichever layer the conversation is on. */
  const ensureRunning = useCallback(
    async (session: AgentSession, layer: Layer) => {
      const token = source.gitToken();
      if (!token) throw new Error("Agents need a real GitHub sign-in (demo data has no code to read).");
      const slot = `${stack.key}-${session.agentId}`.replace(/[^A-Za-z0-9_-]/g, "-").slice(0, 64);
      const here = session.getSnapshot().layer;
      const needCheckout = !session.running || !here || here.headSha !== layer.pr.headSha;
      try {
        if (needCheckout) {
          setPreparing(session.running ? `Moving the checkout to layer ${layer.index}…` : "Checking out this layer…");
          const wt = await invoke<Worktree>("worktree_prepare", {
            token, owner: stack.repo.owner, repo: stack.repo.repo, number: layer.pr.number, headSha: layer.pr.headSha, baseRef: layer.pr.baseRef, slot,
          });
          if (!session.running) {
            setPreparing(`Starting ${session.agentName}…`);
            await session.start(wt.path);
          }
        }
        session.moveTo({ index: layer.index, total: stack.layers.length, pr: layer.pr.number, title: layer.pr.title, headSha: layer.pr.headSha, baseSha: layer.pr.baseSha });
      } finally {
        setPreparing(null);
      }
    },
    [source, stack],
  );

  return { ensureRunning, preparing };
}
