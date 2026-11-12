// The data-source contract the UI talks to. Implemented by GitHub (real) and fixtures (demo/dev).

import type {
  CheckRun, ConversationEntry, FileChange, PullRequest, RepoRef, ReviewEvent, ReviewThread, Stack, Viewer,
} from "./model";

export type Inbox = {
  needsReview: Stack[];
  mine: Stack[];
  /** Repos the inbox looked at, for the sidebar. */
  repos: { repo: RepoRef; openStacks: number }[];
};

export type ReviewSubmission = {
  event: ReviewEvent;
  body: string;
  commitId: string;
  comments: { path: string; line: number; body: string }[];
};

export interface DataSource {
  readonly kind: "github" | "fixtures";
  /** Shown as a badge when the data isn't live GitHub (e.g. "demo", "snapshot"). */
  readonly label?: string;
  viewer(): Promise<Viewer>;
  orgs(): Promise<string[]>;
  teams(org: string): Promise<string[]>;
  inbox(org: string, opts: { includeSingles: boolean }): Promise<Inbox>;
  orgRepos(org: string, query: string): Promise<{ repo: RepoRef; pushedAt: string }[]>;
  repoStacks(repo: RepoRef, opts: { includeSingles: boolean }): Promise<Stack[]>;
  stack(repo: RepoRef, key: string): Promise<Stack>;
  pullRequest(repo: RepoRef, number: number): Promise<PullRequest>;
  files(repo: RepoRef, pr: PullRequest): Promise<FileChange[]>;
  /** Files changed between two commits (used for "changes since my review"). */
  compare(repo: RepoRef, base: string, head: string): Promise<FileChange[]>;
  /** Full text of a file at a commit, or null if it doesn't exist there or is binary/too large. */
  fileText(repo: RepoRef, ref: string, path: string): Promise<string | null>;
  /** Token for git operations in the desktop app; null for demo data. */
  gitToken(): string | null;
  threads(repo: RepoRef, number: number): Promise<ReviewThread[]>;
  /** Top-level comments and review summaries with a body, oldest first. */
  conversation(repo: RepoRef, number: number): Promise<ConversationEntry[]>;
  /** Post a top-level comment on the PR. */
  postComment(repo: RepoRef, number: number, body: string): Promise<void>;
  /** True when `upperSha` does not contain `lowerSha` (the layer needs a restack). */
  behindBase(repo: RepoRef, lowerSha: string, upperSha: string): Promise<boolean>;
  checks(repo: RepoRef, sha: string): Promise<CheckRun[]>;
  jobLog(repo: RepoRef, jobId: number): Promise<string>;
  rerunJob(repo: RepoRef, jobId: number): Promise<void>;
  setViewed(prId: string, path: string, viewed: boolean): Promise<void>;
  submitReview(repo: RepoRef, number: number, review: ReviewSubmission): Promise<void>;
  replyToThread(threadId: string, body: string): Promise<void>;
  setThreadResolved(threadId: string, resolved: boolean): Promise<void>;
}
