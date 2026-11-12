# Stack Reviewer — v1 feature spec

A macOS + Windows desktop app for finding stacked pull requests in a GitHub org and reviewing them layer by layer, with a local AI agent alongside.

Status: v0.1 built (2026-11-12). See README.md for running and testing.

The UX concepts (A–D plus the chosen hybrid prototype) are in `docs/ux-prototype/` as static `.dc.html` pages.

## UX direction (hybrid)

Four concepts were scored on orientation, throughput, re-review, agent fit, signal and calm:
- A · three-pane IDE: 22
- **B · guided one-file pass: 24**
- C · agent-led walkthrough: 20
- D · files × layers matrix: 20

The chosen direction uses B's flow as the core and borrows from the others.

**Screens.** Home → Stack overview → Review.

- **Home** (`Home.dc.html`)
  - Sidebar: org picker, inbox sections (Needs my review / My stacks / Pinned / Recent), pinned repos, agent status, account.
  - A "since you last looked" strip: CI failures, new commits on layers you reviewed, new review requests.
  - Each stack row shows a strip of its layers (✓ approved, ● your turn, ! new commits, ✕ changes requested), check state, your progress and a "resume at" hint.
- **Stack overview** (`Overview.dc.html`)
  - Stack header with stats and **Resume review at layer N** as the primary action.
  - Layer cards from layer 1 upward, each with a one-line agent summary, review state, checks and counts.
  - The **files × layers matrix** (from D), shaded by change size, with markers for findings, CI root cause and viewed state.
  - Agent notes that cut across layers.
- **Review** (`Review.dc.html`)
  - **Left rail** (from A), collapsible to a strip of layer numbers: the stack's layers, then the files in *suggested reading order* with viewed checkboxes and finding/thread badges.
  - **Layer brief** (B, with C's reading order), collapsible: status, agent summary, reading-order chips, check summary with the agent's root-cause note and Why / Log / Re-run.
  - **One file at a time**:
    - Diff on the left, plus a **margin column** for agent findings (Draft / Dismiss / Undo) and existing threads. Findings are never shown inline, and never twice.
    - Action bar: ← Previous (k) · **Mark viewed & next (j)** · progress · **Finish layer…**
  - **Agent dock** on the right, toggled with `a`:
    - agent picker
    - context chips (layer diff, whole stack, checks + logs, worktree, *drafts only*)
    - chat
    - inline permission prompts (Allow once / Always in this repo / Deny)
    - "Go to next finding" button, since findings live in the margin rather than in the chat
  - **Finish layer** dialog:
    - shows viewed count, drafts to publish and untriaged findings, which stay private
    - verdict and an agent-drafted summary
    - **Submit and go to next layer**

**Visual language.**
- Dark, calm developer-tool look: Inter for the UI, JetBrains Mono for code.
- One blue accent (`#7AB0FF`) for actions. Amber (`#F5C77E`) is reserved for the agent and its findings.
- Severity is shown by label *and* colour.
- Layer state always pairs a glyph with a colour (✓ ● ! ✕).

Not designed yet: settings/agent setup, sign-in, the split diff layout, the "since my review" interdiff state, the checks log viewer, a light theme.

## Decisions

| Area | Decision |
|---|---|
| Stack source | GitHub native stacks (`GET /repos/{o}/{r}/stacks`) as source of truth, plus stacks **inferred** from PR base→head chains that aren't registered as stacks |
| Sign-in | OAuth device flow against an org-owned app; `gh` CLI token as dev/fallback |
| Review model | Guided layer-by-layer, bottom → top, with progress and resume |
| Agent GitHub writes | **Drafts only** — nothing reaches GitHub until the user submits |
| Local code | App-managed cache clone per repo + git worktree per layer |
| Proposed changes | GitHub ` ```suggestion ` blocks in review comments |
| Framework | Tauri 2 (Rust core) + React/TypeScript |
| Audience | The user first; team later (unsigned dev builds OK for now; signing + auto-update later) |
| GitHub actions in v1 | Approve / request changes / comment; reply to, resolve and unresolve threads; re-run failed checks. **No merging.** |
| Checks | Per-layer rollup + inline failing-log excerpts (agent can read them too) |
| Agent chat | One persistent conversation per stack; aware of the current layer |
| Agents on day one | Claude Code (via `claude-agent-acp` adapter), Gemini CLI (native ACP) |
| AI output | Chat + structured findings (severity, file:line, rationale, optional suggestion) → triage list + diff markers → accept as draft comment or dismiss |
| Diff must-haves | Changes since my last review (interdiff); "viewed" synced to GitHub; split/unified views, expand context, syntax highlighting, file tree; keyboard-first navigation + command palette |
| Accounts | github.com, one account, any org (defaults to the first org you belong to) |
| Freshness | Background polling (~60s, ETag/conditional requests) + OS notifications |
| Agent sandbox | Reads any file in the worktree; running commands needs in-app approval (allow once / always for this repo) |

## Feature areas

### 1. Sign-in & settings
- "Sign in with GitHub" via device flow (shows code, opens browser, polls). Token stored in the OS keychain.
- Detect and offer an existing `gh` CLI session.
- Handle SAML SSO: detect orgs whose access the token isn't authorised for, and link the user to authorise it.
- Settings: default org, pinned repos, clone cache location, agent configs, notification preferences, theme.

### 2. Discovery (home)
Sections:
- **Needs my review**: stacks with any open layer where I, or a team I'm on, am a requested reviewer, or where I'm assigned.
- **My stacks**: stacks I authored, with each layer's review and check status.
- **Browse by repo**: org repo picker and pinned repos; lists every open stack in a repo.
- **Recent / pinned stacks**: with review progress (e.g. "3 of 5 layers reviewed").

Each stack row shows: repo, title of the root layer, number of layers, author, a status strip per layer (review state, check state, my progress), and last updated.

Discovery pipeline: the search API (`is:pr is:open org:X review-requested:@me`, `author:@me`, `assignee:@me`) → the set of repos → `/stacks` for each repo (cached) → join with base→head inference for PRs not in a native stack.

### 3. Stack view
- Stack map / layer rail (bottom → top), showing each layer's state: not started, in progress, reviewed, stale (new commits since my review), approved or changes requested, check status.
- PR header for the current layer: title, description (markdown), author, reviewers, labels, base/head, mergeability.
- Tabs or panes: **Files** · **Conversation** · **Checks** · **Agent**.
- Moving to the next layer carries context with it. When a lower layer changes, the layers above it are flagged.

### 4. Files & diff
- File tree with filters (unviewed, has comments, has findings, by extension) and a per-file viewed checkbox (synced via GraphQL `markFileAsViewed` / `unmarkFileAsViewed`).
- Split and unified diffs with syntax highlighting, expand-context, word-level highlights. Virtualised so large layers stay fast.
- **Since last review**: store the head SHA (and base) at review time for each layer. The interdiff uses `git range-diff`-style comparison, so changes that only come from a restack on top of the base are separated from real changes.
- Inline threads, pending comments, and agent finding markers in the gutter.
- Comment composer with markdown preview and an "insert suggestion" action that pre-fills the selected lines.

### 5. Comments & review
- Read every thread (inline and top-level), reply, resolve or unresolve.
- A pending review per layer that collects my comments and accepted agent drafts.
- Submit as Comment / Approve / Request changes, with a summary.

### 6. Checks
- Rollup per layer (check runs + commit statuses), grouped by workflow.
- Expanding a failed job pulls its logs and shows the failing step, trimmed to the relevant part.
- Re-run failed jobs.
- Check status also appears in the layer rail and on home.

### 7. Agent panel
- Pick an agent (Claude Code, Gemini CLI). The app spawns it as an ACP subprocess with `cwd` set to the layer's worktree.
- On `session/new` the app passes its own **Stack Reviewer MCP server**, which gives the agent tools such as:
  - `get_stack`, `get_layer(pr)`, `get_layer_diff(pr)`, `get_file(path, ref)`
  - `list_threads(pr)`, `get_check_failures(pr)`
  - `add_finding(pr, path, line_range, severity, title, body, suggestion?)`
  - `draft_comment(pr, path?, line_range?, body)`
  - No tool writes to GitHub directly.
- Quick actions: "Review this layer", "Review whole stack", "Explain this file/hunk", "Why is CI failing?".
- Findings panel: sort by severity, jump to code, then Accept (becomes a pending draft, editable), Edit, or Dismiss.
- Permission prompts for command execution, shown inline in the chat.
- Conversation history saved per stack.

### 8. Background & notifications
- Polling with conditional requests and a rate-limit budget. The interval backs off when the app is idle.
- OS notifications for: new review request, a check failing on a stack I'm reviewing, new commits on a layer I've reviewed.

## Architecture sketch

```
React UI (Vite, TS)  ──Tauri IPC──  Rust core
  - diff viewer (@pierre/diffs, to evaluate)     - GitHub client (REST + GraphQL), poller, cache
  - layout, command palette, keyboard map        - token in OS keychain
  - agent chat + findings UI                     - SQLite: review progress, viewed/last-reviewed SHAs,
                                                   pending drafts, findings, chat history
                                                 - git: cache clones, worktrees, range-diff (git CLI)
                                                 - ACP client: spawn/manage agent subprocesses
                                                 - MCP server for agents (stdio sidecar → local IPC)
```

## Risks / things to verify early
1. **Stacks API is in preview** and has no REST reference docs yet; the response shape may change. Keep it behind an adapter and fall back to inference.
2. **Org app approval**: OAuth/GitHub App access to a company org probably needs an org owner (create the app inside the org). Use the `gh` token until then.
3. **WebKit vs WebView2**: build the diff viewer early and check it on both platforms.
4. **MCP transport**: ACP requires agents to support stdio MCP servers, while HTTP is optional. Plan on a small stdio sidecar that talks back to the app.
5. **Search API rate limit** (30 requests/min): batch queries, cache aggressively.
6. **Adapter packaging**: does the user install the agent CLIs themselves, or does the app detect them on PATH? Initial plan is to detect, with a configurable command.

## Out of scope for v1
Merging layers or stacks · creating or restacking stacks · agent pushing commits · multiple accounts / GHES · Graphite/ghstack metadata · Codex and arbitrary ACP agents (planned for v1.1) · signed builds and auto-update.
