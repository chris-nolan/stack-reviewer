import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useSession, useSource } from "./session";
import type { FileChange, PullRequest, RepoRef } from "../lib/model";
import { repoKey } from "../lib/model";

const MIN = 60_000;

export function useInbox(includeSingles: boolean) {
  const source = useSource();
  const { org } = useSession();
  return useQuery({
    queryKey: ["inbox", source.kind, org, includeSingles],
    queryFn: () => source.inbox(org, { includeSingles }),
    refetchInterval: MIN,
    enabled: !!org,
  });
}

export function useRepoStacks(repo: RepoRef | undefined, includeSingles: boolean) {
  const source = useSource();
  return useQuery({
    queryKey: ["repoStacks", source.kind, repo && repoKey(repo), includeSingles],
    queryFn: () => source.repoStacks(repo!, { includeSingles }),
    enabled: !!repo,
    refetchInterval: MIN,
  });
}

export function useOrgRepos(query: string) {
  const source = useSource();
  const { org } = useSession();
  return useQuery({
    queryKey: ["orgRepos", source.kind, org, query],
    queryFn: () => source.orgRepos(org, query),
    enabled: !!org,
    staleTime: 5 * MIN,
  });
}

export function useStack(repo: RepoRef, key: string) {
  const source = useSource();
  return useQuery({
    queryKey: ["stack", source.kind, repoKey(repo), key],
    queryFn: () => source.stack(repo, key),
    refetchInterval: 30_000,
  });
}

export function useFiles(repo: RepoRef, pr: PullRequest | undefined) {
  const source = useSource();
  return useQuery({
    queryKey: ["files", source.kind, repoKey(repo), pr?.number, pr?.headSha],
    queryFn: () => source.files(repo, pr!),
    enabled: !!pr,
    staleTime: 5 * MIN,
  });
}

export function useThreads(repo: RepoRef, number: number | undefined) {
  const source = useSource();
  return useQuery({
    queryKey: ["threads", source.kind, repoKey(repo), number],
    queryFn: () => source.threads(repo, number!),
    enabled: number != null,
    refetchInterval: MIN,
  });
}

export function useChecks(repo: RepoRef, sha: string | undefined) {
  const source = useSource();
  return useQuery({
    queryKey: ["checks", source.kind, repoKey(repo), sha],
    queryFn: () => source.checks(repo, sha!),
    enabled: !!sha,
    refetchInterval: 30_000,
  });
}

export function useJobLog(repo: RepoRef, jobId: number | null) {
  const source = useSource();
  return useQuery({
    queryKey: ["jobLog", source.kind, repoKey(repo), jobId],
    queryFn: () => source.jobLog(repo, jobId!),
    enabled: jobId != null && jobId > 0,
    staleTime: Infinity,
  });
}

/** Toggle GitHub's per-file "viewed" state with an optimistic update. */
export function useSetViewed(repo: RepoRef, pr: PullRequest | undefined) {
  const source = useSource();
  const qc = useQueryClient();
  const key = ["files", source.kind, repoKey(repo), pr?.number, pr?.headSha];
  return useMutation({
    mutationFn: ({ path, viewed }: { path: string; viewed: boolean }) => source.setViewed(pr!.id, path, viewed),
    onMutate: async ({ path, viewed }) => {
      await qc.cancelQueries({ queryKey: key });
      const prev = qc.getQueryData<FileChange[]>(key);
      qc.setQueryData<FileChange[]>(key, (old) => old?.map((f) => (f.path === path ? { ...f, viewed } : f)));
      return { prev };
    },
    onError: (_e, _v, ctx) => ctx?.prev && qc.setQueryData(key, ctx.prev),
  });
}
