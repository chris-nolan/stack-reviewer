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

Agents never write to GitHub. `add_finding` only accepts lines that appear in the diff. Each finding goes into the margin, where you choose **Draft** or **Dismiss**.

## Keyboard (Review screen)

`j` mark viewed & next · `k` previous file · `v` toggle viewed · `n`/`p` next/previous change · `c` comment on the focused line · `[`/`]` previous/next layer · `a` agent panel · `f` finish layer

## Tests

```bash
bunx vitest run                                              # stack inference, diff parsing, logs, findings parser
cd src-tauri && GH_TOKEN=$(gh auth token) cargo test -- --include-ignored   # worktree against a public repo
GH_TOKEN=$(gh auth token) bun scripts/smoke.ts <org> <owner/repo>           # read-only GitHub API smoke test
bun scripts/acp-probe.ts claude|gemini                                      # agent starts and reports capabilities
bun scripts/agent-settings-probe.ts claude|gemini                           # model/effort/mode switching over ACP (no prompt)
bun scripts/agent-e2e.ts                                                    # Claude Code calls the review tools (one short prompt)
```
