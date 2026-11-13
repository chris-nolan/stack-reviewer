# Stack Reviewer

Desktop app (macOS and Windows) for reviewing stacked pull requests layer by layer, with a local AI agent (Claude Code or Gemini CLI) alongside. See [docs/SPEC.md](docs/SPEC.md) for the feature spec and UX direction.

## Run it

Prerequisites: Rust, Bun, and Node 22+ (Node is only needed for the Claude Code ACP adapter). To use agents, install and sign in to at least one of `claude` or `gemini`.

```bash
bun install
bun run tauri dev      # desktop app
bun run dev            # browser only: open http://localhost:1420/?demo for demo data
bun run tauri build    # signed builds are not set up yet
```

Sign-in options (you can add several accounts and switch between them from the account menu in the sidebar, the command palette's "Switch account…", or Settings → Accounts):
- **GitHub CLI (gh) login**: the app lists every account logged in to `gh` (`gh auth status`) and you pick one, so it doesn't have to be gh's active account. Nothing is copied: the token is read from `gh auth token --user <login>` each time the account is used, so re-logging in with gh never leaves a stale token. The app never runs `gh auth switch` or changes gh's config.
- **Personal access token**: needs `repo` and `read:org`.
- **Sign in with GitHub** (device flow): appears once an org-owned OAuth app exists. Set `VITE_GITHUB_CLIENT_ID` at build time to enable it.

Device and token accounts keep their token in the OS keychain, one entry per login (`stack-reviewer` / `github:<login>`), read at most once per launch. gh accounts keep nothing there. The list of accounts (logins, how each signs in, which is current) holds no secrets, so it lives in `state.db`; older versions kept it in the keychain as `accounts-index`, and it is moved over on first start. A token saved by an older version is moved under its login the same way. Removing an account ("Sign out of <login>") only forgets it in the app.

On macOS the keychain asks for your login password when an app it doesn't recognise reads an entry (Touch ID isn't offered for these prompts). Builds aren't code-signed yet, so each new build counts as a new app: choose **Always Allow** and you'll be asked once per build, and only if you use device or token accounts.

Drafts, guides, pins, "seen" state and agent chats are kept per account, and agents (and their checkouts) are never shared between accounts. If an org requires SAML SSO and the account's token isn't authorised for it, the inbox says so and links to GitHub to authorise it.

## Windows

Prerequisites (in addition to the above):
- **Microsoft C++ Build Tools** (MSVC, "Desktop development with C++" workload, with the Windows SDK) and Rust's `x86_64-pc-windows-msvc` toolchain.
- **WebView2 runtime**, preinstalled on Windows 11 and current Windows 10; otherwise install the Evergreen runtime.
- **Git for Windows** (the app shells out to `git`). **Node 22+** for the Claude Code ACP adapter (`npx.cmd`). **GitHub CLI** is optional (only for "Use my GitHub CLI login").
- Recommended: turn on Windows long paths (`LongPathsEnabled` registry setting). Review checkouts live under `%APPDATA%\com.stackreviewer.app\repos`; the app already runs git with `core.longpaths=true`.

Then `bun install` and `bun run tauri dev` / `bun run tauri build` work as on macOS. Shortcuts show as `Ctrl` instead of `⌘`.

How tools are found: `PATH` first, then the usual install dirs (`%APPDATA%\npm`, Program Files `Git\cmd` and `GitHub CLI`, `%LOCALAPPDATA%\Programs`, WinGet links, nvm-windows, Volta, scoop, Chocolatey, `%USERPROFILE%\.local\bin`). Only `.exe`/`.cmd`/`.bat`/`.com` files are launched. `~\` works in Settings overrides.

Known gaps:
- Not yet built or run on a real Windows machine; CI (`.github/workflows/build.yml`) will be the first real check once the repo has a remote.
- Custom agent arguments containing `%`, `"` or `&` can't be passed to `.cmd`/`.bat` shims (a Windows limitation); point the override at the `.exe` instead.
- Agents are stopped with `taskkill /T`; if the app is killed abruptly, a Node child process can be left running.
- Builds are unsigned, so SmartScreen will warn.

## How it works

| Piece | Where |
|---|---|
| Stack discovery: GitHub's native `/repos/{o}/{r}/stacks` plus base→head inference | `src/lib/stacks.ts`, `src/lib/github.ts` |
| Data source contract (GitHub, plus in-memory demo fixtures) | `src/lib/source.ts`, `src/lib/fixtures.ts` |
| Screens: Home → Overview (files × layers) → Review | `src/features/` |
| Local drafts and agent findings (nothing is posted until you submit) | `src/lib/reviewStore.ts` |
| Keychain, `gh` import, device flow | `src-tauri/src/auth.rs` |
| Partial clone plus a worktree per layer, so agents read real code | `src-tauri/src/git.rs` |
| Agent processes and their stdio relay | `src-tauri/src/agent.rs` |
| ACP client (JSON-RPC over stdio) | `src/agent/acp.ts`, `src/agent/session.ts` |
| MCP tools the agent gets: `get_review_context`, `get_check_failures`, `add_finding`, `set_layer_brief`, `set_review_summary` | `src/agent/mcpServer.ts` (served on loopback by `src-tauri/src/mcp.rs`) |

The agent chat is one conversation per stack. The agent works in a single checkout per stack that follows you between layers. A divider marks each move, and the agent is told it has moved, so it keeps what it learned lower down. Its tools default to the layer it is working on, which may not be the one on screen. Transcripts are saved locally, and the agent's session is resumed after a restart.

Agents never write to GitHub. `add_finding` only accepts lines that appear in the diff. Each finding goes into the margin, where you choose **Draft** or **Dismiss**.

## Where state lives

- **Durable state** (review drafts, findings, briefs and summaries; agent transcripts and resume ids; Home's seen/pinned/recent) is in a SQLite database, `state.db`, in the app data dir (macOS: `~/Library/Application Support/<app identifier>/`, Windows: `%APPDATA%\<app identifier>\`). It is a single `kv(ns, key, value, updated_at)` table in WAL mode, owned by Rust (`src-tauri/src/store.rs`) and written through `src/lib/durable.ts` (in-memory cache, debounced writes, flushed on exit). Namespaces: `review` (per PR), `chat` (per stack|agent), `home` (per name + data-source/viewer scope), `meta`.
- On first launch with the database, existing webview localStorage values for those keys are copied in once, then removed.
- **UI preferences** (layout, panel toggles, file filters, agent choice/overrides, notifications, org) stay in webview localStorage. The token stays in the OS keychain.
- In a plain browser (`?demo`, `?snapshot`) `durable.ts` falls back to localStorage; there is no database and no migration.

## Keyboard (Review screen)

`j` mark viewed & next · `k` previous file · `v` toggle viewed · `n`/`p` next/previous change · `c` comment on the focused line · `[`/`]` previous/next layer · `a` agent panel · `f` finish layer

## Tests

```bash
bunx vitest run                                              # stack inference, diff parsing, logs, findings parser
cd src-tauri && GH_TOKEN=$(gh auth token) cargo test -- --include-ignored   # worktree against a public repo
GH_TOKEN=$(gh auth token) bun scripts/smoke.ts <org> <owner/repo>           # read-only GitHub API smoke test
bun scripts/acp-probe.ts claude|gemini                                      # agent starts and reports capabilities
bun scripts/agent-settings-probe.ts claude|gemini                           # model/effort/mode switching over ACP (no prompt)
bun scripts/agent-e2e.ts                                                    # Claude Code uses the review tools across two layers (two short prompts)
bun scripts/agent-resume-probe.ts claude|gemini                             # conversation survives a restart via session/load (two tiny prompts)
```

## License

Stack Reviewer is free software: you can redistribute it and/or modify it under the terms of the [GNU General Public License](LICENSE) as published by the Free Software Foundation, either version 3 of the License, or (at your option) any later version. It is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the license for details.

The agents it runs (Claude Code, Gemini CLI and the ACP adapter) are separate programs installed by the user, under their own licenses.

## Releasing

Every push and pull request runs `.github/workflows/build.yml` (typecheck, tests and a debug build on macOS and Windows), except a `chore: release v…` commit, which the tag's release build covers. Releases come from `.github/workflows/release.yml`:

```bash
bun scripts/bump-version.ts 0.2.0          # sets the version in package.json, tauri.conf.json, Cargo.toml and Cargo.lock
git commit -am "chore: release v0.2.0"
git tag v0.2.0
git push && git push origin v0.2.0
```

Pushing the tag:
1. checks that it matches the app version;
2. creates a draft GitHub release with generated notes;
3. builds a universal macOS `.dmg`/`.app` and a Windows `.msi` and `-setup.exe`;
4. publishes the release once every build has uploaded.

A tag with a hyphen (`v0.2.0-beta.1`) is published as a pre-release; on Windows it ships only the `-setup.exe`, because MSI versions can't carry a pre-release label like `beta`. Builds aren't code-signed yet, so the release notes explain the macOS Gatekeeper and Windows SmartScreen prompts.
