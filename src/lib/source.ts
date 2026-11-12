// The data-source contract the UI talks to. Implemented by GitHub (real) and fixtures (demo/dev).

import type {
  CheckRun, FileChange, PullRequest, RepoRef, ReviewEvent, ReviewThread, Stack, Viewer,
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
  /** Token for git operations in the desktop app; null for demo data. */
  gitToken(): string | null;
  threads(repo: RepoRef, number: number): Promise<ReviewThread[]>;
  checks(repo: RepoRef, sha: string): Promise<CheckRun[]>;
  jobLog(repo: RepoRef, jobId: number): Promise<string>;
  rerunJob(repo: RepoRef, jobId: number): Promise<void>;
  setViewed(prId: string, path: string, viewed: boolean): Promise<void>;
  submitReview(repo: RepoRef, number: number, review: ReviewSubmission): Promise<void>;
  replyToThread(threadId: string, body: string): Promise<void>;
  setThreadResolved(threadId: string, resolved: boolean): Promise<void>;
}
