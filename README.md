# context-continue

[中文](README.zh-CN.md)

A shared, structured project context for teams of AI bots, plus a benchmark that compares it with the ways multi-bot products share context today.

When several bots work on one project in a group chat, each bot usually rereads the whole conversation on every turn. This repository tests a different idea: the project keeps a small **project board** (goal, conventions, workstreams, contracts, decisions, facts, failures) and each bot gets a **brief** — the part of the board that concerns it plus what changed since it last looked — alongside its own private notes and memory.

> **Status: experimental.** All numbers below come from a scripted fake model. They measure how much context each approach sends, not how well the bots do the work.

## What is here

| Path | What it is |
|---|---|
| [`packages/core`](packages/core/README.md) | `@context-continue/core`: the project board, per-bot briefs, wake rules, review and planning contexts. Never calls a model itself. |
| [`packages/bench`](packages/bench/README.md) | A deterministic benchmark: the same scripted scenarios run through six context strategies. |
| [`docs/superpowers/specs`](docs/superpowers/specs) | Design documents, including every benchmark result and the reasoning behind each change. |
| [`research`](research) | Notes on related products and projects. |

## The benchmark

Six groups play the same scripts. Each request is counted with its input tokens and which part of it a provider could serve from a prompt cache (the longest prefix identical to that bot's previous request; cached tokens cost 0.1).

| Group | Strategy |
|---|---|
| A | One agent does everything with its full history (also stands for single personal agents such as Muse or Duet). A baseline, not a multi-bot alternative. |
| B | Group chat where every bot rereads the whole chat for every message (approximates Grok-style bot groups from public descriptions). |
| **C** | **This project: `@context-continue/core` briefs.** |
| D | Shared append-only log, each bot reads what is new (DeLM-style). |
| E | Turn-taking group chat with recent-message windows and frozen group memory (approximates DS Bot `f823773`). |
| F | Shared document pages plus each bot's own history (approximates Dots + Space from public descriptions). |

Six scenarios: three standard ones (20–40 steps), two long ones (160–164 steps, 6–8 bots, mid-project requirement changes, failed reviews, replans) and one extra-long one (1,154 steps, 8 bots, six release cycles). Each scenario marks key facts (requirement changes, conventions, contracts, failures) and who needs them; **fact visibility** is the share of a bot's working requests whose context actually contains a fact it needs.

### Results (core defaults)

**Long scenarios**

| Group | Cost units | Fact visibility | Median context per request | Largest request |
|---|---:|---:|---:|---:|
| A single agent | 439,297 | 100.0% | 12,144 | 26,947 |
| B every bot reads everything | 2,179,512 | 99.8% | 9,226 | 24,397 |
| **C project board** | **400,723** | **79.9%** | **1,549** | **3,024** |
| D shared log | 378,684 | 98.1% | 5,976 | 15,903 |
| E turn-taking chat | 361,692 | 97.7% | 4,990 | 14,640 |
| F shared pages | 1,157,625 | 98.5% | 4,625 | 16,087 |

**Extra-long scenario** (`xlong-product`, 1,154 steps)

| Group | Cost units | Fact visibility | Median context per request | Largest request |
|---|---:|---:|---:|---:|
| A single agent | 10,451,291 | 100.0% | 87,167 | 189,876 |
| B every bot reads everything | 50,180,795 | 100.0% | 57,765 | 146,956 |
| **C project board** | **3,584,041** | **63.5%** | **4,236** | **6,718** |
| D shared log | 7,452,381 | 100.0% | 46,785 | 124,561 |
| E turn-taking chat | 6,747,043 | 99.2% | 41,356 | 101,617 |
| F shared pages | 10,614,058 | 96.3% | 11,419 | 70,758 |

E compacts once (see the limitations). Only E models the context window: A and B exceed 128,000 tokens in 345 and 155 requests, and D's largest request comes close.

**Standard scenarios**

| Group | Cost units | Fact visibility |
|---|---:|---:|
| A | 24,386 | 100.0% |
| B | 117,579 | 95.7% |
| **C** | **55,852** | **80.0%** |
| D | 40,024 | 95.7% |
| E | 40,820 | 95.7% |
| F | 65,009 | 80.0% |

**C with the public-board switches** (long / standard). The core can put three kinds of project-wide information on the shared board; the default turns on human messages only.

| C setting | Cost long | Visibility long | Cost standard | Visibility standard |
|---|---:|---:|---:|---:|
| nothing on the board | 321,191 | 66.9% | 47,291 | 37.1% |
| human messages (default) | 400,723 | 79.9% | 55,852 | 80.0% |
| human messages + contracts + failures | 505,299 | 96.4% | 61,565 | 92.9% |

## What we learned

1. **Context per request stays small and grows slowly.** On the long scenarios C's median request is about 1.5k tokens and its largest about 3k; the largest requests in the other groups reach 14–27k. On the extra-long scenario C's median is about 4.2k and its largest about 6.7k, while the other groups grow with the history to 71k–190k. This matters for context-window limits, latency and long projects.
2. **Whether C costs less depends on project length.** With prompt caching, an append-only chat history is almost all cache hits, so on the standard and long scenarios D and E are as cheap as C or cheaper. C rebuilds each brief, and every change to the board invalidates the cache from that point on. On the long scenarios C is about 5× cheaper than B and about 3× cheaper than F, but not cheaper than D or E (on the standard scenarios it costs more than both). On the extra-long scenario the other groups' requests keep growing with the history, and C is the cheapest group: about half of D and E, a third of A and F, a fourteenth of B.
3. **Relevance filtering is a real trade-off.** Showing each bot only its part of the project is what keeps briefs small, and it is also why C misses information: requirement changes that reach only some bots, contracts shown once and then folded, failures recorded on other workstreams. On the extra-long scenario C's fact visibility falls to 63.5% (79.9% on the long ones): the board keeps only the newest 20 human messages, so four early requirement changes are missed once newer messages push them off, and contracts and failures are seen even less often than on the long scenarios.
4. **Putting project-wide facts on the shared board recovers visibility at a measured cost.** With everything on, C sees 96% of key facts, close to D and E, for about 57% more cost than with nothing on (long scenarios). The extra cost comes from a larger board being resent every time it changes; reordering for the cache does not remove it.
5. **Some facts need the bots' cooperation.** Agreements that bots make only in chat, without recording them as contracts, never reach the board.

## Limitations

- A scripted fake model: no task quality, no consistency conflicts, no real summarisation.
- B and F approximate closed products from public descriptions; E approximates DS Bot from its source.
- E's compaction is exercised only marginally: on the extra-long scenario E compacts once, only the lead, at step 1,006 with about 150 steps left, and its history passes the threshold by under 1%; nearly half of that history (about 46%) is the lead's own replans. After compacting, the lead's visibility rests on the assumption that E's summary keeps every fact marker (without the markers it falls from 100% to 49% for the remaining steps).
- Only E models the context window. The other groups' figures assume an unlimited window: on the extra-long scenario A and B exceed 128,000 tokens and D reaches about 125k.
- Fact visibility is literal marker matching; a paraphrased fact counts as missed.
- Tool definitions are not counted in any group.

The full list of caveats is printed at the end of every benchmark report.

## Reproduce

Requires Node.js 22.5+ and pnpm.

```sh
pnpm install
pnpm test                                    # core and bench test suites
pnpm -C packages/bench bench run --scenario all --group all --out results --stamp T
pnpm -C packages/bench bench run --scenario all --group C --c-public all --out results --stamp all
```

Two runs with the same settings produce byte-identical `results.json` and `report.md`. See [`packages/bench/README.md`](packages/bench/README.md) for all options.
