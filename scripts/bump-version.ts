// Sets the app version everywhere the release workflow checks it.
// Usage: bun scripts/bump-version.ts 0.2.0   (then commit, tag v0.2.0 and push the tag)

import { readFileSync, writeFileSync } from "node:fs";

const version = process.argv[2];
if (!version || !/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) {
  console.error("Usage: bun scripts/bump-version.ts <major.minor.patch[-pre]>");
  process.exit(1);
}

const edit = (path: string, fn: (s: string) => string) => {
  const before = readFileSync(path, "utf8");
  const after = fn(before);
  if (after === before) throw new Error(`${path}: version not found or already ${version}`);
  writeFileSync(path, after);
  console.log(`updated ${path}`);
};

const json = (path: string) => edit(path, (s) => s.replace(/("version":\s*")[^"]+(")/, `$1${version}$2`));
json("package.json");
json("src-tauri/tauri.conf.json");
edit("src-tauri/Cargo.toml", (s) => s.replace(/^(version\s*=\s*")[^"]+(")/m, `$1${version}$2`));
// Keep the lockfile's entry for the app crate in step, so a locked build doesn't rewrite it.
edit("src-tauri/Cargo.lock", (s) => s.replace(/(\[\[package\]\]\nname = "stack-reviewer"\nversion = ")[^"]+(")/, `$1${version}$2`));

console.log(`\nNext: git commit -am "chore: release v${version}" && git tag v${version} && git push && git push origin v${version}`);
