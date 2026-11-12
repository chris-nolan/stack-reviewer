// Domain types shared by the GitHub data source, the fixture data source and the UI.

export type RepoRef = { owner: string; repo: string };

export const repoKey = (r: RepoRef) => `${r.owner}/${r.repo}`;

/** How the signed-in reviewer stands with one layer. */
export type MyLayerState =
  | "approved" // I approved the current head
  | "changes" // I requested changes on the current head
  | "commented" // I reviewed (commented) the current head
  | "stale" // I reviewed an older head; new commits since
  | "turn" // my review (or my team's) is requested, not reviewed yet
  | "todo" // no review from me, not requested
  | "waiting" // my own PR, waiting for reviewers
  | "merged"
  | "closed";

export type ChecksState = "pass" | "fail" | "pending" | "none";

export type ReviewDecision = "APPROVED" | "CHANGES_REQUESTED" | "REVIEW_REQUIRED" | null;

export type PullRequest = {
  id: string; // GraphQL node id
  number: number;
  title: string;
  body: string;
  url: string;
  author: string;
  isDraft: boolean;
  state: "OPEN" | "MERGED" | "CLOSED";
  baseRef: string;
  headRef: string;
  headSha: string;
  baseSha?: string;
  additions: number;
  deletions: number;
  changedFiles: number;
  updatedAt: string;
  createdAt: string;
  reviewDecision: ReviewDecision;
  checks: ChecksState;
  /** Logins and team slugs whose review is requested. */
  requestedReviewers: string[];
  /** Latest review per author: login → { state, commit } */
  latestReviews: { author: string; state: string; commit: string | null }[];
  assignees: string[];
  labels?: { name: string; color: string }[];
  /** GitHub's mergeability: MERGEABLE, CONFLICTING or UNKNOWN. */
  mergeable?: string;
  /** GitHub's merge state: CLEAN, BLOCKED, BEHIND, DIRTY, UNSTABLE, HAS_HOOKS, DRAFT, UNKNOWN. */
  mergeStateStatus?: string;
};

/** A top-level PR comment or a review summary that has a body. */
export type ConversationEntry = {
  id: string;
  kind: "comment" | "review";
  author: string;
  /** Review state (APPROVED, CHANGES_REQUESTED, COMMENTED, DISMISSED); null for plain comments. */
  state: string | null;
  body: string;
  createdAt: string;
};

export type Layer = {
  pr: PullRequest;
  index: number; // 1-based, bottom of the stack = 1
  mine: MyLayerState;
};

export type Stack = {
  key: string; // "n<number>" for native stacks, "i<rootPr>" for inferred
  source: "native" | "inferred" | "single";
  repo: RepoRef;
  title: string;
  author: string;
  baseRef: string;
  layers: Layer[];
  updatedAt: string;
  checks: ChecksState;
};

export type FileChange = {
  path: string;
  previousPath?: string;
  status: "added" | "removed" | "modified" | "renamed" | "copied" | "changed" | "unchanged";
  additions: number;
  deletions: number;
  patch?: string; // unified diff hunks, absent for binary/huge files
  viewed: boolean;
};

export type ThreadComment = { id: string; author: string; body: string; createdAt: string };

export type ReviewThread = {
  id: string;
  path: string;
  line: number | null;
  isResolved: boolean;
  isOutdated: boolean;
  comments: ThreadComment[];
};

export type CheckRun = {
  id: number;
  name: string;
  status: "queued" | "in_progress" | "completed" | string;
  conclusion: string | null; // success, failure, cancelled, skipped, neutral, timed_out, action_required
  startedAt: string | null;
  completedAt: string | null;
  detailsUrl: string | null;
  isActions: boolean;
};

export type Viewer = { login: string; name: string | null; avatarUrl: string; teams: string[] };

export type DraftComment = {
  id: string;
  path: string;
  line: number;
  body: string;
  source: "me" | "agent";
  findingId?: string;
};

export type Severity = "High" | "Medium" | "Low";

export type Finding = {
  id: string;
  pr: number;
  path: string;
  line: number;
  severity: Severity;
  title: string;
  body: string;
  suggestion?: string;
  agent: string;
  status: "open" | "drafted" | "dismissed";
};

export type ReviewEvent = "COMMENT" | "APPROVE" | "REQUEST_CHANGES";
