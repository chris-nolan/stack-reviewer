// Replays a captured snapshot of real GitHub data (see scripts/snapshot.ts). Dev only: writes
// (viewed, replies, reviews) are applied in memory and never sent anywhere.

import type { CheckRun, FileChange, PullRequest, RepoRef, ReviewThread, Stack, Viewer } from "./model";
import { repoKey } from "./model";
import type { DataSource, Inbox, ReviewSubmission } from "./source";

export type Snapshot = {
  capturedAt: string;
  viewer: Viewer;
  orgs: string[];
  inbox: Inbox;
  repoStacks: Record<string, Stack[]>;
  stacks: Record<string, Stack>;
  files: Record<string, FileChange[]>;
  threads: Record<string, ReviewThread[]>;
  checks: Record<string, CheckRun[]>;
  logs: Record<string, string>;
  texts?: Record<string, string | null>;
};

const missing = (what: string) => Promise.reject(new Error(`Not in the snapshot: ${what}. Re-run scripts/snapshot.ts to capture it.`));

export class SnapshotSource implements DataSource {
  readonly kind = "fixtures" as const;
  readonly label = "snapshot";
  constructor(private s: Snapshot) {}

  static async load(): Promise<SnapshotSource> {
    const res = await fetch("/dev-data/snapshot.json", { cache: "no-store" });
    if (!res.ok) throw new Error("No snapshot found. Run: GH_TOKEN=$(gh auth token) bun scripts/snapshot.ts <org> <owner/repo>");
    return new SnapshotSource(await res.json());
  }

  viewer() { return Promise.resolve(this.s.viewer); }
  orgs() { return Promise.resolve(this.s.orgs); }
  teams() { return Promise.resolve(this.s.viewer.teams ?? []); }
  inbox(): Promise<Inbox> { return Promise.resolve(this.s.inbox); }
  orgRepos() {
    return Promise.resolve(Object.keys(this.s.repoStacks).map((k) => ({ repo: { owner: k.split("/")[0], repo: k.split("/")[1] }, pushedAt: this.s.capturedAt })));
  }
  repoStacks(r: RepoRef, opts: { includeSingles: boolean }) {
    const list = this.s.repoStacks[repoKey(r)];
    return list ? Promise.resolve(list.filter((x) => opts.includeSingles || x.source !== "single")) : missing(`stacks for ${repoKey(r)}`);
  }
  stack(r: RepoRef, key: string) {
    const s = this.s.stacks[`${repoKey(r)}#${key}`] ?? this.s.repoStacks[repoKey(r)]?.find((x) => x.key === key);
    return s ? Promise.resolve(s) : missing(`stack ${key}`);
  }
  pullRequest(r: RepoRef, n: number): Promise<PullRequest> {
    for (const s of Object.values(this.s.stacks)) {
      const l = s.layers.find((x) => repoKey(s.repo) === repoKey(r) && x.pr.number === n);
      if (l) return Promise.resolve(l.pr);
    }
    return missing(`PR #${n}`);
  }
  files(r: RepoRef, pr: PullRequest) {
    const f = this.s.files[`${repoKey(r)}#${pr.number}`];
    return f ? Promise.resolve(f) : missing(`files of #${pr.number}`);
  }
  compare() { return Promise.resolve([]); }
  fileText(r: RepoRef, ref: string, path: string) { return Promise.resolve(this.s.texts?.[`${repoKey(r)}@${ref}:${path}`] ?? null); }
  gitToken() { return null; }
  threads(r: RepoRef, n: number) { return Promise.resolve(this.s.threads[`${repoKey(r)}#${n}`] ?? []); }
  checks(r: RepoRef, sha: string) { return Promise.resolve(this.s.checks[`${repoKey(r)}@${sha}`] ?? []); }
  jobLog(r: RepoRef, id: number) {
    const l = this.s.logs[`${repoKey(r)}/${id}`];
    return l != null ? Promise.resolve(l) : missing("this job's log");
  }
  rerunJob() { return Promise.resolve(); }
  setViewed(prId: string, path: string, viewed: boolean) {
    for (const [k, list] of Object.entries(this.s.files)) {
      const pr = Object.values(this.s.stacks).flatMap((s) => s.layers).find((l) => l.pr.id === prId);
      if (pr && k.endsWith(`#${pr.pr.number}`)) list.forEach((f) => f.path === path && (f.viewed = viewed));
    }
    return Promise.resolve();
  }
  submitReview(_r: RepoRef, _n: number, _review: ReviewSubmission) { return Promise.resolve(); }
  replyToThread() { return Promise.resolve(); }
  setThreadResolved() { return Promise.resolve(); }
}
