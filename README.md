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

Sign-in options:
- **Use my GitHub CLI login**: imports the token from `gh auth login`.
- **Personal access token**: needs `repo` and `read:org`.
- **Sign in with GitHub** (device flow): appears once an org-owned OAuth app exists. Set `VITE_GITHUB_CLIENT_ID` at build time to enable it.

Tokens are stored in the OS keychain (`stack-reviewer` / `github`).

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
