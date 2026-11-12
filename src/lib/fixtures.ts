// In-memory demo data source (the "Rate limiting" stack from the UX prototype).
// Used in a plain browser and for the "Try with demo data" option on the sign-in screen.

import type { CheckRun, FileChange, PullRequest, RepoRef, ReviewThread, Stack, Viewer } from "./model";
import type { DataSource, Inbox, ReviewSubmission } from "./source";
import { buildStacks } from "./stacks";

const ME = "you";
const repo: RepoRef = { owner: "acme", repo: "orders-api" };
const ago = (h: number) => new Date(Date.now() - h * 3600_000).toISOString();

function pr(n: number, title: string, base: string, head: string, extra: Partial<PullRequest>): PullRequest {
  return {
    id: `PR_${n}`, number: n, title, body: "", url: `https://github.com/acme/orders-api/pull/${n}`,
    author: "alex-r", isDraft: false, state: "OPEN", baseRef: base, headRef: head, headSha: `sha${n}b`,
    additions: 0, deletions: 0, changedFiles: 0, updatedAt: ago(2), createdAt: ago(72),
    reviewDecision: "REVIEW_REQUIRED", checks: "pass", requestedReviewers: [ME], latestReviews: [], assignees: [],
    ...extra,
  };
}

const PRS: PullRequest[] = [
  pr(412, "feat(limiter): add token bucket limiter core", "main", "alex-r/limiter-core", {
    body: "Adds a `TokenBucket` class with capacity and refill rate, plus unit tests. No callers yet.",
    additions: 142, changedFiles: 3, requestedReviewers: [], latestReviews: [{ author: ME, state: "APPROVED", commit: "sha412b" }],
  }),
  pr(413, "Wire limiter into request middleware", "alex-r/limiter-core", "alex-r/limiter-middleware", {
    body: "Mounts the token bucket from #412 as Express middleware, keyed by client IP. Limits come from the new `rateLimit` config block. Per-tenant limits follow in #415.",
    additions: 43, deletions: 1, changedFiles: 4, checks: "fail",
  }),
  pr(415, "Per-tenant limits from config", "alex-r/limiter-middleware", "alex-r/tenant-limits", {
    body: "Looks limits up per tenant header, falling back to the global default.",
    additions: 88, deletions: 21, changedFiles: 5, checks: "pending", requestedReviewers: [],
    latestReviews: [{ author: ME, state: "COMMENTED", commit: "sha415a" }],
  }),
  pr(416, "Expose limiter metrics", "alex-r/tenant-limits", "alex-r/limiter-metrics", { additions: 57, deletions: 2, changedFiles: 3 }),
  pr(418, "Docs and Grafana dashboard", "alex-r/limiter-metrics", "alex-r/limiter-docs", { additions: 210, changedFiles: 2 }),
  pr(388, "Invoice export panel", "main", "priya-k/invoice-panel", { author: "priya-k", additions: 320, changedFiles: 9, updatedAt: ago(26) }),
  pr(389, "Invoice export: CSV column picker", "priya-k/invoice-panel", "priya-k/invoice-columns", { author: "priya-k", additions: 96, changedFiles: 3, updatedAt: ago(24) }),
  pr(402, "Rotate service tokens nightly", "main", "you/token-rotation", { author: ME, requestedReviewers: ["priya-k"], additions: 80, changedFiles: 4, reviewDecision: "CHANGES_REQUESTED", updatedAt: ago(3) }),
  pr(403, "Token rotation: alert on failure", "you/token-rotation", "you/token-alerts", { author: ME, requestedReviewers: ["priya-k"], additions: 30, changedFiles: 2, updatedAt: ago(3) }),
];

const FILES: Record<number, FileChange[]> = {
  413: [
    { path: "src/config/schema.ts", status: "modified", additions: 6, deletions: 0, viewed: true,
      patch: "@@ -30,3 +30,9 @@ export const configSchema = z.object({\n   port: z.number().default(8080),\n   logLevel: z.enum(['debug', 'info', 'warn']).default('info'),\n+  rateLimit: z\n+    .object({\n+      capacity: z.number().int().positive().default(100),\n+      refillPerSec: z.number().positive().default(10),\n+    })\n+    .default({}),\n });" },
    { path: "src/middleware/rateLimit.ts", status: "added", additions: 20, deletions: 0, viewed: false,
      patch: "@@ -0,0 +1,20 @@\n+import { TokenBucket } from '../limiter/tokenBucket';\n+import type { Request, Response, NextFunction } from 'express';\n+\n+const buckets = new Map<string, TokenBucket>();\n+\n+export function rateLimit(opts: { capacity: number; refillPerSec: number }) {\n+  return (req: Request, res: Response, next: NextFunction) => {\n+    const key = req.ip;\n+    let bucket = buckets.get(key);\n+    if (!bucket) {\n+      bucket = new TokenBucket(opts.capacity, opts.refillPerSec);\n+      buckets.set(key, bucket);\n+    }\n+    if (!bucket.take()) {\n+      res.setHeader('Retry-After', '1');\n+      return res.status(429).json({ error: 'rate_limited' });\n+    }\n+    next();\n+  };\n+}" },
    { path: "src/server.ts", status: "modified", additions: 3, deletions: 1, viewed: true,
      patch: "@@ -12,5 +12,7 @@ import express from 'express';\n import { healthRouter } from './routes/health';\n+import { rateLimit } from './middleware/rateLimit';\n \n const app = express();\n-app.use(express.json());\n+app.use(express.json({ limit: '1mb' }));\n+app.use(rateLimit(config.rateLimit));\n app.use('/health', healthRouter);" },
    { path: "test/middleware/rateLimit.test.ts", status: "added", additions: 14, deletions: 0, viewed: false,
      patch: "@@ -0,0 +1,14 @@\n+import request from 'supertest';\n+import express from 'express';\n+import { rateLimit } from '../../src/middleware/rateLimit';\n+\n+describe('rateLimit', () => {\n+  it('returns 429 after capacity', async () => {\n+    const app = express();\n+    app.use(rateLimit({ capacity: 2, refillPerSec: 0 }));\n+    app.get('/', (_req, res) => res.send('ok'));\n+    await request(app).get('/').expect(200);\n+    await request(app).get('/').expect(200);\n+    await request(app).get('/').expect(429);\n+  });\n+});" },
  ],
  412: [
    { path: "src/limiter/tokenBucket.ts", status: "added", additions: 30, deletions: 0, viewed: true,
      patch: "@@ -0,0 +1,30 @@\n+export class TokenBucket {\n+  private tokens: number;\n+  private last = Date.now();\n+\n+  constructor(private capacity: number, private refillPerSec: number) {\n+    this.tokens = capacity;\n+  }\n+\n+  private refill() {\n+    const now = Date.now();\n+    const elapsed = (now - this.last) / 1000;\n+    this.last = now;\n+    if (!this.refillPerSec) {\n+      this.tokens = this.capacity;\n+      return;\n+    }\n+    this.tokens = Math.min(this.capacity, this.tokens + elapsed * this.refillPerSec);\n+  }\n+\n+  take(): boolean {\n+    this.refill();\n+    if (this.tokens < 1) return false;\n+    this.tokens -= 1;\n+    return true;\n+  }\n+\n+  msUntilNextToken(): number {\n+    return this.tokens >= 1 ? 0 : Math.ceil(((1 - this.tokens) / this.refillPerSec) * 1000);\n+  }\n+}" },
    { path: "src/limiter/index.ts", status: "added", additions: 1, deletions: 0, viewed: true, patch: "@@ -0,0 +1 @@\n+export { TokenBucket } from './tokenBucket';" },
  ],
};

const THREADS: Record<number, ReviewThread[]> = {
  413: [{
    id: "T1", path: "test/middleware/rateLimit.test.ts", line: 6, isResolved: false, isOutdated: false,
    comments: [
      { id: "C1", author: "priya-k", body: "Can we add a case for the refill path too? Fake timers would make it deterministic.", createdAt: ago(20) },
      { id: "C2", author: "alex-r", body: "Good call, will add in #415.", createdAt: ago(19) },
    ],
  }],
};

const CHECKS: Record<number, CheckRun[]> = {
  413: [
    { id: 1, name: "lint", status: "completed", conclusion: "success", startedAt: ago(2), completedAt: ago(2), detailsUrl: null, isActions: true },
    { id: 2, name: "typecheck", status: "completed", conclusion: "success", startedAt: ago(2), completedAt: ago(2), detailsUrl: null, isActions: true },
    { id: 3, name: "test / node 20", status: "completed", conclusion: "failure", startedAt: ago(2), completedAt: ago(2), detailsUrl: null, isActions: true },
    { id: 4, name: "build", status: "completed", conclusion: "success", startedAt: ago(2), completedAt: ago(2), detailsUrl: null, isActions: true },
    { id: 5, name: "CodeQL", status: "in_progress", conclusion: null, startedAt: ago(1), completedAt: null, detailsUrl: null, isActions: false },
  ],
};

const LOG = `2026-11-12T12:01:02.0000000Z ##[group]Run npm test
2026-11-12T12:01:02.1000000Z > orders-api@1.4.0 test
2026-11-12T12:01:02.1000000Z > jest
2026-11-12T12:01:09.4000000Z PASS test/limiter/tokenBucket.test.ts
2026-11-12T12:01:10.2000000Z FAIL test/middleware/rateLimit.test.ts
2026-11-12T12:01:10.2000000Z   rateLimit › returns 429 after capacity
2026-11-12T12:01:10.2000000Z     expected 429 "Too Many Requests", got 200 "OK"
2026-11-12T12:01:10.2000000Z       at test/middleware/rateLimit.test.ts:12:38
2026-11-12T12:01:10.9000000Z Tests: 1 failed, 6 passed, 7 total
2026-11-12T12:01:11.0000000Z ##[error]Process completed with exit code 1.`;

const delay = <T>(v: T, ms = 120) => new Promise<T>((r) => setTimeout(() => r(v), ms));

export class FixtureSource implements DataSource {
  readonly kind = "fixtures" as const;
  readonly label = "demo";
  private viewedState = new Map<string, boolean>();
  private threadState = structuredClone(THREADS);

  private all(): Stack[] {
    return buildStacks(repo, PRS, [], ME);
  }
  viewer(): Promise<Viewer> {
    return delay({ login: ME, name: "You", avatarUrl: "", teams: [] });
  }
  orgs() { return delay(["acme"]); }
  teams() { return delay<string[]>([]); }
  inbox(_org: string, opts: { includeSingles: boolean }): Promise<Inbox> {
    const stacks = this.all().filter((s) => opts.includeSingles || s.source !== "single");
    return delay({
      needsReview: stacks.filter((s) => s.author !== ME),
      mine: stacks.filter((s) => s.author === ME),
      repos: [{ repo, openStacks: stacks.length }],
    });
  }
  orgRepos() { return delay([{ repo, pushedAt: ago(1) }]); }
  repoStacks(_r: RepoRef, opts: { includeSingles: boolean }) {
    return delay(this.all().filter((s) => opts.includeSingles || s.source !== "single"));
  }
  stack(_r: RepoRef, key: string) {
    const s = this.all().find((x) => x.key === key);
    return s ? delay(s) : Promise.reject(new Error("Stack not found"));
  }
  pullRequest(_r: RepoRef, n: number) {
    const p = PRS.find((x) => x.number === n);
    return p ? delay(p) : Promise.reject(new Error("Not found"));
  }
  files(_r: RepoRef, p: PullRequest) {
    return delay((FILES[p.number] ?? []).map((f) => ({ ...f, viewed: this.viewedState.get(`${p.number}|${f.path}`) ?? f.viewed })));
  }
  compare(): Promise<FileChange[]> {
    return delay([{ path: "src/config/tenants.ts", status: "added", additions: 4, deletions: 0, viewed: false,
      patch: "@@ -0,0 +1,4 @@\n+export const tenantLimits: Record<string, number> = {\n+  'strategy-team': 500,\n+  default: 100,\n+};" }]);
  }
  fileText(_r: RepoRef, ref: string, path: string): Promise<string | null> {
    // Demo data has no repository, so only files added by a layer can be rebuilt (from their patch).
    const pr = PRS.find((p) => p.headSha === ref);
    const f = pr && FILES[pr.number]?.find((x) => x.path === path);
    if (!f?.patch || f.status !== "added") return delay(null);
    return delay(f.patch.split("\n").filter((l) => l.startsWith("+")).map((l) => l.slice(1)).join("\n") + "\n");
  }
  gitToken() { return null; }
  threads(_r: RepoRef, n: number) { return delay(this.threadState[n] ?? []); }
  checks(_r: RepoRef, sha: string) {
    const p = PRS.find((x) => x.headSha === sha);
    return delay(p ? CHECKS[p.number] ?? [{ id: 9, name: "test", status: "completed", conclusion: "success", startedAt: null, completedAt: null, detailsUrl: null, isActions: true }] : []);
  }
  jobLog() { return delay(LOG, 300); }
  rerunJob() { return delay(undefined); }
  setViewed(prId: string, path: string, viewed: boolean) {
    this.viewedState.set(`${prId.replace("PR_", "")}|${path}`, viewed);
    return delay(undefined, 60);
  }
  submitReview(_r: RepoRef, _n: number, _review: ReviewSubmission) { return delay(undefined, 400); }
  replyToThread(threadId: string, body: string) {
    for (const list of Object.values(this.threadState)) {
      const t = list.find((x) => x.id === threadId);
      if (t) t.comments.push({ id: crypto.randomUUID(), author: ME, body, createdAt: new Date().toISOString() });
    }
    return delay(undefined);
  }
  setThreadResolved(threadId: string, resolved: boolean) {
    for (const list of Object.values(this.threadState)) {
      const t = list.find((x) => x.id === threadId);
      if (t) t.isResolved = resolved;
    }
    return delay(undefined);
  }
}
