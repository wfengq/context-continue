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

## Scenario: xlong-product

| Group | Input tokens | Cacheable | Uncached | Cost units | Scripted req | Extra req | Ctx median | Ctx P90 | Ctx max | Compactions | Pauses | Core errors | Facts visible % | Saved vs B % | Saved vs E % |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| A | 102,804,518 | 102,614,697 | 189,821 | 10,451,290.7 | 1,117 | 0 | 87,167 | 176,143 | 189,876 | 0 | 0 | 0 | 100.0 | 79.2 | -54.9 |
| B | 492,853,807 | 491,858,902 | 994,905 | 50,180,795.2 | 1,117 | 7,044 | 57,765 | 113,808 | 146,956 | 0 | 0 | 0 | 100.0 | 0.0 | -643.7 |
| C | 11,585,538 | 10,588,923 | 996,615 | 2,055,507.3 | 1,117 | 134 | 9,778 | 14,902 | 18,943 | 0 | 0 | 0 | 99.1 | 95.9 | 69.5 |
| D | 67,182,104 | 66,366,359 | 815,745 | 7,452,380.9 | 1,117 | 247 | 46,785 | 93,376 | 124,561 | 0 | 0 | 0 | 100.0 | 85.1 | -10.5 |
| E | 60,748,354 | 60,001,457 | 746,897 | 6,747,042.7 | 1,117 | 269 | 41,356 | 83,243 | 101,617 | 1 | 0 | 0 | 99.2 | 86.6 | 0.0 |
| F | 15,458,430 | 5,382,636 | 10,075,794 | 10,614,057.6 | 1,117 | 1 | 11,419 | 23,445 | 70,758 | 0 | 0 | 0 | 96.3 | 78.8 | -57.3 |

Group C core errors: 0.
Group C stream: used from step 123; 65 snapshots; ledger 685 entries.

Average request input tokens per 100-step bucket:

| Group | From step 0 | From step 100 | From step 200 | From step 300 | From step 400 | From step 500 | From step 600 | From step 700 | From step 800 | From step 900 | From step 1000 | From step 1100 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| A | 6,407 | 20,572 | 35,902 | 52,001 | 67,668 | 83,648 | 103,078 | 119,512 | 139,171 | 156,765 | 176,305 | 186,910 |
| B | 4,320 | 13,768 | 23,798 | 34,436 | 44,615 | 55,157 | 67,594 | 78,458 | 91,064 | 102,637 | 115,157 | 122,361 |
| C | 1,160 | 2,871 | 6,655 | 7,594 | 9,088 | 10,281 | 10,292 | 12,195 | 12,063 | 13,468 | 14,440 | 14,565 |
| D | 3,215 | 10,257 | 18,910 | 26,814 | 35,405 | 44,061 | 54,851 | 63,850 | 74,486 | 83,785 | 93,938 | 100,417 |
| E | 2,946 | 9,422 | 17,419 | 24,748 | 32,519 | 40,542 | 50,203 | 58,408 | 68,807 | 77,923 | 77,111 | 79,701 |
| F | 2,176 | 5,016 | 6,132 | 8,909 | 10,754 | 12,624 | 15,025 | 17,301 | 20,233 | 22,942 | 24,118 | 26,774 |

Fact visibility % per fact:

| Fact | A | B | C | D | E | F |
|---|---|---|---|---|---|---|
| conv-iso8601-utc | 100.0 | 100.0 | 100.0 | 100.0 | 100.0 | 100.0 |
| contract-error-envelope | 100.0 | 100.0 | 84.0 | 100.0 | 100.0 | 72.5 |
| conv-wcag-22-aa | 100.0 | 100.0 | 100.0 | 100.0 | 75.1 | 100.0 |
| change-saml-sso | 100.0 | 100.0 | 100.0 | 100.0 | 100.0 | 100.0 |
| contract-session-tokens | 100.0 | 100.0 | 94.0 | 100.0 | 100.0 | 79.5 |
| fail-sms-otp | 100.0 | 100.0 | 95.3 | 100.0 | 100.0 | 100.0 |
| conv-server-role-check | 100.0 | 100.0 | 100.0 | 100.0 | 100.0 | 100.0 |
| conv-idempotency-key | 100.0 | 100.0 | 100.0 | 100.0 | 100.0 | 100.0 |
| change-admin-2fa | 100.0 | 100.0 | 100.0 | 100.0 | 100.0 | 100.0 |
| conv-story-and-build | 100.0 | 100.0 | 100.0 | 100.0 | 100.0 | 100.0 |
| contract-entitlements | 100.0 | 100.0 | 100.0 | 100.0 | 100.0 | 93.9 |
| conv-money-minor-units | 100.0 | 100.0 | 100.0 | 100.0 | 100.0 | 100.0 |
| fail-nightly-proration | 100.0 | 100.0 | 100.0 | 100.0 | 100.0 | 100.0 |
| change-per-seat-pricing | 100.0 | 100.0 | 100.0 | 100.0 | 100.0 | 100.0 |
| contract-dunning-states | 100.0 | 100.0 | 98.8 | 100.0 | 99.2 | 90.7 |
| conv-webhooks-verified | 100.0 | 100.0 | 100.0 | 100.0 | 100.0 | 100.0 |
| change-vat-reverse-charge | 100.0 | 100.0 | 100.0 | 100.0 | 100.0 | 100.0 |
| fail-cached-seat-count | 100.0 | 100.0 | 100.0 | 100.0 | 100.0 | 100.0 |
| fail-ot-server | 100.0 | 100.0 | 100.0 | 100.0 | 100.0 | 100.0 |
| contract-doc-roles | 100.0 | 100.0 | 100.0 | 100.0 | 100.0 | 44.6 |
| change-suggestion-mode | 100.0 | 100.0 | 100.0 | 100.0 | 100.0 | 100.0 |
| contract-yjs-sync | 100.0 | 100.0 | 100.0 | 100.0 | 100.0 | 100.0 |
| conv-mention-digest | 100.0 | 100.0 | 100.0 | 100.0 | 100.0 | 100.0 |
| conv-presence-ttl | 100.0 | 100.0 | 100.0 | 100.0 | 100.0 | 100.0 |
| fail-sticky-sessions | 100.0 | 100.0 | 100.0 | 100.0 | 100.0 | 100.0 |
| change-offline-editing | 100.0 | 100.0 | 100.0 | 100.0 | 100.0 | 100.0 |
| contract-state-vector-resync | 100.0 | 100.0 | 100.0 | 100.0 | 100.0 | 69.7 |
| conv-offline-pin-limit | 100.0 | 100.0 | 100.0 | 100.0 | 100.0 | 100.0 |
| fail-localstorage-quota | 100.0 | 100.0 | 100.0 | 100.0 | 100.0 | 100.0 |
| conv-sync-state-visible | 100.0 | 100.0 | 100.0 | 100.0 | 100.0 | 100.0 |
| change-pwa-not-desktop | 100.0 | 100.0 | 100.0 | 100.0 | 100.0 | 100.0 |
| fail-ios-background-fetch | 100.0 | 100.0 | 100.0 | 100.0 | 100.0 | 100.0 |
| contract-export-jobs | 100.0 | 100.0 | 100.0 | 100.0 | 100.0 | 94.8 |
| fail-pdf-in-api | 100.0 | 100.0 | 100.0 | 100.0 | 100.0 | 100.0 |
| change-docx-export | 100.0 | 100.0 | 100.0 | 100.0 | 100.0 | 100.0 |
| conv-golden-files | 100.0 | 100.0 | 100.0 | 100.0 | 100.0 | 100.0 |
| fail-pandoc-docx | 100.0 | 100.0 | 100.0 | 100.0 | 100.0 | 100.0 |
| change-workspace-export | 100.0 | 100.0 | 100.0 | 100.0 | 100.0 | 100.0 |
| conv-export-filenames | 100.0 | 100.0 | 100.0 | 100.0 | 100.0 | 100.0 |
| contract-audit-events | 100.0 | 100.0 | 100.0 | 100.0 | 100.0 | 100.0 |
| change-soc2-type2 | 100.0 | 100.0 | 100.0 | 100.0 | 100.0 | 100.0 |
| conv-access-review | 100.0 | 100.0 | 100.0 | 100.0 | 100.0 | 100.0 |
| change-eu-residency | 100.0 | 100.0 | 100.0 | 100.0 | 100.0 | 100.0 |
| fail-us-read-replica | 100.0 | 100.0 | 100.0 | 100.0 | 100.0 | 100.0 |
| conv-change-ticket | 100.0 | 100.0 | 100.0 | 100.0 | 100.0 | 100.0 |

## Summary (xlong scenarios)

| Group | Input tokens | Cacheable | Uncached | Cost units | Scripted req | Extra req | Ctx median | Ctx P90 | Ctx max | Compactions | Pauses | Core errors | Facts visible % | Saved vs B % | Saved vs E % |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| A | 102,804,518 | 102,614,697 | 189,821 | 10,451,290.7 | 1,117 | 0 | 87,167 | 176,143 | 189,876 | 0 | 0 | 0 | 100.0 | 79.2 | -54.9 |
| B | 492,853,807 | 491,858,902 | 994,905 | 50,180,795.2 | 1,117 | 7,044 | 57,765 | 113,808 | 146,956 | 0 | 0 | 0 | 100.0 | 0.0 | -643.7 |
| C | 11,585,538 | 10,588,923 | 996,615 | 2,055,507.3 | 1,117 | 134 | 9,778 | 14,902 | 18,943 | 0 | 0 | 0 | 99.1 | 95.9 | 69.5 |
| D | 67,182,104 | 66,366,359 | 815,745 | 7,452,380.9 | 1,117 | 247 | 46,785 | 93,376 | 124,561 | 0 | 0 | 0 | 100.0 | 85.1 | -10.5 |
| E | 60,748,354 | 60,001,457 | 746,897 | 6,747,042.7 | 1,117 | 269 | 41,356 | 83,243 | 101,617 | 1 | 0 | 0 | 99.2 | 86.6 | 0.0 |
| F | 15,458,430 | 5,382,636 | 10,075,794 | 10,614,057.6 | 1,117 | 1 | 11,419 | 23,445 | 70,758 | 0 | 0 | 0 | 96.3 | 78.8 | -57.3 |

## Fact probes (real model)

Provider openai-compatible (host api.deepseek.com); Model deepseek-flash; max_tokens 200; thinking disabled; temperature 0; each question asked once (samples fml); groups A, C, D, E. A probe sends the scripted request exactly as the group sent it, plus one uncached question segment; answers are graded by strings only (stale: an old answer appears; wrong: neither expected nor old; error: the request failed or the probe never fired).

Group "none" is the no-context control: each probed fact asked once with the question alone and no project context. Its correct share is what the model gets right from general knowledge, so read the other groups against it.

Answers per group and fact category (%):

| Group | Category | Probes | Correct | Stale | Wrong | Error |
|---|---|---|---|---|---|---|
| A | change | 33 | 90.9 | 6.1 | 3.0 | 0.0 |
| A | contract | 27 | 100.0 | 0.0 | 0.0 | 0.0 |
| A | conv | 45 | 100.0 | 0.0 | 0.0 | 0.0 |
| A | fail | 30 | 100.0 | 0.0 | 0.0 | 0.0 |
| A | all | 135 | 97.8 | 1.5 | 0.7 | 0.0 |
| C | change | 33 | 90.9 | 9.1 | 0.0 | 0.0 |
| C | contract | 27 | 100.0 | 0.0 | 0.0 | 0.0 |
| C | conv | 45 | 100.0 | 0.0 | 0.0 | 0.0 |
| C | fail | 30 | 96.7 | 0.0 | 3.3 | 0.0 |
| C | all | 135 | 97.0 | 2.2 | 0.7 | 0.0 |
| D | change | 33 | 87.9 | 6.1 | 6.1 | 0.0 |
| D | contract | 27 | 100.0 | 0.0 | 0.0 | 0.0 |
| D | conv | 45 | 100.0 | 0.0 | 0.0 | 0.0 |
| D | fail | 30 | 100.0 | 0.0 | 0.0 | 0.0 |
| D | all | 135 | 97.0 | 1.5 | 1.5 | 0.0 |
| E | change | 33 | 84.8 | 9.1 | 6.1 | 0.0 |
| E | contract | 27 | 100.0 | 0.0 | 0.0 | 0.0 |
| E | conv | 45 | 97.8 | 0.0 | 2.2 | 0.0 |
| E | fail | 30 | 100.0 | 0.0 | 0.0 | 0.0 |
| E | all | 135 | 95.6 | 2.2 | 2.2 | 0.0 |
| none | change | 11 | 18.2 | 0.0 | 81.8 | 0.0 |
| none | contract | 9 | 44.4 | 0.0 | 55.6 | 0.0 |
| none | conv | 15 | 60.0 | 0.0 | 40.0 | 0.0 |
| none | fail | 10 | 10.0 | 0.0 | 90.0 | 0.0 |
| none | all | 45 | 35.6 | 0.0 | 64.4 | 0.0 |

Answers per group and tier (%):

| Group | Tier | Probes | Correct | Stale | Wrong | Error |
|---|---|---|---|---|---|---|
| A | xlong | 135 | 97.8 | 1.5 | 0.7 | 0.0 |
| C | xlong | 135 | 97.0 | 2.2 | 0.7 | 0.0 |
| D | xlong | 135 | 97.0 | 1.5 | 1.5 | 0.0 |
| E | xlong | 135 | 95.6 | 2.2 | 2.2 | 0.0 |
| none | xlong | 45 | 35.6 | 0.0 | 64.4 | 0.0 |

Real usage and cost (tokens as the provider counted them; prices: user-supplied via --price: $0.15 input (cache miss), $0.003 input (cache hit), $0.6 output per MTok; the user is responsible for these prices):

| Group | Requests | Input (uncached) | Cache write | Cache read | Output | Cost |
|---|---|---|---|---|---|---|
| A | 135 | 200,812 | 0 | 17,220,480 | 4,080 | $0.0842 |
| C | 135 | 510,730 | 0 | 1,126,528 | 5,379 | $0.0832 |
| D | 135 | 738,836 | 0 | 8,435,456 | 3,916 | $0.1385 |
| E | 135 | 661,721 | 0 | 6,618,368 | 3,986 | $0.1215 |
| none | 45 | 1,006 | 0 | 0 | 900 | $0.0007 |
| Total | 585 | 2,113,105 | 0 | 33,400,832 | 18,261 | $0.4281 |

Total real cost $0.4281 of --max-cost $6.0000.

R-B19 comparison for probe requests (requests with reported usage only). Estimated: the bench's token count (an approximation of the model's tokenizer) and its R-B19 cacheable tokens; real: prompt tokens = uncached + cache write + cache read, as reported. Real cache reads also depend on what earlier probes wrote within the cache lifetime and on the minimum cacheable length.

| Group | Est. input | Est. cacheable | Est. cacheable % | Real prompt | Real cache read | Real cache read % | Real cache write |
|---|---|---|---|---|---|---|---|
| A | 17,974,265 | 17,938,990 | 99.8 | 17,421,292 | 17,220,480 | 98.8 | 0 |
| C | 1,606,836 | 1,524,775 | 94.9 | 1,637,258 | 1,126,528 | 68.8 | 0 |
| D | 9,596,124 | 9,532,122 | 99.3 | 9,174,292 | 8,435,456 | 91.9 | 0 |
| E | 7,795,937 | 7,734,673 | 99.2 | 7,280,089 | 6,618,368 | 90.9 | 0 |
| none | 1,044 | 0 | 0.0 | 1,006 | 0 | 0.0 | 0 |

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
- E compacted in this run (see the compactions column); a scenario where E shows 0 compactions stayed below its threshold (window x compact ratio).
- Wake counts (extra requests) for D, E and F depend on how often humans and bots @-mention each other in the scenario.
- Cacheable, in every group: the longest leading run of a request's segments identical to that bot's previous request (on a bot's first request, the fixed template only); in C a segment must also be flagged cacheable by the core, which flags every stream segment, so where C used the stream this prefix rule alone decides; the C upper-bound line is printed only for scenarios that never used it.
- F's context is the shared pages (project, current plan, one per delivered workstream) plus the bot's own history: there is no chat thread.
- In D and E reviewers get a reference to the deliverable, not its text (in E only the author's chat message); a real reviewer would fetch the content with an extra tool call, which is not counted.
- C's lead reviews with the core's review context (the deliverable's text and the reviewed workstream's contracts, conventions, decisions, facts and failures) and replans with its planning context (every human message so far and the previous plan); the host passes the core a trigger with the task line, merged wakes and pending tool results.
- C, E and F always carry the goal and constraints; A, B and D see them only through human messages.
- C's host adds the routed message and any wake merged into a bot's own next step to that bot's trigger; the core's wake detail only says why the bot was woken.
- Fact visibility is literal text matching of a marker: a group that paraphrases a fact counts as missing it.
- Group E's compaction summary is assumed to keep every marker seen before compacting (favourable to E). On xlong scenarios, where E compacts, this assumption weighs more.
- In groups A, B, D, E and F the lead's own history carries a replan and new conventions twice: in its announcement and in its tool call (in A, the single agent's history).
- In groups D and E reviewers get deliverable references, so facts written inside a deliverable reach them less often.
- C misses a fact in three ways, all core behaviour reported as results: (a) relevance projection: a bot's brief shows board items (failures, contracts) of its own part of the plan only, while many facts concern everyone; (b) seen-compression: once a bot has acted on a brief that showed a board item, later briefs show it compactly without its text (a contract without its spec, other items cut short), so they can lack its marker; (c) chat shown once: a chat message reaches a bot once (in its delta, its trigger or the planning context) and afterwards only where a board item restates it, so the lead, which owns no workstream, loses a change after that, and a fact written only as bot chat never reaches the board. An extraction model (not used here) would only turn human chat into board items.
- Tool-call arguments are rendered in the author's own history only (R-L4); other bots see a call's effect (a page, a board item, a deliverable) but not its arguments. A sendMessage text is a posted message, posted once: not again when the same step's reply already contains it.
- A and B exceed the 128,000-token window in this run: their figures assume an unlimited context window (only E models the window and compaction).
- C uses the core's long-project stream mode (--c-stream core, or auto from the request at which a scenario's ledger holds autoAfterEntries entries; before that C is exactly as without it): every request is the core's buildStream (a brief, or a review or planning request for the lead's review and replan steps), and after each scripted request the bench passes the bot's reply and tool-call lines, in E's author format (tool arguments and full deliverables), to recordOwnOutput, as D and E histories carry them. A snapshot carries the whole board, contracts retired by a replan, and every human message (older ones beyond snapshotHumanKeep folded to 160 characters); later requests append project-wide changes, item-level updates of the bot's memory, notes and part, its own output, and the trigger or review/planning body; once more than restreamTokens were appended since the snapshot, the next request is a new snapshot. The per-scenario stream line gives the step of the first streamed request and the snapshot count (each bot's first included). The C miss causes (a)-(c) above apply only to what the stream does not restate.
- When the markers exceed E's summary budget, E keeps markers in scenario order and drops the rest.
