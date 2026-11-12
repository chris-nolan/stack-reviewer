import { useEffect } from "react";
import { useNav } from "./nav";
import { useStack } from "./queries";
import { seenStore } from "../lib/homeStore";
import { snapshotStack, stackId } from "../lib/sinceLast";
import type { RepoRef } from "../lib/model";

function Record({ repo, stackKey }: { repo: RepoRef; stackKey: string }) {
  const stack = useStack(repo, stackKey);
  useEffect(() => {
    if (stack.data) seenStore.record(stackId(stack.data), snapshotStack(stack.data));
  }, [stack.data]);
  return null;
}

/** Remembers a snapshot of the stack being viewed (overview or review) for "Since you last looked". */
export function SeenRecorder() {
  const { route } = useNav();
  if (route.name === "home") return null;
  return <Record key={`${route.repo.owner}/${route.repo.repo}#${route.stackKey}`} repo={route.repo} stackKey={route.stackKey} />;
}
