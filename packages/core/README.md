# @context-continue/core

A library that gives a team of bots working on one project a shared, structured memory instead of a shared chat history. It keeps an append-only project ledger, a small project board (goal, conventions, workstreams, contracts, decisions with their rationale, facts, failures, open questions), private per-bot notes and long-term employee memories. For each bot and each wake-up it assembles a brief: the part of the board that concerns that bot plus what changed since it last looked. The library never calls a model itself; the host runs the models and passes optional functions in.

## Install

Requires Node.js 22.5 or newer (the SQLite store uses `node:sqlite`). The only runtime dependency is `zod`. The package is not published yet; build it from this repository:

```sh
pnpm install
pnpm -C packages/core build   # writes dist/index.js and type declarations
```

## Minimal example

```ts
import { createEmployeeRegistry, createProject, sqliteStore } from '@context-continue/core';

const store = sqliteStore('project.sqlite'); // or memoryStore() for tests
const employees = createEmployeeRegistry({ store });
await employees.upsert({ botId: 'pm', persona: 'Project lead', skills: [] });
await employees.upsert({ botId: 'art', persona: 'Pixel artist', skills: ['sprites'] });

const project = createProject({ projectId: 'demo', store, employees });
await project.start({ goal: 'Ship a tiny platformer', constraints: ['Runs in the browser'], lead: 'pm', by: 'alice' });

// The lead proposes a split, the owner approves it. Both calls return who to wake and why.
const { proposalId } = await project.proposePlan(
  {
    workstreams: [{ id: 'art', title: 'Sprites', brief: 'Draw the sprites.', owner: 'art', dependsOn: [] }],
    contracts: [],
  },
  { by: 'pm' },
);
const wakes = await project.approvePlan(proposalId, { by: 'alice' }); // [{ botId: 'art', reason: 'assigned', ... }]

// Build the brief for a woken bot and hand it to your model.
const brief = await project.buildBrief('art', {
  maxTokens: 6_000,
  trigger: { reason: 'assigned', detail: 'workstream art can start' },
});
// brief.segments: { kind, text, cacheable }[]   brief.tools: tool definitions for this bot

// When the model calls one of brief.tools, run it through the core.
await project.callTool('art', 'submitDeliverable', { workstreamId: 'art', summary: 'sprite sheet', content: '...' });
```

`callTool` checks that the bot is a member of the project, that lead-only tools (`proposePlan`, `resolveProposal`, `submitReview`, `listPending`, `unblockWorkstream`) are called by the lead, and that the arguments are valid. It fails with a `ContextError` carrying a `code` such as `NOT_A_MEMBER`, `FORBIDDEN` or `INVALID_OP`. Every call also returns or emits the wake-ups it caused, so the host knows which bots to run next (`project.on('wake', ...)`).

A `sendMessage` without `replyTo` replies to the chat message that woke the bot (if it has not posted since and has not been woken for another reason since), so bot-to-bot exchanges form reply chains and stop at `maxHops`; bot requests, queries and proposals outside any human-rooted chain are also capped at `maxBotTurnsPerHumanMessage` until the next human message or project event (plan approval, deliverable, review, block or board merge), after which `wakeLimitReached` is emitted once.

## Brief segments and prompt caching

`buildBrief` returns seven segments in a fixed order:

| # | kind | cacheable | content |
|---|------|-----------|---------|
| 1 | `common` | yes | shared team description and member list |
| 2 | `memory` | yes | the bot's persona, skills, pinned and recent memories, summary |
| 3 | `workspace` | yes | the bot's private notes |
| 4 | `board` | yes | goal, constraints, conventions, workstream list |
| 5 | `projection` | no | the bot's own workstreams, contracts, decisions, facts, failures, upstream deliverables |
| 6 | `delta` | no | events and board changes relevant to the bot since it last looked |
| 7 | `trigger` | no | why the bot was woken |

Segments 1 to 4 are the cacheable prefix, ordered from most to least stable. Keep them first and in this order when you build the prompt, and put the provider's cache breakpoint after segment 4. They contain no timestamps or other volatile content. Segment 1 is byte-identical for every member, so it is the only part of the prefix shared across bots; segments 2 and 3 are per-bot (memory changes when the bot's memory does, workspace when it writes notes), and segment 4 is the same for every member at one board version but sits after the per-bot segments, so it is only reused by the same bot. The board changes most often, which is why it comes last: a board merge invalidates the cache from segment 4 on and leaves segments 1 to 3 reusable. Everything that changes from turn to turn is in segments 5 to 7. Items shown in full in a brief count as seen once that bot next calls `callTool` (any tool, even a failing one); until then they are shown in full again. Facade methods called directly (for example `project.submit`) and `peek: true` briefs do not confirm, and building a review or planning context discards the lead's pending items. Items already seen are shown in a short form.

`buildPlanningContext(opts?)` and `buildReviewContext(deliverableId, opts?)` build the lead's context with the same cacheable prefix: `common`, `memory`, `workspace`, `board` (cacheable), then the body as `projection` (not cacheable). The first four are byte-identical to the lead's untrimmed `buildBrief` at the same moment (a lead without a workspace or memory gets the same defaults, and none is created). Pass `opts.trigger` (`{ reason, detail }`, rendered like the brief's trigger) to append a final non-cacheable `trigger` segment. Put the cache breakpoint after segment 4, as for a brief, so planning, review and the lead's own briefs reuse one prefix. Before this change, planning and review contexts had three segments (`common`, `board`, `projection`); select a segment by its `kind`, not by index. `buildRetroContext` is unchanged.

### Optional public board sections

`createProject({ …, publicBoard: { directives?, contracts?, failures? } })` switches on extra sections of the `board` segment (exported type `PublicBoardSwitches`). `directives` is on by default (an omitted `publicBoard`, or an omitted `directives` key, means on; `{ directives: false }` turns it off), while `contracts` and `failures` are off by default; with `{ directives: false }` every output is byte-identical to the previous default (no optional section); a non-boolean switch throws `INVALID_OP` and unknown keys are ignored, as for `options`. With directives on (the default) the board gains a `## Directives` section between Constraints and Conventions: every human chat message verbatim, oldest first, one line `- [#<seq> <author id>] <text>` each (ledger authors carry only an id). Only the newest `options.directivesKeep` (default 20) are shown, after a line `(N earlier directives omitted)`. Human chat then no longer appears in any bot's `delta` (it is on the board); wake-ups are unchanged, and the planning body still lists every human message. Planning, review and retrospective contexts render the same board segment as a brief at the same moment. Board-size archiving (`boardMaxTokens`) and the router input use the base board without the optional sections, so a switch never archives anything. The board segment now changes on every human message, which invalidates the cache from segment 4 on. With `contracts: true` the board gains a `## Contracts` section after Conventions listing every contract, one line `- [<id>@<version>] <from> → <to>: <spec>` each; with `failures: true` a `## Failures` section follows, every failure in the projection's three-line layout (`- [<id>] tried: …`, `why it failed: …`, `affects: …`). The order is Goal, Constraints, Directives, Conventions, Contracts, Failures, Workstreams. A switched-on section is no longer repeated elsewhere: the projection and the review body drop their `## Contracts` or `## Failures` section, heading included (so those items are never marked seen), while with the switch off both are byte-identical to before. With contracts on, the review instruction points the lead to the contracts involving the reviewed workstream in the board's Contracts section. Board items are always shown in full; the seen rule applies only to the projection. `options.directivesKeep` must be an integer of at least 1. The board segment (segment 4) is never trimmed to fit `maxTokens`, so long directives, contracts or failures can make `buildBrief` throw `BudgetTooSmallError`; lower `directivesKeep` or raise the budget.

**Behaviour change (2026-11-04):** hosts that do not set `directives` now get the Directives section and human chat leaves the delta; pass `publicBoard: { directives: false }` for the previous output. Setting only `contracts` or `failures` also keeps directives on.

## What the host does

- Runs the models. The core never calls one.
- Turns `brief.segments` into the provider's prompt format and cache markers, and exposes `brief.tools` to the model.
- Wakes the bots named in the returned wake-ups, and shows `needsHuman` events to a person. `project.pending()` lists the pending board proposals (those with `needs: 'human'` wait for the owner's `resolveProposal`); the lead sees its own through the `listPending` tool and returns a blocked workstream to work with `unblockWorkstream`.
- Optionally passes `models.route(input)` (picks the bots for a chat message that mentions nobody and matches no workstream), `models.extract(entries, board)` (turns human chat into board operations) and `models.condense(input)` (writes the rolling summary when notes or memories grow too long). Without `route`, such a message goes to the lead; without `extract`, nothing is extracted from chat; without `condense`, the oldest notes are dropped when over budget. A failed `condense` keeps the original and emits `condenseAborted`.
- Optionally passes a `workstreams` source when workstream status already lives in a host task board.
- Calls `project.exportMarkdown()` and `employees.exportMarkdown(botId)` when a person wants to read the board or review an employee's memories, and `employees.deleteMemory(botId, memoryId)` to delete a wrong one.

The state lives in the `Store`. A new `createProject` over the same store resumes with the same briefs, routing, extraction progress and pending lead timeouts.

## Known gaps

Behaviours a multi-bot benchmark (`packages/bench`) shows as missed facts. The first two are design
trade-offs that keep briefs small, not bugs; the third is a candidate for follow-up work.

- **Relevance projection (trade-off).** A bot's brief shows board items such as failures and
  contracts for its own part of the plan only; facts that concern everyone reach a bot only when
  they touch its part.
- **Seen-compression (trade-off).** Once a bot has acted on a brief that showed a board item, later
  briefs show the item compactly without its text (a contract without its spec, other items cut
  short); the bot fetches the full item with a tool when it needs it.
- **Chat is shown once.** A chat message reaches a bot once (in its brief's delta, the wake's trigger
  or the planning context) and afterwards only where a board item restates it. The lead owns no
  workstream, so it can lose a requirement change after that, and a fact written only as bot chat
  never reaches the board. `models.extract` turns human chat into board operations; without it,
  nothing is extracted, and even with it bot chat is not.

## Limits

An MCP-only integration cannot reduce a closed product's own full-history re-reads. Exposing the tools and briefs over MCP lets several bots share one project board and receive their own projection and updates, but the closed product still re-reads its own conversation history on every turn, and the core cannot change that.
