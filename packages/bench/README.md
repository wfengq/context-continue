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

The scripted run never calls a real model and makes no network calls. Only the optional fact
probes (`--probes`, below) send requests to a real model (`src/models/anthropic.ts`); they are kept
apart from the scripted run and never change its records or metrics.

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

`scenarios/` holds six scripted projects in three tiers.

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

**Extra-long scenario** (`tier: "xlong"`, 1,000 to 1,500 steps): `xlong-product`, 1,154 steps in
which eight bots take a collaborative documents product through six release cycles (accounts,
billing, collaboration, offline, export, compliance). Each cycle replaces the delivered workstreams
with new ones and has its own requirement changes, failed reviews, conventions, questions and
recorded failures; conventions and contracts from early cycles are restated in later ones, so 45
facts include many that are still needed hundreds of steps after they are told. It is long enough
for group E to compact at the default window.

Tool calls use the core library's tool names and argument shapes, because group C executes them
for real; in every scenario group C must finish the project with no core errors.

### Generating the long and extra-long scenarios

The long and extra-long scenarios are not written by hand. Deterministic generators in `src/gen/` (no randomness,
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
long ones; `xlong` runs the extra-long tier (1,000 to 1,500 steps; `tier: "xlong"`), currently
`xlong-product`. `all` runs every listed scenario (currently the six).

The `bench` script builds the core library and the bench, then runs `node dist/cli.js`. With
`pnpm -C packages/bench`, the working directory is `packages/bench`, so the default output lands in
`packages/bench/results/`. Results are written to `<out>/<stamp>/results.json` (every request record and the metrics) and
`<out>/<stamp>/report.md` (one table per scenario and the summary tables). The `results/` directory is
ignored by git.

### Flags

| Flag | Default | Meaning |
|---|---|---|
| `--scenario <id\|path.json\|standard\|long\|xlong\|all>` | required | A scenario id from `scenarios/`, a path to a scenario JSON file, `standard` (the three standard scenarios), `long` (the two long ones), `xlong` (the extra-long one) or `all` (all six) |
| `--group <A..F\|all>` | required | One group or all six |
| `--window <n>` | `128000` | Group E: assumed context window in tokens |
| `--compact-ratio <r>` | `0.8` | Group E: compact when history exceeds window x ratio |
| `--summary-tokens <n>` | `1500` | Group E: size of the summary that replaces compacted history |
| `--cache-ratio <r>` | `0.1` | Cost weight of cacheable tokens (uncached tokens weigh 1) |
| `--c-public <default\|none\|all\|list>` | `default` | Group C only: which optional public-board sections the core renders. `default` passes no `publicBoard`, so the core's own default applies (directives on, contracts and failures off); `none` passes all three switches as false; `all` or a comma-separated subset of `directives`, `contracts`, `failures` (no repeats) switches exactly those on and the rest off explicitly. The setting is written to `results.json` as top-level `cPublic` (`default`, `none`, `all`, or the subset in name order) and listed in the report parameters |
| `--c-stream <off\|on\|core\|auto>` | `off` | Group C only. `core` and `auto` use the core library's long-project mode (below). `on` is a prototype (spec `2026-11-05-stream-brief-estimate`): `on` keeps the core calls unchanged but sends each bot an append-only stream built by the bench (`src/policies/stream.ts`): a snapshot (the core's common, memory and workspace segments, a board with goal, constraints and every convention, contract, decision, failure, workstream and human message in full, the bot's projection), then per request the project-wide items that are new or changed since (to every bot, once per version; removals as one line), the lines of the bot's memory, notes or projection that are new since the version the stream last showed (under `<section> — updates`; a list item that disappeared as `no longer: <item>`; seen compaction is not a change), the core's delta (minus human messages the stream already carries) and trigger, or for a review or replan the core's review/planning body and trigger. A snapshot that lands on a review or replan takes the lead's memory, notes and projection from one `peek` brief (no side effects). Like C without the stream, it does not carry the bot's own replies or tool calls (see `--c-stream-own`). Once more than `--restream-tokens` were appended after a snapshot, the next request is a new snapshot. Every stream segment counts as flagged cacheable, so R-B19's prefix rule alone decides, and the C upper-bound line is not printed. Written to `results.json` as top-level `cStream` (`{"mode":"off"}` or `{"mode":"on","restreamTokens":n}`) and listed in the report parameters; `on` also adds one caveat |
| `--restream-tokens <n>` | `8000` | With `--c-stream on`, `core` or `auto` only (a usage error otherwise): tokens appended after a snapshot before the next request restreams; a positive integer (passed to the core as `stream.restreamTokens` for `core` and `auto`) |
| `--c-stream-own <off\|on>` | `off` | With `--c-stream on` only (a usage error otherwise), a measurement variant: `on` appends each bot's own scripted reply and tool-call lines to its stream after the request it answers, as one segment in group E's author format (`[bot <id>] <reply>`, tool lines with arguments, full deliverable lines; `src/text.ts`), as D and E histories carry them. They count toward `--restream-tokens`, and a new snapshot does not carry them. Recorded as `"own":true` in `cStream` and as `, own outputs` in the report parameter line; `off` changes nothing |
| `--auto-after <n>` | the core default (`DEFAULT_STREAM_OPTIONS.autoAfterEntries`) | With `--c-stream auto` only (a usage error otherwise): the core's `stream.autoAfterEntries`, the ledger size at which a scenario switches to the stream; a positive integer |
| `--out <dir>` | `results` | Output directory, relative to the current working directory |
| `--stamp <s>` | UTC time `YYYYMMDDTHHmmssZ` | Name of the run's subdirectory |
| `--probes` | off | Fact probes with a real model (below). Takes no value. The flags below need it (a usage error otherwise) |
| `--dry-run` | off | With `--probes`: send nothing; print the estimate and write `probe-estimate.json` and `probe-estimate.md` |
| `--max-cost <usd>` | required for a real run | With `--probes`: budget in US dollars; probing stops before the next probe's estimate would pass it (one probe can overshoot by the difference between its estimate and its real cost) |
| `--provider <anthropic\|openai>` | `anthropic` | With `--probes`: the API. `openai` is any OpenAI-compatible Chat Completions server (below) |
| `--model <id>` | `claude-haiku-5-5` | With `--probes`: the probe model. With `anthropic` it must have a price in `PRICES` (`src/cost.ts`); with `openai` it is required and any name is accepted |
| `--base-url <url>` | none | `--provider openai` only, required: `http` or `https`; requests go to `<url>/chat/completions` (trailing slashes removed). Only its host (and port) is recorded |
| `--api-key-env <NAME>` | `OPENAI_API_KEY` | `--provider openai` only: the environment variable holding the key. If unset, a stderr note is printed and no `Authorization` header is sent |
| `--price <in>,<hit>,<out>` | none | `--provider openai` only, required: USD per million tokens, three non-negative numbers (input cache miss, input cache hit, output); 0 is allowed |
| `--probe-groups <list>` | `A,C,D,E` | With `--probes`: comma list of the groups to probe (those also in `--group`) |
| `--probe-samples <fml\|all\|n>` | `fml` | With `--probes`: which opportunities of a fact are asked: first, middle and last; all; or n evenly spaced |
| `--max-probes <n>` | no cap | With `--probes`: at most n probes per scenario and group (last samples of every fact first) |

Each flag may be given once. `--stamp` must be a plain name (letters, digits, `_`, `.`, `-`, not only
dots). Output is deterministic: two runs with the same inputs and `--stamp` produce byte-identical files.
An invalid scenario, group or flag value prints a message on stderr and exits with a non-zero code (2 for usage errors such as a bad `--c-public`).

### Fact probes with a real model (`--probes`)

A fact with a `probe` (a question, `expect` strings and optional `reject` strings: the old answer)
is asked at sampled opportunities: after a scripted request of a bot in the fact's audience, the
probe model receives that request exactly as the group sent it plus one uncached question segment.
Its answer is graded by strings only: a `reject` hit is **stale**, else an `expect` hit is
**correct**, else **wrong**; a failed request is **error**. Probes never enter the scripted run:
without `--probes` every output is byte-identical, and with it `records` and `metrics` are the same.

```sh
# Estimate first: no requests, no key needed.
pnpm -C packages/bench bench run --scenario long --group all --probes --dry-run
# Real run: the key comes from the environment only.
ANTHROPIC_API_KEY=... pnpm -C packages/bench bench run --scenario long --group all --probes --max-cost 2
```

- **Key.** Read only from `ANTHROPIC_API_KEY`. If the environment's network proxy injects the key
  instead, set `BENCH_PROXY_INJECTS_API_KEY=1`: requests then carry the placeholder `proxy-injected`
  for the proxy to replace. Without either, a real run exits 2 before sending anything. The key is
  never logged or written; error messages are masked (`probeErrorMessage`).
- **Requests** (`src/models/anthropic.ts`, Messages API over Node's `fetch`, `anthropic-version:
  2026-10-21`): one user message with one text block per segment; a `cache_control` breakpoint
  (5-minute) on the last block of each run of cacheable segments (the R-B19 prefix), at most four;
  `max_tokens` 200; thinking disabled. No `temperature` is sent: Claude Haiku 5.5 rejects
  non-default sampling values, so answers use the model default and are not deterministic; each
  question is asked once. 408/409/429/5xx/529 and network errors are retried up to four times with
  backoff (`retry-after`, else 1, 2, 4, 8 s); 401/402/403/404 stop probing for the rest of the run.
- **Cost** (`src/cost.ts`): `PRICES` holds `claude-haiku-5-5` ($0.10 input, $0.125 cache write,
  $0.01 cache read, $0.50 output per million tokens for prompts up to 100K tokens; $0.50 / $0.625 /
  $0.05 / $2.50 above). The dry run counts tokens with the bench's `defaultCountTokens`, an
  approximation of the model's tokenizer, and gives a low (cacheable tokens read) and a high
  (cacheable tokens written) estimate with output at `max_tokens`; the high estimate uses the long rate
  card once the count x 1.5 passes 100K tokens. In a real run the cost guard adds
  the real cost so far to 1.5 times the next probe's high estimate and stops probing (`ProbeStop`)
  before the next probe's estimate would pass `--max-cost`; one probe can overshoot by the difference
  between its estimate and its real cost. Usage reported on a failed request (a refusal) counts too.
  The scripted run then finishes and every result is written.
- **Output.** Each finished probe is appended to `probes.jsonl` as it completes. `results.json`
  gains a `probes` section (settings, prices, real usage and cost, stops, every probe record) and
  `report.md` a "Fact probes" section: answers per group and fact category and per group and tier,
  real usage and cost per group, and the R-B19 comparison (estimated cacheable tokens against real
  cache reads and writes).

#### OpenAI-compatible providers (DeepSeek, local servers)

`--provider openai` sends probes to any server with an OpenAI-style `/chat/completions` endpoint
(`src/models/openai.ts`). It needs `--base-url`, `--model` and `--price`, and `--max-cost` for a real
run (all usage errors, exit 2, before any request). The prompt is one user message, the segments
joined with a newline; `max_tokens` 200, `temperature` 0, `stream` false; no cache markers (these
servers cache prefixes themselves). Usage is read from `prompt_cache_hit_tokens` /
`prompt_cache_miss_tokens` (DeepSeek) or `prompt_tokens_details.cached_tokens`; the output count
includes reasoning tokens, and `reasoning_content` is ignored. Empty answers and `content_filter` are
probe errors (their usage still counts). 401/402/403/404 stop probing; 400/422 fail one probe;
408/409/429/5xx are retried as with Anthropic.

```sh
export DEEPSEEK_API_KEY=...
pnpm -C packages/bench bench run --scenario long --group all --c-stream auto --probes \
  --provider openai --base-url https://api.deepseek.com --model deepseek-chat \
  --api-key-env DEEPSEEK_API_KEY --price <in>,<cache-hit>,<out> --max-cost 1 \
  --out results --stamp probes-long
```

Take the prices from DeepSeek's pricing page, in USD per 1M tokens: input (cache miss), input
(cache hit), output. The bench has no price table for these models: you are responsible for the
prices you give, and the cost guard and the report's costs are only as good as they are. A custom
price has one tier and no cache-write premium; the high estimate prices every cacheable token at the
input rate. Local server (no key needed; a note is printed if the variable is unset):

```sh
pnpm -C packages/bench bench run --scenario long --group all --probes --provider openai \
  --base-url http://localhost:11434/v1 --model <name> --price 0,0,0 --max-cost 1
```

`results.json` and the report record the provider, model, the `--base-url` host (never the full URL
or its query), and the prices; the key appears nowhere.

### Group C on the core stream (`--c-stream core` / `auto`)

`core` creates group C's project with the core's long-project mode on (`stream: { mode: 'on', restreamTokens }`,
see `packages/core/README.md`) and sends every request through `project.buildStream`: a brief, or for
the lead's scripted review and replan steps a `{ kind: 'review', deliverableId }` or `{ kind: 'planning' }`
request. After each scripted request the bench passes the bot's reply and tool-call lines, in group E's
author format (the same text as `--c-stream-own on`), to `project.recordOwnOutput`. `auto` creates the
project with `mode: 'auto'` and `autoAfterEntries` from `--auto-after` (default: the core's default);
before a scenario's ledger reaches it, C is byte for byte the `off` run. Cacheable is R-B19's prefix rule
as always; the core flags every stream segment cacheable, so the upper-bound line is printed only for a
scenario that never used the stream. Each scenario gets a line `Group C stream: used from step N; S
snapshots; ledger L entries.` (or `not used`), from the `stream` field of C's metrics. Recorded as
`{"mode":"core","restreamTokens":n}` or `{"mode":"auto","restreamTokens":n,"autoAfterEntries":m}` in
`cStream`. Other groups, and the `off` and `on` modes, are unchanged.

### Comparing the public-board settings

To compare group C with the core's optional public-board sections switched off and on, run all
six scenarios once per setting (`none` is the plain board, `directives` equals `default`), each into its own output directory:

```sh
for s in none directives contracts failures all; do
  pnpm -C packages/bench bench run --scenario all --group all --c-public $s --out /tmp/pb/$s --stamp T
done
```

Only group C depends on `--c-public`: groups A, B, D, E and F give identical results in every
setting. Compare C's cost units and fact visibility across the five reports (one per setting); for visibility by fact
category, pool `perFact` in `results.json` by the id prefix (`change-`, `conv-`, `contract-`,
`fail-`). The recorded comparison is in
`docs/superpowers/specs/2026-11-04-project-wide-board.md`, section 6.

## Reading the results

- Scenarios are summarised separately by tier: the report has one summary table per tier present in
  the run ("Summary (standard scenarios)", "Summary (long scenarios)", "Summary (xlong scenarios)")
  and never adds tiers together, because the longer scenarios would swamp the shorter ones. Long
  scenarios also get a table of the average request size per 25 steps, showing how each group
  grows; xlong scenarios get the same table per 100 steps.
- In `results.json`, a request record's `segments` merge adjacent entries with the same kind and
  cacheable flag (tokens summed); only group C records segments. Totals, cacheable tokens and every
  metric are unaffected.
- Group A is a single-agent baseline, not a multi-bot alternative. Its one append-only history is
  mostly cacheable, so A can be the cheapest group on cost units even though it has no team at all.
  Compare the multi-bot groups (B to F) with each other, and A only as a reference point.
- The standard and long scenarios stay well below the default 128,000-token window, so group E
  compacts only in the extra-long scenario, where the lead's history passes window x compact ratio
  near step 1,000. The report's caveats say whether E compacted in the run. Pass a smaller
  `--window` (for example `--window 2000`) to see compaction in the shorter scenarios.
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
