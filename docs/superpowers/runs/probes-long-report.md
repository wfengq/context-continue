> Results come from a scripted fake model: they measure context size only, not task quality.

# Context bench report

Parameters:

- cacheRatio: 0.1
- compactRatio: 0.8
- summaryTokens: 1500
- window: 128000
- cPublic: default
- cStream: auto (restreamTokens 8000, autoAfterEntries 75)

Cost units = cacheable tokens x cache ratio + uncached tokens. Saved % = (reference cost - group cost) / reference cost x 100; n/a when the reference cost is 0.

## Scenario: long-app

| Group | Input tokens | Cacheable | Uncached | Cost units | Scripted req | Extra req | Ctx median | Ctx P90 | Ctx max | Compactions | Pauses | Core errors | Facts visible % | Saved vs B % | Saved vs E % |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| A | 1,955,902 | 1,929,010 | 26,892 | 219,793.0 | 154 | 0 | 10,756 | 25,199 | 26,947 | 0 | 0 | 0 | 100.0 | 82.6 | -28.0 |
| B | 11,189,879 | 11,028,789 | 161,090 | 1,263,968.9 | 154 | 1,018 | 8,882 | 18,371 | 24,397 | 0 | 0 | 0 | 99.4 | 0.0 | -636.2 |
| C | 619,059 | 487,408 | 131,651 | 180,391.8 | 154 | 51 | 2,458 | 5,851 | 10,598 | 0 | 0 | 0 | 96.9 | 85.7 | -5.1 |
| D | 1,144,520 | 1,057,102 | 87,418 | 193,128.2 | 154 | 46 | 5,281 | 10,299 | 15,188 | 0 | 0 | 0 | 95.4 | 84.7 | -12.5 |
| E | 1,034,194 | 958,341 | 75,853 | 171,687.1 | 154 | 56 | 4,421 | 10,307 | 13,981 | 0 | 0 | 0 | 94.4 | 86.4 | 0.0 |
| F | 812,210 | 239,504 | 572,706 | 596,656.4 | 154 | 2 | 4,333 | 9,772 | 16,087 | 0 | 0 | 0 | 97.9 | 52.8 | -247.5 |

Group C core errors: 0.
Group C stream: used from step 60; 11 snapshots; ledger 202 entries.

Average request input tokens per 25-step bucket:

| Group | From step 0 | From step 25 | From step 50 | From step 75 | From step 100 | From step 125 | From step 150 |
|---|---|---|---|---|---|---|---|
| A | 1,635 | 4,786 | 9,175 | 12,806 | 17,481 | 23,036 | 26,277 |
| B | 1,246 | 3,693 | 6,906 | 9,552 | 12,913 | 16,992 | 19,618 |
| C | 960 | 1,252 | 1,934 | 3,592 | 4,204 | 5,012 | 6,745 |
| D | 753 | 2,171 | 3,949 | 5,560 | 7,302 | 10,306 | 11,332 |
| E | 799 | 1,913 | 3,704 | 4,907 | 6,165 | 8,635 | 9,967 |
| F | 1,334 | 2,695 | 4,080 | 5,410 | 6,873 | 8,561 | 9,531 |

Fact visibility % per fact:

| Fact | A | B | C | D | E | F |
|---|---|---|---|---|---|---|
| conv-given-when-then | 100.0 | 100.0 | 100.0 | 100.0 | 100.0 | 100.0 |
| conv-cursor-pagination | 100.0 | 100.0 | 100.0 | 100.0 | 100.0 | 100.0 |
| conv-iso8601-utc | 100.0 | 100.0 | 100.0 | 100.0 | 100.0 | 100.0 |
| conv-wcag-aa-contrast | 100.0 | 100.0 | 100.0 | 100.0 | 100.0 | 100.0 |
| conv-no-pii-in-events | 100.0 | 100.0 | 100.0 | 100.0 | 94.9 | 100.0 |
| contract-error-envelope | 100.0 | 100.0 | 23.1 | 100.0 | 100.0 | 50.0 |
| conv-rate-limits-documented | 100.0 | 100.0 | 100.0 | 100.0 | 100.0 | 100.0 |
| conv-idempotency-key | 100.0 | 100.0 | 100.0 | 100.0 | 100.0 | 100.0 |
| change-household-6 | 100.0 | 100.0 | 100.0 | 100.0 | 100.0 | 100.0 |
| contract-invite-link-72h | 100.0 | 100.0 | 100.0 | 100.0 | 100.0 | 100.0 |
| fail-websocket-fanout | 100.0 | 91.9 | 97.3 | 37.8 | 37.8 | 100.0 |
| fail-stripe-in-webview | 100.0 | 100.0 | 100.0 | 100.0 | 100.0 | 100.0 |
| change-store-billing | 100.0 | 100.0 | 100.0 | 100.0 | 100.0 | 100.0 |
| contract-receipt-post | 100.0 | 100.0 | 100.0 | 100.0 | 88.2 | 100.0 |
| conv-restore-path | 100.0 | 100.0 | 100.0 | 100.0 | 100.0 | 100.0 |
| change-offline-list | 100.0 | 100.0 | 100.0 | 100.0 | 100.0 | 100.0 |
| contract-sync-cursor | 100.0 | 100.0 | 100.0 | 100.0 | 100.0 | 100.0 |
| fail-full-list-resync | 100.0 | 92.3 | 100.0 | 38.5 | 38.5 | 100.0 |
| conv-delete-wins | 100.0 | 100.0 | 100.0 | 100.0 | 100.0 | 100.0 |
| conv-story-and-build-in-reports | 100.0 | 100.0 | 100.0 | 100.0 | 85.7 | 100.0 |
| change-eu-first | 100.0 | 100.0 | 100.0 | 100.0 | 100.0 | 96.6 |
| contract-export-zip-30d | 100.0 | 100.0 | 100.0 | 100.0 | 80.0 | 100.0 |

## Scenario: long-event

| Group | Input tokens | Cacheable | Uncached | Cost units | Scripted req | Extra req | Ctx median | Ctx P90 | Ctx max | Compactions | Pauses | Core errors | Facts visible % | Saved vs B % | Saved vs E % |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| A | 1,955,741 | 1,929,152 | 26,589 | 219,504.2 | 151 | 0 | 12,763 | 24,125 | 26,644 | 0 | 0 | 0 | 100.0 | 76.0 | -15.5 |
| B | 8,052,605 | 7,930,069 | 122,536 | 915,542.9 | 151 | 666 | 9,657 | 17,925 | 24,015 | 0 | 0 | 0 | 100.0 | 0.0 | -381.9 |
| C | 640,967 | 517,960 | 123,007 | 174,803.0 | 151 | 37 | 2,626 | 7,125 | 10,300 | 0 | 0 | 0 | 96.8 | 80.9 | 8.0 |
| D | 1,190,778 | 1,116,914 | 73,864 | 185,555.4 | 151 | 25 | 6,763 | 11,656 | 15,903 | 0 | 0 | 0 | 100.0 | 79.7 | 2.3 |
| E | 1,236,695 | 1,162,989 | 73,706 | 190,004.9 | 151 | 36 | 6,630 | 11,689 | 14,640 | 0 | 0 | 0 | 100.0 | 79.2 | 0.0 |
| F | 787,863 | 252,105 | 535,758 | 560,968.5 | 151 | 4 | 4,699 | 8,847 | 14,958 | 0 | 0 | 0 | 98.9 | 38.7 | -195.2 |

Group C core errors: 0.
Group C stream: used from step 61; 9 snapshots; ledger 193 entries.

Average request input tokens per 25-step bucket:

| Group | From step 0 | From step 25 | From step 50 | From step 75 | From step 100 | From step 125 | From step 150 |
|---|---|---|---|---|---|---|---|
| A | 1,686 | 6,205 | 9,278 | 13,848 | 18,565 | 23,182 | 25,857 |
| B | 1,358 | 4,687 | 7,165 | 10,539 | 13,980 | 17,230 | 19,687 |
| C | 991 | 1,278 | 1,896 | 4,285 | 5,427 | 6,439 | 7,038 |
| D | 856 | 3,087 | 4,489 | 6,931 | 9,090 | 11,732 | 12,679 |
| E | 929 | 3,083 | 4,439 | 6,906 | 8,830 | 11,607 | 12,394 |
| F | 1,193 | 2,833 | 3,987 | 5,802 | 6,517 | 8,562 | 9,814 |

Fact visibility % per fact:

| Fact | A | B | C | D | E | F |
|---|---|---|---|---|---|---|
| conv-prices-incl-vat | 100.0 | 100.0 | 100.0 | 100.0 | 100.0 | 100.0 |
| conv-step-free-access | 100.0 | 100.0 | 100.0 | 100.0 | 100.0 | 100.0 |
| change-capacity-1000 | 100.0 | 100.0 | 100.0 | 100.0 | 100.0 | 99.2 |
| contract-room-capacities | 100.0 | 100.0 | 83.6 | 100.0 | 100.0 | 100.0 |
| fail-open-ticket-link | 100.0 | 100.0 | 78.0 | 100.0 | 100.0 | 100.0 |
| contract-badge-csv | 100.0 | 100.0 | 73.7 | 100.0 | 100.0 | 81.6 |
| conv-signed-confirmation | 100.0 | 100.0 | 100.0 | 100.0 | 100.0 | 100.0 |
| conv-no-paid-talks | 100.0 | 100.0 | 100.0 | 100.0 | 100.0 | 100.0 |
| conv-sponsor-opt-in-only | 100.0 | 100.0 | 100.0 | 100.0 | 100.0 | 100.0 |
| conv-times-24h | 100.0 | 100.0 | 100.0 | 100.0 | 100.0 | 100.0 |
| fail-venue-wifi-stream | 100.0 | 100.0 | 100.0 | 100.0 | 100.0 | 100.0 |
| conv-human-captions | 100.0 | 100.0 | 100.0 | 100.0 | 100.0 | 100.0 |
| fail-auto-captions | 100.0 | 100.0 | 100.0 | 100.0 | 100.0 | 100.0 |
| change-workshop-day | 100.0 | 100.0 | 100.0 | 100.0 | 100.0 | 98.8 |
| contract-workshop-seats-40 | 100.0 | 100.0 | 100.0 | 100.0 | 100.0 | 100.0 |
| conv-setup-guide-7d | 100.0 | 100.0 | 100.0 | 100.0 | 100.0 | 100.0 |
| conv-run-sheet-owner | 100.0 | 100.0 | 100.0 | 100.0 | 100.0 | 100.0 |
| change-no-livestream | 100.0 | 100.0 | 100.0 | 100.0 | 100.0 | 100.0 |
| contract-video-7d | 100.0 | 100.0 | 100.0 | 100.0 | 100.0 | 100.0 |
| conv-recording-release | 100.0 | 100.0 | 100.0 | 100.0 | 100.0 | 100.0 |
| change-green-event | 100.0 | 100.0 | 100.0 | 100.0 | 100.0 | 96.9 |
| contract-travel-log | 100.0 | 100.0 | 100.0 | 100.0 | 100.0 | 100.0 |

## Summary (long scenarios)

| Group | Input tokens | Cacheable | Uncached | Cost units | Scripted req | Extra req | Ctx median | Ctx P90 | Ctx max | Compactions | Pauses | Core errors | Facts visible % | Saved vs B % | Saved vs E % |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| A | 3,911,643 | 3,858,162 | 53,481 | 439,297.2 | 305 | 0 | 12,144 | 24,635 | 26,947 | 0 | 0 | 0 | 100.0 | 79.8 | -21.5 |
| B | 19,242,484 | 18,958,858 | 283,626 | 2,179,511.8 | 305 | 1,684 | 9,226 | 18,275 | 24,397 | 0 | 0 | 0 | 99.8 | 0.0 | -502.6 |
| C | 1,260,026 | 1,005,368 | 254,658 | 355,194.8 | 305 | 88 | 2,498 | 6,625 | 10,598 | 0 | 0 | 0 | 96.9 | 83.7 | 1.8 |
| D | 2,335,298 | 2,174,016 | 161,282 | 378,683.6 | 305 | 71 | 5,976 | 11,320 | 15,903 | 0 | 0 | 0 | 98.1 | 82.6 | -4.7 |
| E | 2,270,889 | 2,121,330 | 149,559 | 361,692.0 | 305 | 92 | 4,990 | 11,036 | 14,640 | 0 | 0 | 0 | 97.7 | 83.4 | 0.0 |
| F | 1,600,073 | 491,609 | 1,108,464 | 1,157,624.9 | 305 | 6 | 4,625 | 9,532 | 16,087 | 0 | 0 | 0 | 98.5 | 46.9 | -220.1 |

## Fact probes (real model)

Provider openai-compatible (host api.deepseek.com); Model deepseek-flash; max_tokens 200; thinking disabled; temperature 0; each question asked once (samples fml); groups A, C, D, E. A probe sends the scripted request exactly as the group sent it, plus one uncached question segment; answers are graded by strings only (stale: an old answer appears; wrong: neither expected nor old; error: the request failed or the probe never fired).

Group "none" is the no-context control: each probed fact asked once with the question alone and no project context. Its correct share is what the model gets right from general knowledge, so read the other groups against it.

Answers per group and fact category (%):

| Group | Category | Probes | Correct | Stale | Wrong | Error |
|---|---|---|---|---|---|---|
| A | change | 24 | 100.0 | 0.0 | 0.0 | 0.0 |
| A | contract | 30 | 100.0 | 0.0 | 0.0 | 0.0 |
| A | conv | 60 | 100.0 | 0.0 | 0.0 | 0.0 |
| A | fail | 18 | 100.0 | 0.0 | 0.0 | 0.0 |
| A | all | 132 | 100.0 | 0.0 | 0.0 | 0.0 |
| C | change | 24 | 95.8 | 4.2 | 0.0 | 0.0 |
| C | contract | 30 | 96.7 | 0.0 | 3.3 | 0.0 |
| C | conv | 60 | 100.0 | 0.0 | 0.0 | 0.0 |
| C | fail | 18 | 94.4 | 0.0 | 5.6 | 0.0 |
| C | all | 132 | 97.7 | 0.8 | 1.5 | 0.0 |
| D | change | 24 | 91.7 | 8.3 | 0.0 | 0.0 |
| D | contract | 30 | 100.0 | 0.0 | 0.0 | 0.0 |
| D | conv | 60 | 100.0 | 0.0 | 0.0 | 0.0 |
| D | fail | 18 | 88.9 | 0.0 | 11.1 | 0.0 |
| D | all | 132 | 97.0 | 1.5 | 1.5 | 0.0 |
| E | change | 24 | 100.0 | 0.0 | 0.0 | 0.0 |
| E | contract | 30 | 96.7 | 0.0 | 3.3 | 0.0 |
| E | conv | 60 | 100.0 | 0.0 | 0.0 | 0.0 |
| E | fail | 18 | 94.4 | 0.0 | 5.6 | 0.0 |
| E | all | 132 | 98.5 | 0.0 | 1.5 | 0.0 |
| none | change | 8 | 0.0 | 0.0 | 100.0 | 0.0 |
| none | contract | 10 | 10.0 | 0.0 | 90.0 | 0.0 |
| none | conv | 20 | 30.0 | 0.0 | 70.0 | 0.0 |
| none | fail | 6 | 16.7 | 0.0 | 83.3 | 0.0 |
| none | all | 44 | 18.2 | 0.0 | 81.8 | 0.0 |

Answers per group and tier (%):

| Group | Tier | Probes | Correct | Stale | Wrong | Error |
|---|---|---|---|---|---|---|
| A | long | 132 | 100.0 | 0.0 | 0.0 | 0.0 |
| C | long | 132 | 97.7 | 0.8 | 1.5 | 0.0 |
| D | long | 132 | 97.0 | 1.5 | 1.5 | 0.0 |
| E | long | 132 | 98.5 | 0.0 | 1.5 | 0.0 |
| none | long | 44 | 18.2 | 0.0 | 81.8 | 0.0 |

Real usage and cost (tokens as the provider counted them; prices: user-supplied via --price: $0.15 input (cache miss), $0.003 input (cache hit), $0.6 output per MTok; the user is responsible for these prices):

| Group | Requests | Input (uncached) | Cache write | Cache read | Output | Cost |
|---|---|---|---|---|---|---|
| A | 132 | 72,288 | 0 | 2,337,408 | 3,754 | $0.0201 |
| C | 132 | 138,586 | 0 | 479,488 | 4,414 | $0.0249 |
| D | 132 | 155,963 | 0 | 866,304 | 3,321 | $0.0280 |
| E | 132 | 147,419 | 0 | 780,800 | 3,289 | $0.0264 |
| none | 44 | 991 | 0 | 0 | 1,016 | $0.0008 |
| Total | 572 | 515,247 | 0 | 4,464,000 | 15,794 | $0.1002 |

Total real cost $0.1002 of --max-cost $1.0000.

R-B19 comparison for probe requests (requests with reported usage only). Estimated: the bench's token count (an approximation of the model's tokenizer) and its R-B19 cacheable tokens; real: prompt tokens = uncached + cache write + cache read, as reported. Real cache reads also depend on what earlier probes wrote within the cache lifetime and on the minimum cacheable length.

| Group | Est. input | Est. cacheable | Est. cacheable % | Real prompt | Real cache read | Real cache read % | Real cache write |
|---|---|---|---|---|---|---|---|
| A | 2,410,119 | 2,381,375 | 98.8 | 2,409,696 | 2,337,408 | 97.0 | 0 |
| C | 603,274 | 544,034 | 90.2 | 618,074 | 479,488 | 77.6 | 0 |
| D | 1,040,405 | 968,039 | 93.0 | 1,022,267 | 866,304 | 84.7 | 0 |
| E | 957,757 | 887,592 | 92.7 | 928,219 | 780,800 | 84.1 | 0 |
| none | 1,015 | 0 | 0.0 | 991 | 0 | 0.0 | 0 |

## Caveats

- Results come from a scripted fake model; only context size is measured.
- Quality and consistency conflicts: needs a real model, not measured.
- E approximates DS Bot f823773.
- B and F approximate Grok Bot and Dots + Space from public descriptions.
- A also stands for Muse/Duet.
- C uses the core's own common segment instead of the shared template.
- Tool definitions are not counted in any group.
- C pays one extra lead brief at step 0 when a scenario opens with a human message.
- A is a single-agent baseline, not a multi-bot alternative: its one append-only history is mostly cacheable, so A can be the cheapest group on cost units.
- E did not compact in this run: every scenario stayed below its compaction threshold (window x compact ratio); pass a smaller --window to see it.
- Wake counts (extra requests) for D, E and F depend on how often humans and bots @-mention each other in the scenario.
- Cacheable, in every group: the longest leading run of a request's segments identical to that bot's previous request (on a bot's first request, the fixed template only); in C a segment must also be flagged cacheable by the core, which flags every stream segment, so where C used the stream this prefix rule alone decides; the C upper-bound line is printed only for scenarios that never used it.
- F's context is the shared pages (project, current plan, one per delivered workstream) plus the bot's own history: there is no chat thread.
- In D and E reviewers get a reference to the deliverable, not its text (in E only the author's chat message); a real reviewer would fetch the content with an extra tool call, which is not counted.
- C's lead reviews with the core's review context (the deliverable's text and the reviewed workstream's contracts, conventions, decisions, facts and failures) and replans with its planning context (every human message so far and the previous plan); the host passes the core a trigger with the task line, merged wakes and pending tool results.
- C, E and F always carry the goal and constraints; A, B and D see them only through human messages.
- C's host adds the routed message and any wake merged into a bot's own next step to that bot's trigger; the core's wake detail only says why the bot was woken.
- Fact visibility is literal text matching of a marker: a group that paraphrases a fact counts as missing it.
- Group E's compaction summary is assumed to keep every marker seen before compacting (favourable to E).
- In groups A, B, D, E and F the lead's own history carries a replan and new conventions twice: in its announcement and in its tool call (in A, the single agent's history).
- In groups D and E reviewers get deliverable references, so facts written inside a deliverable reach them less often.
- C misses a fact in three ways, all core behaviour reported as results: (a) relevance projection: a bot's brief shows board items (failures, contracts) of its own part of the plan only, while many facts concern everyone; (b) seen-compression: once a bot has acted on a brief that showed a board item, later briefs show it compactly without its text (a contract without its spec, other items cut short), so they can lack its marker; (c) chat shown once: a chat message reaches a bot once (in its delta, its trigger or the planning context) and afterwards only where a board item restates it, so the lead, which owns no workstream, loses a change after that, and a fact written only as bot chat never reaches the board. An extraction model (not used here) would only turn human chat into board items.
- Tool-call arguments are rendered in the author's own history only (R-L4); other bots see a call's effect (a page, a board item, a deliverable) but not its arguments. A sendMessage text is a posted message, posted once: not again when the same step's reply already contains it.
- C uses the core's long-project stream mode (--c-stream core, or auto from the request at which a scenario's ledger holds autoAfterEntries entries; before that C is exactly as without it): every request is the core's buildStream (a brief, or a review or planning request for the lead's review and replan steps), and after each scripted request the bench passes the bot's reply and tool-call lines, in E's author format (tool arguments and full deliverables), to recordOwnOutput, as D and E histories carry them. A snapshot carries the whole board, contracts retired by a replan, and every human message (older ones beyond snapshotHumanKeep folded to 160 characters); later requests append project-wide changes, item-level updates of the bot's memory, notes and part, its own output, and the trigger or review/planning body; once more than restreamTokens were appended since the snapshot, the next request is a new snapshot. The per-scenario stream line gives the step of the first streamed request and the snapshot count (each bot's first included). The C miss causes (a)-(c) above apply only to what the stream does not restate.
