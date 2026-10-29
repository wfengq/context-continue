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

`callTool` checks that the bot is a member of the project, that lead-only tools (`proposePlan`, `resolveProposal`, `submitReview`) are called by the lead, and that the arguments are valid. It fails with a `ContextError` carrying a `code` such as `NOT_A_MEMBER`, `FORBIDDEN` or `INVALID_OP`. Every call also returns or emits the wake-ups it caused, so the host knows which bots to run next (`project.on('wake', ...)`).

## Brief segments and prompt caching

`buildBrief` returns seven segments in a fixed order:

| # | kind | cacheable | content |
|---|------|-----------|---------|
| 1 | `common` | yes | shared team description and member list |
| 2 | `board` | yes | goal, constraints, conventions, workstream list |
| 3 | `memory` | yes | the bot's persona, skills, pinned and recent memories, summary |
| 4 | `projection` | no | the bot's own workstreams, contracts, decisions, facts, failures, upstream deliverables |
| 5 | `workspace` | no | the bot's private notes |
| 6 | `delta` | no | events and board changes relevant to the bot since it last looked |
| 7 | `trigger` | no | why the bot was woken |

Segments 1 to 3 are the cacheable prefix. Keep them first and in this order when you build the prompt, and put the provider's cache breakpoint after segment 3 (or after segment 2 if you want the prefix shared across bots). They contain no timestamps or other volatile content: segments 1 and 2 are byte-identical for every member at the same board version, and segment 3 is stable for one bot until its memory changes. Everything that changes from turn to turn is in segments 4 to 7. Items a bot has already seen in full are shown in a short form afterwards; `peek: true` renders a brief without marking anything as seen.

## What the host does

- Runs the models. The core never calls one.
- Turns `brief.segments` into the provider's prompt format and cache markers, and exposes `brief.tools` to the model.
- Wakes the bots named in the returned wake-ups, and shows `needsHuman` events to a person.
- Optionally passes `models.route(input)` (picks the bots for a chat message that mentions nobody and matches no workstream), `models.extract(entries, board)` (turns human chat into board operations) and `models.condense(input)` (writes the rolling summary when notes or memories grow too long). Without `route`, such a message goes to the lead; without `extract`, nothing is extracted from chat; without `condense`, the oldest notes are dropped when over budget. A failed `condense` keeps the original and emits `condenseAborted`.
- Optionally passes a `workstreams` source when workstream status already lives in a host task board.
- Calls `project.exportMarkdown()` and `employees.exportMarkdown(botId)` when a person wants to read the board or review and delete an employee's memories.

The state lives in the `Store`. A new `createProject` over the same store resumes with the same briefs, routing, extraction progress and pending lead timeouts.

## Limits

An MCP-only integration cannot reduce a closed product's own full-history re-reads. Exposing the tools and briefs over MCP lets several bots share one project board and receive their own projection and updates, but the closed product still re-reads its own conversation history on every turn, and the core cannot change that.
