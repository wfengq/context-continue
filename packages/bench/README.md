# @context-continue/bench

A reproducible bench that compares how much context six multi-agent approaches send to the model
while working through the same scripted project. It answers one question: does the project-board
approach (group C, the `@context-continue/core` library) use fewer tokens and keep a more stable
context than the alternatives?

## Disclaimer: scripted fake model

Every run uses a **scripted fake model** (`ScriptedModel`): bots reply with the text and tool calls
written in the scenario, and bots that are woken without a scripted step answer with a fixed idle
reply ("Noted."). The bench therefore measures **context size and request counts only**. It does
not measure task quality or consistency conflicts; those need a real model.

**A real model adapter is not implemented.** The `Model` interface in `src/model.ts` is the place
to add one later. The bench makes no network or model calls.

Groups B (Grok Bot style) and F (Dots + Space style) are approximations built from public
descriptions; group E approximates DS Bot at commit `f823773`. Group A (one agent) also stands for
single personal agents such as Muse or Duet.

## Groups

| Group | Approach |
|---|---|
| A | One agent does all the work with the full history |
| B | Grok Bot style: every bot rereads the whole group chat on every message |
| C | This project: the real core library's project board and briefs |
| D | DeLM style: shared log with per-reader deltas, deliverables by reference |
| E | DS Bot style group chat with windowed deltas, group memory and compaction |
| F | Dots + Space style: shared pages (project, current plan, one per delivered workstream) plus each bot's own history |

## Scenarios

`scenarios/` holds five scripted projects in two tiers.

**Standard scenarios** (20 to 40 steps each): `product-plan`, `flappy-bird` and `event-plan`. Every
one covers a mid-project change of requirements, a failed review, a review that adds a convention,
a replan and a question from one bot to another. Flappy Bird also contains an art-versus-game-logic
style conflict found in review.

**Long scenarios** (`tier: "long"`, 150 to 300 steps each):

- `long-app`: eight bots take a meal-planning app from requirements to an EU launch, starting with
  ten workstreams.
- `long-event`: six bots prepare a two-day developer conference (venue, call for papers and
  speakers, agenda, sponsors, tickets, promotion, on-site logistics, AV), starting with eight
  workstreams. Requirement changes come at other points than in `long-app`, and other workstreams
  fail review.

Each long scenario has at least four requirement changes from the human owner, each followed by a
replan that really changes the scope (new, removed or rewritten workstreams and contracts), at
least six failed reviews, at least eight new conventions, at least ten questions between bots, and
deliverables with several versions that grow (a first version is 300 to 1,500 characters, later
ones up to 3,000). They test how each approach copes when the history keeps growing and earlier
decisions are overtaken: how large requests get as the project goes on, and whether the
information a bot needs still reaches it.

Tool calls use the core library's tool names and argument shapes, because group C executes them
for real; in every scenario group C must finish the project with no core errors.

### Generating the long scenarios

The long scenarios are not written by hand. Deterministic generators in `src/gen/` (no randomness,
no clock) build them step by step and check the scenario rules as they go; the JSON files are
committed, and a test fails if regenerating them does not reproduce the committed files byte for
byte. After changing a generator, rewrite the files with:

```sh
pnpm -C packages/bench gen:scenarios
```

## Running

From the repository root:

```sh
pnpm install
pnpm -C packages/bench bench run --scenario all --group all
```

`--scenario standard` runs only the three standard scenarios and `--scenario long` only the two
long ones; `all` runs all five.

The `bench` script builds the core library and the bench, then runs `node dist/cli.js`. With
`pnpm -C packages/bench`, the working directory is `packages/bench`, so the default output lands in
`packages/bench/results/`. Results are written to `<out>/<stamp>/results.json` (every request record and the metrics) and
`<out>/<stamp>/report.md` (one table per scenario and the summary tables). The `results/` directory is
ignored by git.

### Flags

| Flag | Default | Meaning |
|---|---|---|
| `--scenario <id\|path.json\|standard\|long\|all>` | required | A scenario id from `scenarios/`, a path to a scenario JSON file, `standard` (the three standard scenarios), `long` (the two long ones) or `all` (all five) |
| `--group <A..F\|all>` | required | One group or all six |
| `--window <n>` | `128000` | Group E: assumed context window in tokens |
| `--compact-ratio <r>` | `0.8` | Group E: compact when history exceeds window x ratio |
| `--summary-tokens <n>` | `1500` | Group E: size of the summary that replaces compacted history |
| `--cache-ratio <r>` | `0.1` | Cost weight of cacheable tokens (uncached tokens weigh 1) |
| `--out <dir>` | `results` | Output directory, relative to the current working directory |
| `--stamp <s>` | UTC time `YYYYMMDDTHHmmssZ` | Name of the run's subdirectory |

Each flag may be given once. `--stamp` must be a plain name (letters, digits, `_`, `.`, `-`, not only
dots). Output is deterministic: two runs with the same inputs and `--stamp` produce byte-identical files.
An invalid scenario, group or flag value prints a message on stderr and exits with a non-zero code.

## Reading the results

- Standard and long scenarios are summarised separately: the report has one summary table per tier
  present in the run ("Summary (standard scenarios)", "Summary (long scenarios)") and never adds
  the two tiers together, because the long scenarios would swamp the standard ones. Long scenarios
  also get a table of the average request size per 25 steps, showing how each group grows.
- Group A is a single-agent baseline, not a multi-bot alternative. Its one append-only history is
  mostly cacheable, so A can be the cheapest group on cost units even though it has no team at all.
  Compare the multi-bot groups (B to F) with each other, and A only as a reference point.
- Even the long scenarios stay well below the default 128,000-token window, so group E's
  compaction does not trigger by default. Pass a smaller `--window` (for example `--window 2000`) to see it.
- Wake counts (extra requests) for groups D, E and F depend on how often humans and bots
  @-mention each other in the scenario. A scenario with more or fewer mentions shifts these groups.
- Cost units weight cacheable tokens by `--cache-ratio`; raw input tokens and the context-size
  columns show the size of what each request carries, independent of caching.
- One cacheable rule applies to every group: the longest leading run of a request's segments that
  is identical to the same bot's previous request (on a bot's first request, only the fixed
  template). In group C a segment must also be flagged cacheable by the core; the report adds a
  per-scenario upper-bound line for a provider that caches the core's stable segments wherever
  they are.
- Reviewers in D and E get a reference to a deliverable, not its text; C's lead reviews with the
  core's review context, which carries the text; F has shared pages but no chat thread; C, E and F always carry the goal and constraints, A, B and D only through human
  messages. The report's caveats list these and the other modelling choices.

## Fact visibility

Saving tokens is only useful if the bots still see what they need. Every scenario lists key
facts (a requirement change, a new convention, an interface contract, a recorded failure), each
with a unique marker such as `CONV-TIMES-24H`, the step that introduces it and its audience (the
bots that need to know it, or all of them).

- An **opportunity** is a scripted request by a bot in the fact's audience after the step that
  introduced the fact. Extra requests (a bot woken without a scripted step) do not count.
- A **hit** is an opportunity whose full request text contains the marker.
- Visibility is hits / opportunities, per group, per scenario and per fact; with no opportunities
  the report prints `n/a`.

Limits: the matching is literal, so a group that carries a fact in other words (a summary, a
paraphrase, a field of a structured brief) counts as missing it; real comprehension needs a real
model. Group E's compaction summary is assumed to keep every marker seen before compacting, which
favours E. A marker only reaches a bot through the text a group puts in its context, so where a
fact is written (a chat message, a tool call, a deliverable) affects groups differently; the
report's caveats list these effects.

What reaches whom:

- Tool-call arguments (a decision's rationale, a failure's reason, a review's notes and
  conventions, a plan) are rendered in the author's own history only; other bots see what the call
  changes (a page in F, a board item in C, a deliverable) but not the arguments. A `sendMessage`
  text is a posted message that B, D and E share, posted once: not again when the same step's
  reply already contains it.
- Group C's lead reviews with the core's review context (the deliverable's text and the reviewed
  workstream's contracts, conventions, decisions, facts and failures) and replans with the core's
  planning context (every human message so far and the previous plan). Both carry the lead's
  cacheable prefix (common, memory, workspace, board) and the bench passes them the trigger a brief
  would carry (the task line, wakes merged into the step and tool results not yet shown to the
  lead), which the core renders as the last segment.
- Group C's misses come from three core behaviours, reported as results rather than patched in
  the bench (see "Known gaps" in `packages/core/README.md`):
  1. Relevance projection: a bot's brief shows board items (failures, contracts) of its own part of
     the plan only, while many facts concern everyone.
  2. Seen-compression: once a bot has acted on a brief that showed a board item, later briefs show
     it compactly without its text (a contract without its spec, other items cut short), so the
     marker can drop out of a later scripted request.
  3. Chat shown once: a chat message reaches a bot once (in its delta, its trigger or the planning
     context) and afterwards only where a board item restates it. The lead owns no workstream, so it
     loses a change after that; a fact written only as bot chat never reaches the board. An
     extraction model (`models.extract`, not used by the bench) would only turn human chat into
     board items.
- Scenario text follows one marker rule (R-L11): wherever a fact's content is restated later
  (replies, messages, deliverables, replanned briefs, contract specs, review notes), the text
  carries the fact's marker, so a group that only sees the restatement still counts a hit.

## Development

```sh
pnpm -C packages/bench test
pnpm -C packages/bench typecheck
```
