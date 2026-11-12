// GitHub implementation of DataSource: GraphQL for PR metadata, REST for stacks, files and checks.

import type {
  CheckRun, ChecksState, ConversationEntry, FileChange, PullRequest, RepoRef, ReviewThread, Stack, Viewer,
} from "./model";
import type { DataSource, Inbox, ReviewSubmission } from "./source";
import { buildStacks, mergeConversation, needsMe, type NativeStack } from "./stacks";
import { httpGetText } from "./platform";

const API = "https://api.github.com";

export class GitHubError extends Error {
  constructor(message: string, readonly status: number, readonly ssoUrl?: string) {
    super(message);
  }
}

export type RateLimit = { remaining: number; limit: number; reset: number };
let lastRate: RateLimit | null = null;
export const rateLimit = () => lastRate;

const PR_FIELDS = `
  id number title body url isDraft state baseRefName headRefName headRefOid baseRefOid
  additions deletions changedFiles updatedAt createdAt reviewDecision
  author { login }
  assignees(first: 10) { nodes { login } }
  reviewRequests(first: 20) { nodes { requestedReviewer { ... on User { login } ... on Team { slug } } } }
  latestReviews(first: 30) { nodes { author { login } state commit { oid } } }
  labels(first: 20) { nodes { name color } }
  mergeable mergeStateStatus
  commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }
`;

type GqlPr = {
  id: string; number: number; title: string; body: string; url: string; isDraft: boolean;
  state: PullRequest["state"]; baseRefName: string; headRefName: string; headRefOid: string; baseRefOid: string;
  additions: number; deletions: number; changedFiles: number; updatedAt: string; createdAt: string;
  reviewDecision: PullRequest["reviewDecision"];
  author: { login: string } | null;
  assignees: { nodes: { login: string }[] };
  reviewRequests: { nodes: { requestedReviewer: { login?: string; slug?: string } | null }[] };
  latestReviews: { nodes: { author: { login: string } | null; state: string; commit: { oid: string } | null }[] };
  labels?: { nodes: { name: string; color: string }[] };
  mergeable?: string; mergeStateStatus?: string;
  commits: { nodes: { commit: { statusCheckRollup: { state: string } | null } }[] };
};

function rollup(state: string | undefined): ChecksState {
  switch (state) {
    case "SUCCESS": return "pass";
    case "FAILURE": case "ERROR": return "fail";
    case "PENDING": case "EXPECTED": return "pending";
    default: return "none";
  }
}

function toPr(p: GqlPr): PullRequest {
  return {
    id: p.id, number: p.number, title: p.title, body: p.body ?? "", url: p.url,
    author: p.author?.login ?? "ghost", isDraft: p.isDraft, state: p.state,
    baseRef: p.baseRefName, headRef: p.headRefName, headSha: p.headRefOid, baseSha: p.baseRefOid,
    additions: p.additions, deletions: p.deletions, changedFiles: p.changedFiles,
    updatedAt: p.updatedAt, createdAt: p.createdAt, reviewDecision: p.reviewDecision,
    checks: rollup(p.commits.nodes[0]?.commit.statusCheckRollup?.state),
    requestedReviewers: p.reviewRequests.nodes
      .map((n) => n.requestedReviewer?.login ?? n.requestedReviewer?.slug ?? "")
      .filter(Boolean)
      .map((s) => s.toLowerCase()),
    latestReviews: p.latestReviews.nodes.map((r) => ({
      author: r.author?.login ?? "ghost", state: r.state, commit: r.commit?.oid ?? null,
    })),
    assignees: p.assignees.nodes.map((a) => a.login),
    labels: (p.labels?.nodes ?? []).map((l) => ({ name: l.name, color: l.color })),
    mergeable: p.mergeable, mergeStateStatus: p.mergeStateStatus,
  };
}

export class GitHubSource implements DataSource {
  readonly kind = "github" as const;
  private me: Viewer | null = null;
  private teamCache = new Map<string, string[]>();

  constructor(private token: string) {}

  private async request(path: string, init: RequestInit = {}): Promise<Response> {
    const res = await fetch(path.startsWith("http") ? path : `${API}${path}`, {
      cache: "no-cache", // revalidate with ETags; 304s don't count against the rate limit
      ...init,
      headers: {
        Authorization: `Bearer ${this.token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        ...(init.headers ?? {}),
      },
    });
    const remaining = res.headers.get("x-ratelimit-remaining");
    if (remaining) {
      lastRate = {
        remaining: Number(remaining),
        limit: Number(res.headers.get("x-ratelimit-limit") ?? 0),
        reset: Number(res.headers.get("x-ratelimit-reset") ?? 0),
      };
    }
    if (!res.ok) {
      const sso = res.headers.get("x-github-sso");
      const ssoUrl = sso?.match(/url=(\S+)/)?.[1];
      let message = `GitHub returned ${res.status}`;
      try {
        const body = await res.json();
        if (body?.message) message = body.message;
      } catch { /* not json */ }
      throw new GitHubError(message, res.status, ssoUrl);
    }
    return res;
  }

  private async rest<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await this.request(path, init);
    if (res.status === 204) return undefined as T;
    const text = await res.text();
    return (text ? JSON.parse(text) : undefined) as T;
  }

  private async gql<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
    const body = await this.rest<{ data: T; errors?: { message: string; type?: string }[] }>("/graphql", {
      method: "POST",
      body: JSON.stringify({ query, variables }),
      cache: "no-store",
    });
    if (body.errors?.length && !body.data) throw new GitHubError(body.errors[0].message, 200);
    return body.data;
  }

  async viewer(): Promise<Viewer> {
    if (this.me) return this.me;
    const d = await this.gql<{ viewer: { login: string; name: string | null; avatarUrl: string } }>(
      `query { viewer { login name avatarUrl } }`,
    );
    this.me = { ...d.viewer, teams: [] };
    return this.me;
  }

  async orgs(): Promise<string[]> {
    const d = await this.gql<{ viewer: { organizations: { nodes: { login: string }[] } } }>(
      `query { viewer { organizations(first: 50) { nodes { login } } } }`,
    );
    return d.viewer.organizations.nodes.map((o) => o.login);
  }

  async teams(org: string): Promise<string[]> {
    if (this.teamCache.has(org)) return this.teamCache.get(org)!;
    const me = await this.viewer();
    try {
      const d = await this.gql<{ organization: { teams: { nodes: { slug: string }[] } } | null }>(
        `query($org: String!, $me: [String!]) { organization(login: $org) { teams(first: 100, userLogins: $me) { nodes { slug } } } }`,
        { org, me: [me.login] },
      );
      const slugs = (d.organization?.teams.nodes ?? []).map((t) => t.slug.toLowerCase());
      this.teamCache.set(org, slugs);
      return slugs;
    } catch {
      return []; // token may lack read:org
    }
  }

  private async openPrs(repo: RepoRef): Promise<PullRequest[]> {
    const d = await this.gql<{ repository: { pullRequests: { nodes: GqlPr[] } } | null }>(
      `query($owner: String!, $name: String!) { repository(owner: $owner, name: $name) {
        pullRequests(states: OPEN, first: 100, orderBy: { field: UPDATED_AT, direction: DESC }) { nodes { ${PR_FIELDS} } } } }`,
      { owner: repo.owner, name: repo.repo },
    );
    return (d.repository?.pullRequests.nodes ?? []).map(toPr);
  }

  private async prsByNumber(repo: RepoRef, numbers: number[]): Promise<PullRequest[]> {
    if (!numbers.length) return [];
    const fields = numbers.map((n) => `p${n}: pullRequest(number: ${Math.floor(n)}) { ${PR_FIELDS} }`).join("\n");
    const d = await this.gql<{ repository: Record<string, GqlPr | null> | null }>(
      `query($owner: String!, $name: String!) { repository(owner: $owner, name: $name) { ${fields} } }`,
      { owner: repo.owner, name: repo.repo },
    );
    return Object.values(d.repository ?? {}).filter((p): p is GqlPr => !!p).map(toPr);
  }

  private async nativeStacks(repo: RepoRef): Promise<NativeStack[]> {
    try {
      return await this.rest<NativeStack[]>(`/repos/${repo.owner}/${repo.repo}/stacks?per_page=100`);
    } catch (e) {
      // Stacked PRs are a preview feature: treat a missing endpoint as "no native stacks".
      if (e instanceof GitHubError && (e.status === 404 || e.status === 410 || e.status === 422)) return [];
      throw e;
    }
  }

  private async stacksFor(repo: RepoRef, withClosedLayers: boolean): Promise<Stack[]> {
    const me = await this.viewer();
    const [open, native, teams] = await Promise.all([this.openPrs(repo), this.nativeStacks(repo), this.teams(repo.owner)]);
    let extra: PullRequest[] = [];
    if (withClosedLayers) {
      const known = new Set(open.map((p) => p.number));
      const missing = native
        .filter((s) => s.open)
        .flatMap((s) => s.pull_requests.map((p) => p.number))
        .filter((n) => !known.has(n));
      extra = await this.prsByNumber(repo, missing.slice(0, 50));
    }
    return buildStacks(repo, open, native, me.login, teams, extra);
  }

  async inbox(org: string, opts: { includeSingles: boolean }): Promise<Inbox> {
    const me = await this.viewer();
    const q = (filter: string) => `is:pr is:open archived:false org:${org} ${filter}`;
    const d = await this.gql<Record<"review" | "assigned" | "mine", { nodes: { number?: number; repository?: { owner: { login: string }; name: string } }[] }>>(
      `query($a: String!, $b: String!, $c: String!) {
        review: search(query: $a, type: ISSUE, first: 50) { nodes { ... on PullRequest { number repository { owner { login } name } } } }
        assigned: search(query: $b, type: ISSUE, first: 50) { nodes { ... on PullRequest { number repository { owner { login } name } } } }
        mine: search(query: $c, type: ISSUE, first: 50) { nodes { ... on PullRequest { number repository { owner { login } name } } } }
      }`,
      { a: q("review-requested:@me"), b: q("assignee:@me"), c: q("author:@me") },
    );
    const hits = new Map<string, { repo: RepoRef; review: Set<number>; mine: Set<number> }>();
    const add = (kind: "review" | "mine", nodes: { number?: number; repository?: { owner: { login: string }; name: string } }[]) => {
      for (const n of nodes) {
        if (!n.repository || n.number == null) continue;
        const repo = { owner: n.repository.owner.login, repo: n.repository.name };
        const k = `${repo.owner}/${repo.repo}`;
        const h = hits.get(k) ?? { repo, review: new Set(), mine: new Set() };
        h[kind].add(n.number);
        hits.set(k, h);
      }
    };
    add("review", d.review.nodes);
    add("review", d.assigned.nodes);
    add("mine", d.mine.nodes);

    const needsReview: Stack[] = [];
    const mine: Stack[] = [];
    const repos: Inbox["repos"] = [];
    await Promise.all(
      [...hits.values()].map(async (h) => {
        const stacks = await this.stacksFor(h.repo, false);
        const keep = (s: Stack) => opts.includeSingles || s.source !== "single";
        repos.push({ repo: h.repo, openStacks: stacks.filter((s) => s.source !== "single").length });
        for (const s of stacks.filter(keep)) {
          const nums = s.layers.map((l) => l.pr.number);
          if (nums.some((n) => h.mine.has(n)) || s.author === me.login) mine.push(s);
          else if (nums.some((n) => h.review.has(n)) || needsMe(s)) needsReview.push(s);
        }
      }),
    );
    const byUpdated = (a: Stack, b: Stack) => (a.updatedAt < b.updatedAt ? 1 : -1);
    return { needsReview: needsReview.sort(byUpdated), mine: mine.sort(byUpdated), repos: repos.sort((a, b) => a.repo.repo.localeCompare(b.repo.repo)) };
  }

  async orgRepos(org: string, query: string): Promise<{ repo: RepoRef; pushedAt: string }[]> {
    const q = `org:${org} archived:false ${query}`.trim();
    const d = await this.gql<{ search: { nodes: { name?: string; owner?: { login: string }; pushedAt?: string }[] } }>(
      `query($q: String!) { search(query: $q, type: REPOSITORY, first: 30) { nodes { ... on Repository { name owner { login } pushedAt } } } }`,
      { q: `${q} sort:updated` },
    );
    return d.search.nodes
      .filter((n) => n.name && n.owner)
      .map((n) => ({ repo: { owner: n.owner!.login, repo: n.name! }, pushedAt: n.pushedAt ?? "" }));
  }

  async repoStacks(repo: RepoRef, opts: { includeSingles: boolean }): Promise<Stack[]> {
    const stacks = await this.stacksFor(repo, false);
    return stacks.filter((s) => opts.includeSingles || s.source !== "single");
  }

  async stack(repo: RepoRef, key: string): Promise<Stack> {
    const stacks = await this.stacksFor(repo, true);
    const found = stacks.find((s) => s.key === key);
    if (found) return found;
    // An inferred stack's root may have merged, re-keying it; fall back to any stack containing that PR.
    const n = Number(key.slice(1));
    const containing = stacks.find((s) => s.layers.some((l) => l.pr.number === n));
    if (containing) return containing;
    throw new GitHubError("This stack is no longer open", 404);
  }

  async pullRequest(repo: RepoRef, number: number): Promise<PullRequest> {
    const [pr] = await this.prsByNumber(repo, [number]);
    if (!pr) throw new GitHubError(`PR #${number} not found`, 404);
    return pr;
  }

  async files(repo: RepoRef, pr: PullRequest): Promise<FileChange[]> {
    type RestFile = { filename: string; previous_filename?: string; status: FileChange["status"]; additions: number; deletions: number; patch?: string };
    const pages: RestFile[] = [];
    for (let page = 1; page <= 30; page++) {
      const batch = await this.rest<RestFile[]>(`/repos/${repo.owner}/${repo.repo}/pulls/${pr.number}/files?per_page=100&page=${page}`);
      pages.push(...batch);
      if (batch.length < 100) break;
    }
    const viewed = new Map<string, string>();
    let after: string | null = null;
    for (let i = 0; i < 30; i++) {
      const d: { node: { files: { nodes: { path: string; viewerViewedState: string }[]; pageInfo: { hasNextPage: boolean; endCursor: string } } } | null } =
        await this.gql(
          `query($id: ID!, $after: String) { node(id: $id) { ... on PullRequest { files(first: 100, after: $after) { nodes { path viewerViewedState } pageInfo { hasNextPage endCursor } } } } }`,
          { id: pr.id, after },
        );
      const files = d.node?.files;
      if (!files) break;
      for (const f of files.nodes) viewed.set(f.path, f.viewerViewedState);
      if (!files.pageInfo.hasNextPage) break;
      after = files.pageInfo.endCursor;
    }
    return pages.map((f) => ({
      path: f.filename, previousPath: f.previous_filename, status: f.status,
      additions: f.additions, deletions: f.deletions, patch: f.patch,
      viewed: viewed.get(f.filename) === "VIEWED",
    }));
  }

  async compare(repo: RepoRef, base: string, head: string): Promise<FileChange[]> {
    type C = { files?: { filename: string; previous_filename?: string; status: FileChange["status"]; additions: number; deletions: number; patch?: string }[] };
    const c = await this.rest<C>(`/repos/${repo.owner}/${repo.repo}/compare/${base}...${head}?per_page=100`);
    return (c.files ?? []).map((f) => ({
      path: f.filename, previousPath: f.previous_filename, status: f.status,
      additions: f.additions, deletions: f.deletions, patch: f.patch, viewed: false,
    }));
  }

  async fileText(repo: RepoRef, ref: string, path: string): Promise<string | null> {
    const enc = path.split("/").map(encodeURIComponent).join("/");
    try {
      const res = await this.request(`/repos/${repo.owner}/${repo.repo}/contents/${enc}?ref=${encodeURIComponent(ref)}`, {
        headers: { Accept: "application/vnd.github.raw+json" },
        cache: "force-cache", // content at a commit never changes
      });
      if (Number(res.headers.get("content-length") ?? 0) > 2_000_000) return null;
      const text = await res.text();
      return text.includes("\u0000") ? null : text;
    } catch (e) {
      if (e instanceof GitHubError && (e.status === 404 || e.status === 403 || e.status === 422)) return null;
      throw e;
    }
  }

  gitToken(): string | null {
    return this.token;
  }

  async threads(repo: RepoRef, number: number): Promise<ReviewThread[]> {
    type T = { id: string; path: string; line: number | null; originalLine: number | null; isResolved: boolean; isOutdated: boolean; comments: { nodes: { id: string; body: string; createdAt: string; author: { login: string } | null }[] } };
    const d = await this.gql<{ repository: { pullRequest: { reviewThreads: { nodes: T[] } } | null } | null }>(
      `query($owner: String!, $name: String!, $n: Int!) { repository(owner: $owner, name: $name) { pullRequest(number: $n) {
        reviewThreads(first: 100) { nodes { id path line originalLine isResolved isOutdated
          comments(first: 50) { nodes { id body createdAt author { login } } } } } } } }`,
      { owner: repo.owner, name: repo.repo, n: number },
    );
    return (d.repository?.pullRequest?.reviewThreads.nodes ?? []).map((t) => ({
      id: t.id, path: t.path, line: t.line ?? t.originalLine, isResolved: t.isResolved, isOutdated: t.isOutdated,
      comments: t.comments.nodes.map((c) => ({ id: c.id, body: c.body, createdAt: c.createdAt, author: c.author?.login ?? "ghost" })),
    }));
  }

  async conversation(repo: RepoRef, number: number): Promise<ConversationEntry[]> {
    type A = { login: string } | null;
    type D = { repository: { pullRequest: {
      comments: { nodes: { id: string; body: string; createdAt: string; author: A }[] };
      reviews: { nodes: { id: string; body: string; state: string; createdAt: string; submittedAt: string | null; author: A }[] };
    } | null } | null };
    const d = await this.gql<D>(
      `query($owner: String!, $name: String!, $n: Int!) { repository(owner: $owner, name: $name) { pullRequest(number: $n) {
        comments(first: 100) { nodes { id body createdAt author { login } } }
        reviews(first: 50) { nodes { id body state createdAt submittedAt author { login } } } } } }`,
      { owner: repo.owner, name: repo.repo, n: number },
    );
    const pr = d.repository?.pullRequest;
    return mergeConversation(
      (pr?.comments.nodes ?? []).map((c) => ({ id: c.id, author: c.author?.login ?? "ghost", body: c.body, createdAt: c.createdAt })),
      (pr?.reviews.nodes ?? []).map((r) => ({ id: r.id, author: r.author?.login ?? "ghost", state: r.state, body: r.body, createdAt: r.submittedAt ?? r.createdAt })),
    );
  }

  async postComment(repo: RepoRef, number: number, body: string): Promise<void> {
    await this.rest(`/repos/${repo.owner}/${repo.repo}/issues/${number}/comments`, { method: "POST", body: JSON.stringify({ body }) });
  }

  async behindBase(repo: RepoRef, lowerSha: string, upperSha: string): Promise<boolean> {
    const c = await this.rest<{ behind_by: number }>(`/repos/${repo.owner}/${repo.repo}/compare/${lowerSha}...${upperSha}?per_page=1`);
    return c.behind_by > 0;
  }

  async checks(repo: RepoRef, sha: string): Promise<CheckRun[]> {
    type R = { check_runs: { id: number; name: string; status: string; conclusion: string | null; started_at: string | null; completed_at: string | null; details_url: string | null; app: { slug: string } | null }[] };
    type S = { statuses: { id: number; context: string; state: string; target_url: string | null; created_at: string; updated_at: string }[] };
    const [runs, status] = await Promise.all([
      this.rest<R>(`/repos/${repo.owner}/${repo.repo}/commits/${sha}/check-runs?per_page=100`),
      this.rest<S>(`/repos/${repo.owner}/${repo.repo}/commits/${sha}/status`).catch(() => ({ statuses: [] }) as S),
    ]);
    const fromStatus: CheckRun[] = status.statuses.map((s) => ({
      id: -s.id, name: s.context,
      status: s.state === "pending" ? "in_progress" : "completed",
      conclusion: s.state === "pending" ? null : s.state === "success" ? "success" : "failure",
      startedAt: s.created_at, completedAt: s.updated_at, detailsUrl: s.target_url, isActions: false,
    }));
    return [
      ...runs.check_runs.map((r) => ({
        id: r.id, name: r.name, status: r.status, conclusion: r.conclusion,
        startedAt: r.started_at, completedAt: r.completed_at, detailsUrl: r.details_url,
        isActions: r.app?.slug === "github-actions",
      })),
      ...fromStatus,
    ];
  }

  jobLog(repo: RepoRef, jobId: number): Promise<string> {
    return httpGetText(`${API}/repos/${repo.owner}/${repo.repo}/actions/jobs/${jobId}/logs`, this.token);
  }

  async rerunJob(repo: RepoRef, jobId: number): Promise<void> {
    await this.rest(`/repos/${repo.owner}/${repo.repo}/actions/jobs/${jobId}/rerun`, { method: "POST" });
  }

  async setViewed(prId: string, path: string, viewed: boolean): Promise<void> {
    const m = viewed ? "markFileAsViewed" : "unmarkFileAsViewed";
    await this.gql(`mutation($id: ID!, $path: String!) { ${m}(input: { pullRequestId: $id, path: $path }) { clientMutationId } }`, { id: prId, path });
  }

  async submitReview(repo: RepoRef, number: number, r: ReviewSubmission): Promise<void> {
    await this.rest(`/repos/${repo.owner}/${repo.repo}/pulls/${number}/reviews`, {
      method: "POST",
      body: JSON.stringify({
        commit_id: r.commitId,
        body: r.body || undefined,
        event: r.event,
        comments: r.comments.map((c) => (c.startLine != null && c.startLine < c.line ? { path: c.path, start_line: c.startLine, start_side: "RIGHT", line: c.line, side: "RIGHT", body: c.body } : { path: c.path, line: c.line, side: "RIGHT", body: c.body })),
      }),
    });
  }

  async replyToThread(threadId: string, body: string): Promise<void> {
    await this.gql(`mutation($id: ID!, $body: String!) { addPullRequestReviewThreadReply(input: { pullRequestReviewThreadId: $id, body: $body }) { clientMutationId } }`, { id: threadId, body });
  }

  async setThreadResolved(threadId: string, resolved: boolean): Promise<void> {
    const m = resolved ? "resolveReviewThread" : "unresolveReviewThread";
    await this.gql(`mutation($id: ID!) { ${m}(input: { threadId: $id }) { clientMutationId } }`, { id: threadId });
  }
}
