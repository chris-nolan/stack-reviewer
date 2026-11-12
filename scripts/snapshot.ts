// Captures real GitHub data (read-only) into dev-data/snapshot.json so the browser preview can
// replay it with `?snapshot`. The token stays in this process; the snapshot holds no credentials.
// Usage: GH_TOKEN=$(gh auth token) bun scripts/snapshot.ts <org> <owner/repo> [stackKey...]

import { mkdirSync, writeFileSync } from "node:fs";
import { GitHubSource } from "../src/lib/github";
import type { Snapshot } from "../src/lib/snapshot";

const token = process.env.GH_TOKEN;
if (!token) throw new Error("Set GH_TOKEN");
const [org, target, ...keys] = process.argv.slice(2);
if (!org || !target) throw new Error("Usage: bun scripts/snapshot.ts <org> <owner/repo> [stackKey...]");
const [owner, name] = target.split("/");
const repo = { owner, repo: name };
const gh = new GitHubSource(token);

const snap: Snapshot = {
  capturedAt: new Date().toISOString(),
  viewer: await gh.viewer(),
  orgs: [org],
  inbox: await gh.inbox(org, { includeSingles: false }),
  repoStacks: {},
  stacks: {},
  files: {},
  threads: {},
  checks: {},
  logs: {},
  texts: {},
};
const stacks = await gh.repoStacks(repo, { includeSingles: true });
snap.repoStacks[target] = stacks;
const wanted = keys.length ? keys : stacks.filter((s) => s.source !== "single").map((s) => s.key);
for (const key of wanted) {
  const s = await gh.stack(repo, key);
  snap.stacks[`${target}#${key}`] = s;
  for (const l of s.layers) {
    const k = `${target}#${l.pr.number}`;
    snap.files[k] = await gh.files(repo, l.pr);
    for (const f of snap.files[k]) {
      if (!f.patch) continue;
      if (f.status !== "removed") snap.texts[`${target}@${l.pr.headSha}:${f.path}`] = await gh.fileText(repo, l.pr.headSha, f.path);
      if (f.status !== "added" && l.pr.baseSha) snap.texts[`${target}@${l.pr.baseSha}:${f.previousPath ?? f.path}`] = await gh.fileText(repo, l.pr.baseSha, f.previousPath ?? f.path);
    }
    snap.threads[k] = await gh.threads(repo, l.pr.number);
    const checks = await gh.checks(repo, l.pr.headSha);
    snap.checks[`${target}@${l.pr.headSha}`] = checks;
    for (const c of checks.filter((c) => c.isActions && c.conclusion === "failure").slice(0, 2)) {
      try {
        snap.logs[`${target}/${c.id}`] = await (await fetch(`https://api.github.com/repos/${target}/actions/jobs/${c.id}/logs`, { headers: { Authorization: `Bearer ${token}` } })).text();
      } catch { /* logs may have expired */ }
    }
  }
  console.log(`captured ${key}: ${s.layers.length} layers`);
}
mkdirSync("dev-data", { recursive: true });
writeFileSync("dev-data/snapshot.json", JSON.stringify(snap));
console.log(`wrote dev-data/snapshot.json (${Object.keys(snap.stacks).length} stacks, inbox ${snap.inbox.needsReview.length}+${snap.inbox.mine.length})`);
