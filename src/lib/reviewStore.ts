// Per-PR local review state: draft comments (mine and accepted agent findings) and agent findings.
// Persisted locally; nothing here reaches GitHub until the review is submitted.

import { useSyncExternalStore } from "react";
import type { DraftComment, Finding } from "./model";
import { durable } from "./durable";
import { viewerKey } from "./scope";

type PrState = { drafts: DraftComment[]; findings: Finding[]; brief?: { summary: string; readingOrder: string[]; agent: string }; summary?: string; /** Focus-area ids the reviewer ticked ("guide me"); kept across guide refreshes. */ focusDone?: string[] };
type All = Record<string, PrState>;

// One durable row per PR (namespace "review", key "owner/repo#n").
let loaded: All | null = null;
// Lazy: durable state is only filled after initDurable() at startup.
const cur = (): All => (loaded ??= durable.all<PrState>("review"));
const listeners = new Set<() => void>();
const EMPTY: PrState = { drafts: [], findings: [] };

function commit(next: All, changed: string) {
  loaded = next;
  durable.set("review", changed, next[changed]);
  listeners.forEach((l) => l());
}

/** Row key for a PR's local review state: per signed-in login, so accounts never share drafts. */
export const prKey = (repo: { owner: string; repo: string }, number: number) => viewerKey(`${repo.owner}/${repo.repo}#${number}`);

function update(key: string, fn: (s: PrState) => PrState) {
  commit({ ...cur(), [key]: fn(cur()[key] ?? EMPTY) }, key);
}

/** The comment text a finding becomes when drafted, before any edits. */
export function findingDraftBody(f: Finding): string {
  const body = f.suggestion ? `${f.body}\n\n\`\`\`suggestion\n${f.suggestion}\n\`\`\`` : f.body;
  return `**${f.title}**\n\n${body}`;
}

export const reviewStore = {
  get: (key: string): PrState => cur()[key] ?? EMPTY,
  addDraft(key: string, d: Omit<DraftComment, "id">) {
    update(key, (s) => ({ ...s, drafts: [...s.drafts, { ...d, id: crypto.randomUUID() }] }));
  },
  editDraft(key: string, id: string, body: string) {
    update(key, (s) => ({ ...s, drafts: s.drafts.map((d) => (d.id === id ? { ...d, body } : d)) }));
  },
  removeDraft(key: string, id: string) {
    update(key, (s) => {
      const d = s.drafts.find((x) => x.id === id);
      return {
        ...s,
        drafts: s.drafts.filter((x) => x.id !== id),
        findings: s.findings.map((f) => (d?.findingId === f.id ? { ...f, status: "open" } : f)),
      };
    });
  },
  clearDrafts(key: string) {
    update(key, (s) => ({ ...s, drafts: [] }));
  },
  addFinding(key: string, f: Omit<Finding, "id" | "status">): Finding {
    const finding: Finding = { ...f, id: crypto.randomUUID(), status: "open" };
    update(key, (s) => ({ ...s, findings: [...s.findings, finding] }));
    return finding;
  },
  /** Open, dismiss or draft a finding. Drafting creates a pending comment, optionally with edited text. */
  setFindingStatus(key: string, id: string, status: Finding["status"], body?: string) {
    update(key, (s) => {
      const f = s.findings.find((x) => x.id === id);
      if (!f) return s;
      let drafts = s.drafts.filter((d) => d.findingId !== id);
      if (status === "drafted") {
        drafts = [...drafts, { id: crypto.randomUUID(), path: f.path, line: f.line, body: body ?? findingDraftBody(f), source: "agent", findingId: id }];
      }
      return { ...s, drafts, findings: s.findings.map((x) => (x.id === id ? { ...x, status } : x)) };
    });
  },
  setBrief(key: string, brief: PrState["brief"]) {
    update(key, (s) => ({ ...s, brief }));
  },
  setSummary(key: string, summary: string) {
    update(key, (s) => ({ ...s, summary }));
  },
  /** Tick or untick a guide focus area. Ids are hashes of path + title, so they survive a guide refresh. */
  setFocusDone(key: string, id: string, done: boolean) {
    update(key, (s) => {
      const cur = s.focusDone ?? [];
      const next = done ? (cur.includes(id) ? cur : [...cur, id]) : cur.filter((x) => x !== id);
      return { ...s, focusDone: next };
    });
  },
  clearFindings(key: string) {
    update(key, (s) => ({ ...s, findings: [] }));
  },
};

export function useReviewState(key: string): PrState {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => cur()[key] ?? EMPTY,
  );
}
