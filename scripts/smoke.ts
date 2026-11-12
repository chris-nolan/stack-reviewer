// Read-only smoke test of the GitHub data source against the real API.
// Usage: GH_TOKEN=$(gh auth token) bun scripts/smoke.ts <org> [owner/repo]

import { GitHubSource, rateLimit } from "../src/lib/github";

const token = process.env.GH_TOKEN;
if (!token) throw new Error("Set GH_TOKEN");
const org = process.argv[2];
if (!org) throw new Error("Usage: bun scripts/smoke.ts <org> [owner/repo]");
const gh = new GitHubSource(token);

const t0 = Date.now();
const me = await gh.viewer();
console.log("viewer:", me.login, "teams:", (await gh.teams(org)).length);

const inbox = await gh.inbox(org, { includeSingles: false });
console.log(`inbox: ${inbox.needsReview.length} need review, ${inbox.mine.length} mine, ${inbox.repos.length} repos (${Date.now() - t0}ms)`);
for (const s of [...inbox.needsReview, ...inbox.mine].slice(0, 6)) {
  console.log(`  ${s.repo.owner}/${s.repo.repo} ${s.key} [${s.source}] "${s.title}" layers=${s.layers.map((l) => `${l.pr.number}:${l.mine}`).join(",")} checks=${s.checks}`);
}

const target = process.argv[3];
if (target) {
  const [owner, repo] = target.split("/");
  const stacks = await gh.repoStacks({ owner, repo }, { includeSingles: false });
  console.log(`${target}: ${stacks.length} stacks`, stacks.map((s) => `${s.key}(${s.layers.length})`).join(" "));
  const first = stacks[0];
  if (first) {
    const full = await gh.stack({ owner, repo }, first.key);
    console.log(`stack ${full.key}: ${full.layers.map((l) => `#${l.pr.number} ${l.pr.state} base=${l.pr.baseRef}`).join(" | ")}`);
    const layer = full.layers.find((l) => l.pr.state === "OPEN") ?? full.layers[0];
    const files = await gh.files({ owner, repo }, layer.pr);
    console.log(`files of #${layer.pr.number}: ${files.length}, viewed=${files.filter((f) => f.viewed).length}, withPatch=${files.filter((f) => f.patch).length}`);
    const threads = await gh.threads({ owner, repo }, layer.pr.number);
    console.log(`threads: ${threads.length}`);
    const checks = await gh.checks({ owner, repo }, layer.pr.headSha);
    console.log(`checks: ${checks.map((c) => `${c.name}=${c.conclusion ?? c.status}`).join(", ")}`);
  }
}
const rl = rateLimit();
console.log(`done in ${Date.now() - t0}ms; rate limit remaining ${rl?.remaining}/${rl?.limit}`);
