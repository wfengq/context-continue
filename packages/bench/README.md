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
| F | Dots + Space style: shared pages plus each bot's own history |

## Scenarios

`scenarios/` holds three scripted projects of 20 to 40 steps each: `product-plan`, `flappy-bird`
and `event-plan`. Every scenario covers a mid-project change of requirements, a failed review, a
review that adds a convention, a replan and a question from one bot to another. Flappy Bird also
contains an art-versus-game-logic style conflict found in review. Tool calls use the core
library's tool names and argument shapes, because group C executes them for real.

## Running

From the repository root:

```sh
pnpm install
pnpm -C packages/bench bench run --scenario all --group all
```

The `bench` script builds the core library and the bench, then runs `node dist/cli.js`. With
`pnpm -C packages/bench`, the working directory is `packages/bench`, so the default output lands in
`packages/bench/results/`. Results are written to `<out>/<stamp>/results.json` (every request record and the metrics) and
`<out>/<stamp>/report.md` (one table per scenario and a summary table). The `results/` directory is
ignored by git.

### Flags

| Flag | Default | Meaning |
|---|---|---|
| `--scenario <id\|path.json\|all>` | required | A scenario id from `scenarios/`, a path to a scenario JSON file, or `all` |
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

- Group A is a single-agent baseline, not a multi-bot alternative. Its one append-only history is
  mostly cacheable, so A can be the cheapest group on cost units even though it has no team at all.
  Compare the multi-bot groups (B to F) with each other, and A only as a reference point.
- The bundled scenarios are short, so group E's compaction does not trigger at the default
  128,000-token window. Pass a smaller `--window` (for example `--window 2000`) to see it.
- Wake counts (extra requests) for groups D, E and F depend on how often humans and bots
  @-mention each other in the scenario. A scenario with more or fewer mentions shifts these groups.
- Cost units weight cacheable tokens by `--cache-ratio`; raw input tokens and the context-size
  columns show the size of what each request carries, independent of caching.

## Development

```sh
pnpm -C packages/bench test
pnpm -C packages/bench typecheck
```
