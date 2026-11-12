# Guide me — feature spec

Status: spec and UX agreed, not built.

## Goal

Before reviewing a stack, the reviewer asks an agent to read the whole stack and produce a guide:

- a digestible summary of what the stack does as a whole,
- how complex each layer is **relative to the other layers in the stack**,
- for each layer, where to spend review attention.

The guide orients; it does not judge. It never records findings (the existing "Review with agent" does that) and never posts anything to GitHub.

## Decisions

| Question | Decision |
| --- | --- |
| Where it runs | In the stack's existing whole-stack agent chat. Follow-ups ("why is #412 heaviest?") have the full context. The chat is busy while the guide runs. |
| Complexity | Tier (Light / Moderate / Heavy) + rank within the stack (hardest first) + one-line reason. The app shows its own size stats (files, +/−) beside it. |
| Findings | None. Guide only. |
| Per-layer guide | Focus areas anchored to lines, files that are safe to skim, questions for the author. No reading order. |
| Stack summary | What the stack does, the role of each layer, cross-layer concerns, a suggested plan. |
| New commits | The layer's guide is marked stale; "Refresh guide" re-runs only stale layers and re-ranks. Never automatic. |
| Focus areas | A checklist. Ticks show as layer progress ("2 of 3 focus areas"); Finish reminds you about unticked ones but never blocks. |

## User flow

1. **Overview → Guide me.** A button in the overview header (next to the stack actions). It opens a small launch popover:
   - agent (Claude Code / Gemini / custom agents from Settings), model, and effort, prefilled from the per-agent preferences the dock already uses (`prefs` in `src/agent/settings.ts`);
   - a scope line: "Guides the N open layers; merged and closed layers are skipped";
   - a reminder: "Runs in this stack's agent chat. Read-only: no findings, nothing posted."
   - **Start guide**.
2. **While it runs** the reviewer stays on the overview. Layers fill in bottom-up as the agent finishes each one (queued → reading → guided). The stack summary appears last, because ranking needs every layer. A "View chat" link opens the review page with the dock open; **Stop** cancels the run.
3. **When it's done** the overview shows the stack guide card, and each layer row shows its tier, rank and focus-area progress.
4. **On the review page**, each layer's brief card gains a Guide section: tier and rank with the reason, the focus-area checklist (click to jump to the lines), files to skim, and questions for the author. Focus-area ranges are marked in the diff gutter; skim files are tagged in the file list.
5. **Finish dialog**: if focus areas on this layer are unticked, it lists them with "Jump" links above the verdict. It never blocks.

If the run stops partway (cancelled, error, agent quit), the layers already guided keep their guides; the overview shows "Guided 7 of 16 · Continue", which resumes with the remaining layers.

## What the agent produces

### Per layer (`set_layer_guide`)

| Field | Content |
| --- | --- |
| `pr` | Layer PR number. |
| `summary` | 2–3 sentences on what the layer does. Becomes the layer's brief summary (as `set_layer_brief` does today, with no reading order). |
| `tier` | `light` \| `moderate` \| `heavy`, judged against the other layers in this stack. |
| `tier_reason` | One line: why this tier (e.g. "new concurrency around token refill; the rest is plumbing"). |
| `focus_areas` | 1–5 items: `{ path, start_line?, line, title, why }`. Lines are new-side lines in this layer's diff. Ordered by importance. |
| `skim` | 0–n items: `{ path, why }`. Mechanical changes: renames, generated code, fixtures, lockfiles, pure moves. |
| `questions` | 0–4 short questions the diff and description don't answer. |

### Whole stack (`set_stack_guide`, called last)

| Field | Content |
| --- | --- |
| `summary` | Markdown, one short paragraph: the goal and the end state once every layer lands. |
| `layer_roles` | `{ pr, role }[]`: one line per layer on its part in the story. |
| `cross_layer` | `{ text, prs[] }[]`: concerns visible only across layers (an API added low and changed higher, a migration split across PRs, a layer that undoes another). May be empty. |
| `plan` | Markdown, 1–3 sentences: where to spend time ("most of the risk is in #412 and #415; #413–414 are mechanical"). |
| `ranking` | Every guided PR number, hardest first. The app derives "2nd hardest of 5" from it. |

Validation, like `add_finding` today:
- **Focus areas**: a range must be a valid range on the new side of the layer's diff (`validRange` in `src/lib/diff.ts`). If it isn't, the tool returns an error naming the valid hunks so the agent retries.
- **Skim paths**: must be files changed in that layer.
- **Ranking**: must contain each guided PR exactly once.

Agents without HTTP MCP support use fenced ```` ```guide ```` JSON blocks, parsed the same way as ```` ```findings ```` blocks are now.

## Prompt outline (`guideStackPrompt`)

- Guide the stack bottom-up over the listed open layers. Use `get_review_context` per layer and `git diff <base_sha> <head_sha>`, as the whole-stack review prompt does.
- Judge complexity **relative to the other layers**: risk, how much needs to be understood rather than skimmed, new concepts, concurrency/security/data changes, cross-cutting reach. Size alone is not complexity: a 900-line fixture is Light.
- Call `set_layer_guide` for each layer as soon as it's done, so the reviewer sees progress. You may revise a tier later with another call.
- After the last layer, call `set_stack_guide` with the ranking of every layer.
- Don't record findings, edit files or post anything. Keep the final chat message to a few lines; the guide lives in the app.
- On refresh: the prompt lists only the stale layers, includes the current guides of the other layers (tier, reason, role) so the ranking can be redone without rereading them, and asks for `set_stack_guide` again.

## Data model

Stored in the durable store (`src/lib/durable.ts`), in a new `guide` namespace keyed per stack. Ticks live in `reviewStore` so a refresh doesn't wipe the reviewer's own state.

```ts
type Tier = "light" | "moderate" | "heavy";

type LayerGuide = {
  pr: number;
  headSha: string;           // head the agent read; stale when the layer's head moves
  agent: string;             // "Claude Code · Opus 5.5 · high"
  createdAt: number;
  tier: Tier;
  tierReason: string;
  focus: { id: string; path: string; startLine?: number; line: number; title: string; why: string }[];
  skim: { path: string; why: string }[];
  questions: string[];
};

type StackGuide = {
  stackKey: string;
  agent: string;
  createdAt: number;
  summary: string;
  layerRoles: { pr: number; role: string }[];
  crossLayer: { text: string; prs: number[] }[];
  plan: string;
  ranking: number[];
  layers: Record<number, LayerGuide>;
  run?: { status: "running" | "stopped" | "done" | "error"; pending: number[]; error?: string };
};

// reviewStore PrState gains:
focusDone?: string[];        // focus ids ticked by the reviewer
```

A focus `id` is a hash of `path + title`. A refresh that keeps the same focus area keeps its tick.

**Staleness:** a `LayerGuide` is stale when its `headSha` isn't the layer's current head. The stack guide is stale when any layer is stale or the set of open layers has changed. Stale parts stay visible, marked "out of date".

## Where it shows up

**Overview**
- Header: **Guide me** (or **Refresh guide** with a stale count, or **Stop** while running).
- Stack guide card above the layer list. It holds:
  - the summary and the plan;
  - cross-layer concerns as chips linking to their layers;
  - the agent and time it was made.
  - It collapses to one line when you don't need it.
- Each layer row: tier pill, rank ("2nd of 5"), and "focus 1/3"; while running, a per-layer status.
- On large stacks (more than 8 layers), these must fit the existing compact layout and the hover-linking matrix.

**Review page** (see UX pass below for the chosen layout)
- Brief card: one guide line with the tier, rank, reason and skim files, plus "N questions for the author". The questions open in a popover, each with "Ask in a comment", which adds "Question for the author: …" to the layer's pending review summary (the review body, posted only when you submit; the app has no separate top-level draft).
- Sidebar: a Focus checklist between the stack rail and the files.
- Diff: a label row at the start of each focus range (title, why, Tick), plus an amber gutter bar along the range, distinct from finding markers.
- File list: a "skim" tag on skim files; filters gain "Hide skim files".
- Rail: a tier dot per layer, so the hardest layers stand out at a glance.
- Command palette: "Guide me", "Refresh guide", "Next focus area".

**Finish dialog:** a list of unticked focus areas with jump links.

## Implementation notes

- Starting the stack agent session currently lives in `AgentDock` (worktree prepare, `session.start`), and the stack bridge is registered in `Review.tsx`. Both move into a shared hook (e.g. `useStackAgent(stack)`) that the overview can call, so the guide can start without opening the review page.
- New bridge methods: `setLayerGuide(pr, input)` and `setStackGuide(input)`, each returning `ToolResult` for validation errors. Add two tools to `TOOLS` in `src/agent/mcpServer.ts`; both are auto-approved like the other own tools, with toolLabels "Guided layer #N" and "Wrote the stack guide".
- Run state: the session tracks that it's running a guide (prompt sent, layers pending) so the overview can show progress. A layer is "reading" when the agent's last `get_review_context` was for it, and "guided" when `set_layer_guide` lands.
- Size stats come from data the app already has (`additions`, `deletions`, changed-file count), never from the agent.
- Large stacks: the prompt asks for terse output per layer. A large stack in one turn is the expected worst case; test on a large real stack captured with `scripts/snapshot.ts`.

## Acceptance

- From the overview, choosing an agent, model and effort and starting a guide fills in each open layer bottom-up, then the stack summary, without leaving the page.
- Each layer gets a tier, rank, reason, 1–5 focus areas on valid diff lines, skim files and questions. The ranking covers every guided layer exactly once.
- On the review page, focus areas jump to their lines, can be ticked, and survive a restart. Finish lists unticked ones.
- A new commit on a layer marks only that layer stale. Refresh re-runs only that layer and updates the ranking. Ticks on unchanged focus areas survive.
- Stopping partway keeps finished layers; Continue finishes the rest.
- Nothing is posted to GitHub; no findings are created.
- Works with Claude Code (MCP tools) and Gemini (fenced-block fallback); works in `?demo` with fixture guide data.

## Out of scope

- Automatic refresh on new commits.
- Sharing or posting the guide to GitHub.
- Ranking across stacks (inbox ordering by complexity).
- Reading order in the guide (the existing brief reading order stays as is).

## UX pass (draft)

Mockups: `docs/ux-prototype/guide-me/` (static `.dc.html` artboards built from the app's own tokens).

**Visual language**
- Everything the guide produces uses the agent amber (`--agent`, `--agent-bg`, `--agent-bd`), as the dock and the Agent button do. That keeps "the agent's opinion" visibly apart from GitHub state (blue/green/red) and finding severity.
- **Tier is a 3-bar meter** (1, 2 or 3 bars filled), so shape carries the tier and colour isn't needed. The same glyph appears in the overview rows, the matrix column headers, the review-page rail and the brief. The word ("Heavy · 1st") goes alongside where there's room; elsewhere it's in a tooltip.

**Overview**
- **Guide me** sits in the title row between the title and Pin, styled like the Agent button. It opens a popover with the agent, model, effort (segmented control), the scope line and **Start guide**.
- While the guide runs, the guide card holds:
  - "Guiding layer 3 of 5";
  - a segmented progress bar;
  - the file the agent is reading;
  - **View chat** and **Stop**.
  - Each row shows Guided (with tier), Reading or Queued. Rank only appears once `set_stack_guide` lands.
- When it's done, the guide card holds:
  - the summary and the plan, with layer links;
  - a **Hardest first** ladder (rank, meter, tier, PR, title);
  - the agent and age, **View chat**, **Re-run…** and **Collapse**.
- Cross-layer concerns join the existing **Across layers** strip as amber-dotted cards, next to the app's own cards (failing checks, changed since review).
- Layer roles replace the description excerpt in each row. Each row gains a tier pill with rank, plus "focus 1/3" in the stats line.
- The matrix gains a tier meter under each column number, and an amber outline on cells that hold a focus area.
- Large stacks (more than 8 layers): the card collapses to one line (heaviest layers + plan, with the out-of-date count and **Refresh guide**). Rows show meter + rank + "stale" + focus count, and a **Bottom first / Hardest first** toggle reorders the list.

**Review page**: **decided: B, plus A's diff label rows.** These were the two placements considered:
- **A. Guide in the brief card.** Tier/rank/reason line, then three columns: the focus checklist (each with its why), safe to skim, and ask the author. In the diff, a label row opens each focus range, with an amber gutter bar along the range. Complete, but the brief card grows about 150 px taller and the diff shrinks.
- **B. Focus list in the sidebar.** The brief keeps one guide line (tier, reason, skim files, "1 question for the author"). The focus checklist lives in the sidebar between the stack rail and the files. In the diff, the gutter bar plus an inline chip at the range start. The diff keeps its height; the why text moves to the diff label/tooltip.
- **Chosen: B, with A's diff label rows.** Each focus range in the diff opens with a label row: "Focus N", the title, the why, and a Tick button. An amber gutter bar runs along the range and dims once the area is ticked. The why stays visible where you're reading, and the diff keeps its height.

**Both placements also add**
- File filters gain **Focus N** and **Hide skim**.
- Files carry `skim` / `focus N` tags.
- `.` jumps to the next focus area.
- The bottom bar shows "focus 1/3".
- The rail shows each layer's meter.

**Finish dialog**: an amber box above the verdict lists unticked focus areas with **Jump** and **Tick**, and says it's only a reminder.
