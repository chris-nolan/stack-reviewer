// Starting a stack's agent (checkout + session) and registering its tools, shared by the review
// page's dock and the overview's "Guide me", so a guide can run without opening the review page.

import { useCallback, useState } from "react";
import { useSession, useSource } from "../app/session";
import { useStackBridge } from "../features/review/stackBridge";
import type { Layer, Stack } from "../lib/model";
import { invoke } from "../lib/platform";
import type { AgentSession } from "./session";

/** One checkout slot per account, stack and agent, so two accounts never share a working tree. */
export const worktreeSlot = (login: string, stackKey: string, agentId: string) =>
  `${login}-${agentId}-${stackKey}`.replace(/[^A-Za-z0-9_-]/g, "-").slice(0, 64);

type Worktree = { path: string; head: string; base: string };

export const stackIdOf = (stack: Pick<Stack, "repo" | "key">) => `${stack.repo.owner}/${stack.repo.repo}#${stack.key}`;

export function useStackAgent(stack: Stack) {
  const source = useSource();
  const login = useSession().viewer?.login ?? "";
  useStackBridge(stack);
  const [preparing, setPreparing] = useState<string | null>(null);

  /** One checkout per stack (and agent) that moves to whichever layer the conversation is on. */
  const ensureRunning = useCallback(
    async (session: AgentSession, layer: Layer) => {
      const token = source.gitToken();
      if (!token) throw new Error("Agents need a real GitHub sign-in (demo data has no code to read).");
      const slot = worktreeSlot(login, stack.key, session.agentId);
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
    [source, stack, login],
  );

  /**
   * Fetches these layers' commits and the blobs their diffs read into the stack's clone, with the app's
   * credentials, so a whole-stack run reads diffs locally instead of asking to run `git fetch`.
   * Returns the PRs that are ready; never throws (the agent can still fetch for itself).
   */
  const prefetch = useCallback(
    async (layers: Layer[]): Promise<number[]> => {
      const token = source.gitToken();
      if (!token || !layers.length) return [];
      setPreparing(`Fetching ${layers.length} ${layers.length === 1 ? "layer" : "layers"} into the checkout…`);
      try {
        const r = await invoke<{ ready: number[]; warnings: string[] }>("repo_prefetch", {
          token, owner: stack.repo.owner, repo: stack.repo.repo,
          layers: layers.map((l) => ({ number: l.pr.number, headSha: l.pr.headSha, baseSha: l.pr.baseSha })),
        });
        if (r.warnings.length) console.warn("prefetch", r.warnings);
        return r.ready;
      } catch (e) {
        console.warn("prefetch failed", e);
        return [];
      } finally {
        setPreparing(null);
      }
    },
    [source, stack],
  );

  return { ensureRunning, prefetch, preparing };
}
