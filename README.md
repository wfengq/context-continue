# context-continue

[中文](README.zh-CN.md)

A shared, structured project context for teams of AI bots, plus a benchmark that compares it with the ways multi-bot products share context today.

When several bots work on one project in a group chat, each bot usually rereads the whole conversation on every turn. This repository tests a different idea: the project keeps a small **project board** (goal, conventions, workstreams, contracts, decisions, facts, failures) and each bot gets a **brief** — the part of the board that concerns it plus what changed since it last looked — alongside its own private notes and memory.

> **Status: experimental.** Most numbers below come from a scripted fake model and measure how much context each approach sends. One real-model check (below) asks a real model questions inside each group's context; it measures whether the key facts can be answered from that context, not how well the bots do the work.

## What is here

| Path | What it is |
|---|---|
| [`packages/core`](packages/core/README.md) | `@context-continue/core`: the project board, per-bot briefs, wake rules, review and planning contexts, and an optional long-project stream mode. Never calls a model itself. |
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

**C with the public-board switches** (long / standard). The core can put three kinds of project-wide information on the shared board; the default turns on human messages only. This switch table is not measured on the extra-long scenario.

| C setting | Cost long | Visibility long | Cost standard | Visibility standard |
|---|---:|---:|---:|---:|
| nothing on the board | 321,191 | 66.9% | 47,291 | 37.1% |
| human messages (default) | 400,723 | 79.9% | 55,852 | 80.0% |
| human messages + contracts + failures | 505,299 | 96.4% | 61,565 | 92.9% |

### Long-project mode

The core also has an optional **long-project mode** ([`packages/core`](packages/core/README.md#long-project-mode-stream-mode)): instead of a fresh brief, each bot gets an append-only stream (a snapshot of the whole board, then only what is new), so everything but the appended tail is a prompt-cache hit; after 8,000 appended tokens the next request is a new snapshot. In `auto` mode a project switches to the stream once its ledger holds `autoAfterEntries` entries; the default, **75**, was chosen with this benchmark. The bench passes each bot's own replies and tool calls back into its stream in E's author format, as D's and E's histories carry them.

| Scenarios | C setting | Cost units | vs D / vs E | Fact visibility | Median context | Largest request |
|---|---|---:|---|---:|---:|---:|
| standard | brief (default) | 55,852 | +39.5% / +36.8% | 80.0% | 709 | 1,310 |
| standard | stream from the start | 63,441 | +58.5% / +55.4% | 95.7% | 1,425 | 7,748 |
| standard | **auto (75)**: never switches | **55,852** | **+39.5% / +36.8%** | **80.0%** | **709** | **1,310** |
| long | brief (default) | 400,723 | +5.8% / +10.8% | 79.9% | 1,549 | 3,024 |
| long | stream from the start | 371,766 | −1.8% / +2.8% | 99.9% | 4,356 | 10,911 |
| long | **auto (75)**: from step 60 | **355,195** | **−6.2% / −1.8%** | **96.9%** | **2,498** | **10,598** |
| extra-long | brief (default) | 3,584,041 | −51.9% / −46.9% | 63.5% | 4,236 | 6,718 |
| extra-long | stream from the start | 2,025,560 | −72.8% / −70.0% | 99.8% | 9,806 | 18,721 |
| extra-long | **auto (75)**: from step 123 | **2,055,507** | **−72.4% / −69.5%** | **99.1%** | **9,778** | **18,943** |

D and E for reference: standard 40,024 / 40,820 (95.7% / 95.7%), long 378,684 / 361,692 (98.1% / 97.7%), extra-long 7,452,381 / 6,747,043 (100.0% / 99.2%).

Why 75: the standard scenarios end with 42–44 ledger entries, so they stay on the brief; the long ones reach 75 about a third of the way in. At 50 or 60 the results are about the same, with less headroom above the standard scenarios; at 100 the long scenarios fall to 93.4% visibility and cost more than E; at 400 they never switch. On the long scenarios `auto` is cheaper than streaming from the start, because a brief is smaller than a stream early in a project, but it misses what the brief misses before the switch.

Caveats for this table: the fake model measures context, not whether the bots use it; the stream includes the bots' own outputs (without them it would be cheaper); contracts retired by a replan stay visible in the stream on purpose (on the extra-long scenario core costs about 15% more than the prototype, mainly because of retired contracts), and the scenarios count them as facts bots still need; real cache expiry is not modelled, so a bot that idles longer than the provider keeps its cache pays for a full re-send; the bench writes fewer ledger entries per step than a host that logs every bot reply as chat, which would reach 75 sooner (on these scenarios even logging every scripted bot reply as chat would end at about 65 entries, just under 75; approximate). Details: [spec §5](docs/superpowers/specs/2026-11-06-core-stream-mode.md).

### Real-model check (DeepSeek)

The fake model only shows whether a fact is in the context. To check whether a real model can actually answer from it, every key fact has a question with string-graded answers (an old value after a requirement change counts as **stale**). The scripts run unchanged; at the first, middle and last moment a bot needs a fact, the bench sends that bot's exact context plus the question to a real model. A **no-context** row asks each question with no project context, to show how much can be guessed. One run on DeepSeek (`deepseek-flash`, temperature 0), C in long-project mode `auto`; total cost $0.53.

| Group | Long: correct | Long: stale | Long: prompt tokens | Extra-long: correct | Extra-long: stale | Extra-long: prompt tokens |
|---|---:|---:|---:|---:|---:|---:|
| A single agent | 100.0% | 0.0% | 2,409,696 | 97.8% | 1.5% | 17,421,292 |
| **C project board** | **97.7%** | **0.8%** | **618,074** | **97.0%** | **2.2%** | **1,637,258** |
| D shared log | 97.0% | 1.5% | 1,022,267 | 97.0% | 1.5% | 9,174,292 |
| E turn-taking chat | 98.5% | 0.0% | 928,219 | 95.6% | 2.2% | 7,280,089 |
| no context | 18.2% | — | — | 35.6% | — | — |

132 questions per group on the long scenarios, 135 on the extra-long one. Prompt tokens are the provider's count over all of a group's question requests, so they show how large each group's context is.

- All four groups answer 95–100% correctly, 1–3 questions apart: one run cannot rank them. What it shows is that C's much smaller context does not make the real model answer worse.
- On the extra-long scenario C gets the same score as D with about a fifth of D's tokens (4.4× fewer than E), and its questions cost 40% less than D's and 32% less than E's.
- Without context the model gets 18% / 36% right (mostly conventions that follow industry defaults), so the questions do need the project.
- Requirement changes are the weakest category in every group (85–100%), and every stale answer is a requirement change.

Caveats: one run, one model; grading by strings; the real model only answers the inserted questions and does not drive the script. The question requests are sparse (a few moments per bot), so the provider's real cache hits are below the bench's prompt-cache estimate, most for C (69% real vs 95% estimated on the extra-long scenario), whose stream takes a new snapshot between distant questions; this does not measure the cache of a full scripted run. Details: [spec §5](docs/superpowers/specs/2026-11-07-real-model-probes.md), raw reports in [`docs/superpowers/runs`](docs/superpowers/runs).

## What we learned

1. **Context per request stays small and grows slowly.** On the long scenarios C's median request is about 1.5k tokens and its largest about 3k; the largest requests in the other groups reach 14–27k. On the extra-long scenario C's median is about 4.2k and its largest about 6.7k, while the other groups grow with the history to 71k–190k. This matters for context-window limits, latency and long projects.
2. **Whether C costs less depends on project length.** With prompt caching, an append-only chat history is almost all cache hits, so on the standard and long scenarios D and E are as cheap as C or cheaper. C rebuilds each brief, and every change to the board invalidates the cache from that point on. On the long scenarios C is about 5× cheaper than B and about 3× cheaper than F, but not cheaper than D or E (on the standard scenarios it costs more than both). On this extra-long scenario the other groups' requests keep growing with the history, and C is the cheapest group, with 63.5% fact visibility (point 3): about half of D and E, a third of F, a fourteenth of B, and a third of A (A and B only under an unlimited window; see Limitations). E compacted only once here, so its capped regime (request size bounded near the threshold, linear cost growth) is untested.
3. **Relevance filtering is a real trade-off.** Showing each bot only its part of the project is what keeps briefs small, and it is also why C misses information: requirement changes that reach only some bots, contracts shown once and then folded, failures recorded on other workstreams. On the extra-long scenario C's fact visibility falls to 63.5% (79.9% on the long ones): the board keeps only the newest 20 human messages, so four early requirement changes are missed once newer messages push them off, and contracts and failures are seen even less often than on the long scenarios.
4. **Putting project-wide facts on the shared board recovers visibility at a measured cost.** With everything on, C sees 96% of key facts, close to D and E, for about 57% more cost than with nothing on (long scenarios). The extra cost comes from a larger board being resent every time it changes; reordering for the cache does not remove it.
5. **Some facts need the bots' cooperation.** Agreements that bots make only in chat, without recording them as contracts, never reach the board.
6. **For long projects, an append-only stream beats rebuilding the brief.** In long-project mode (`auto`, switching at 75 ledger entries) C is cheaper than D and E on the long and extra-long scenarios (by 2–6% and about 70%) with 96.9% and 99.1% fact visibility (on the long scenarios auto's 96.9% is slightly below D and E, at 98.1% / 97.7%), and leaves the standard scenarios on the plain brief, where a stream would cost even more. Its requests are larger than the brief's (up to about 19k tokens on the extra-long scenario), still about a fifth of D's and E's.
7. **A real model answers as well from C's context as from full histories.** On DeepSeek, C answers 97–98% of the key-fact questions correctly, within 1–3 questions of A, D and E, while sending a fifth of D's tokens on the extra-long scenario. The real-model check does not show C answering better, and it does not test real cache behaviour over a full run.

## Limitations

- A scripted fake model: no task quality, no consistency conflicts, no real summarisation. The real-model check covers only answering questions about key facts, in one run on one model.
- B and F approximate closed products from public descriptions; E approximates DS Bot from its source.
- E's compaction is exercised only marginally: on the extra-long scenario E compacts once, only the lead, at step 1,006 with about 150 steps left, and its history passes the threshold by under 1%; nearly half of that history (about 46%) is the lead's own replans (measured with a diagnostic copy of the bench outside the repo; see spec §6.3). After compacting, the lead's visibility rests on the assumption that E's summary keeps every fact marker (without the markers it falls from 100% to 49% for the remaining steps; measured with a diagnostic copy of the bench outside the repo; see spec §6.3).
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
pnpm -C packages/bench bench run --scenario all --group all --c-stream auto --out results --stamp auto   # long-project mode
```

Two runs with the same settings produce byte-identical `results.json` and `report.md`. See [`packages/bench/README.md`](packages/bench/README.md) for all options.
