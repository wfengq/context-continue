import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_OPTIONS } from '@context-continue/core';
import { usageCost, type ModelPrice, type ProbeEstimateRow, type ReplayEstimateRow } from './cost.js';
import { growthBucket, nearestRank, type GroupMetrics } from './metrics.js';
import type { ProbeSamples } from './probe.js';
import type { CallRecord, Group, ModelUsage, ProbeRecord, ProbeVerdict, Tier } from './types.js';

const ORDER: Group[] = ['A', 'B', 'C', 'D', 'E', 'F'];

/** Locale-independent integer with thousands separators. */
export function fmtInt(n: number): string {
  const r = Math.round(n);
  const digits = String(Math.abs(r)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return r < 0 ? `-${digits}` : digits;
}

const fmtCost = (n: number): string => {
  const [i, d] = n.toFixed(1).split('.');
  return `${fmtInt(Number(i))}.${d}`;
};

/** Savings of x against ref in percent, one decimal; n/a when there is no reference. */
function savings(ref: GroupMetrics | undefined, x: GroupMetrics): string {
  if (!ref || ref.costUnits === 0) return 'n/a';
  const pct = (((ref.costUnits - x.costUnits) / ref.costUnits) * 100).toFixed(1);
  return pct === '-0.0' ? '0.0' : pct;
}

/** Hits / opportunities in percent, one decimal; n/a without opportunities. */
const pct = (hits: number, opportunities: number): string => (opportunities === 0 ? 'n/a' : ((hits / opportunities) * 100).toFixed(1));

const HEADER = [
  'Group', 'Input tokens', 'Cacheable', 'Uncached', 'Cost units', 'Scripted req', 'Extra req',
  'Ctx median', 'Ctx P90', 'Ctx max', 'Compactions', 'Pauses', 'Core errors', 'Facts visible %', 'Saved vs B %', 'Saved vs E %',
];

function table(rows: GroupMetrics[], contextOf: (g: Group) => [number, number, number]): string[] {
  const by = (g: Group) => rows.find(r => r.group === g);
  const lines = [`| ${HEADER.join(' | ')} |`, `|${HEADER.map(() => '---').join('|')}|`];
  for (const g of ORDER) {
    const r = by(g);
    if (!r) continue;
    const [med, p90, max] = contextOf(g);
    const cells = [
      g + (r.unfinished ? ' (not finished)' : ''), fmtInt(r.inputTokens), fmtInt(r.cacheableTokens), fmtInt(r.uncachedTokens),
      fmtCost(r.costUnits), fmtInt(r.scriptedRequests), fmtInt(r.extraRequests), fmtInt(med), fmtInt(p90), fmtInt(max),
      fmtInt(r.compactions), fmtInt(r.pauses), fmtInt(r.coreErrors), pct(r.factHits, r.factOpportunities), savings(by('B'), r), savings(by('E'), r),
    ];
    lines.push(`| ${cells.join(' | ')} |`);
  }
  return lines;
}

function sumGroup(rows: GroupMetrics[], g: Group): GroupMetrics | undefined {
  const mine = rows.filter(r => r.group === g);
  if (mine.length === 0) return undefined;
  const sum = (f: (r: GroupMetrics) => number) => mine.reduce((n, r) => n + f(r), 0);
  const sizes = mine.flatMap(r => r.series.map(s => s.inputTokens));
  return {
    group: g, scenario: 'all', tier: mine[0]!.tier,
    factOpportunities: sum(r => r.factOpportunities), factHits: sum(r => r.factHits), factMisses: sum(r => r.factMisses),
    perFact: [], growth: [],
    inputTokens: sum(r => r.inputTokens), cacheableTokens: sum(r => r.cacheableTokens), uncachedTokens: sum(r => r.uncachedTokens),
    costUnits: sum(r => r.costUnits), scriptedRequests: sum(r => r.scriptedRequests), extraRequests: sum(r => r.extraRequests),
    contextMedian: nearestRank(sizes, 0.5), contextP90: nearestRank(sizes, 0.9), contextMax: sizes.reduce((m, n) => Math.max(m, n), 0),
    series: [], compactions: sum(r => r.compactions), pauses: sum(r => r.pauses), coreErrors: sum(r => r.coreErrors),
    unfinished: mine.some(r => r.unfinished),
  };
}

export function renderReport(
  all: GroupMetrics[],
  meta: { scenarios: string[]; params: Record<string, number>; cPublic?: string; cStream?: string; dsbotRef: 'f823773'; tiers: Record<string, Tier>; probes?: ProbeSection; replay?: ReplaySection },
): string {
  const out: string[] = [
    '> Results come from a scripted fake model: they measure context size only, not task quality.',
    ...(meta.probes === undefined && meta.replay === undefined
      ? []
      : meta.replay === undefined
        ? [`> The fact-probe section used a real model (${meta.probes!.provider === undefined ? 'anthropic' : 'openai-compatible'}, ${meta.probes!.model}); everything else is still scripted.`]
        : [
            `> The ${meta.probes === undefined ? 'replay section' : 'fact-probe and replay sections'} used a real model (${meta.replay.provider === undefined ? 'anthropic' : 'openai-compatible'}, ${meta.replay.model}); everything else is still scripted.`,
          ]),
    '',
    '# Context bench report',
    '',
    'Parameters:',
    '',
    ...Object.keys(meta.params).sort().map(k => `- ${k}: ${meta.params[k]}`),
    ...(meta.cPublic === undefined ? [] : [`- cPublic: ${meta.cPublic}`]),
    ...(meta.cStream === undefined ? [] : [`- cStream: ${meta.cStream}`]),
    '',
    'Cost units = cacheable tokens x cache ratio + uncached tokens. Saved % = (reference cost - group cost) / reference cost x 100; n/a when the reference cost is 0.',
    '',
  ];
  // R-L3: a scenario's tier is the one its metrics carry; meta.tiers must name every scenario and agree.
  const tiers = new Map<string, Tier>();
  for (const sc of meta.scenarios) {
    const given = meta.tiers[sc];
    if (given === undefined) throw new Error(`renderReport: meta.tiers has no tier for scenario "${sc}"`);
    for (const r of all.filter(x => x.scenario === sc)) {
      if (r.tier !== given) throw new Error(`renderReport: scenario "${sc}" is ${r.tier} in the metrics of group ${r.group} but ${given} in meta.tiers`);
    }
    tiers.set(sc, given);
  }
  const tierOf = (sc: string): Tier => tiers.get(sc)!;
  for (const sc of meta.scenarios) {
    const rows = all.filter(r => r.scenario === sc);
    out.push(`## Scenario: ${sc}`, '');
    const byG = (g: Group) => rows.find(r => r.group === g)!;
    out.push(...table(rows, g => [byG(g).contextMedian, byG(g).contextP90, byG(g).contextMax]), '');
    const c = rows.find(r => r.group === 'C');
    if (c) {
      out.push(`Group C core errors: ${c.coreErrors}.`);
      if (c.upperBound) {
        out.push(
          `Group C upper bound if a provider caches the core's stable segments: cacheable ${fmtInt(c.upperBound.cacheableTokens)}, ` +
            `cost units ${fmtCost(c.upperBound.costUnits)} (measured: cacheable ${fmtInt(c.cacheableTokens)}, cost units ${fmtCost(c.costUnits)}).`,
        );
      }
      if (c.stream) {
        const st = c.stream;
        out.push(
          st.fromStep === null
            ? `Group C stream: not used (ledger ${fmtInt(st.ledgerEntries)} entries, below autoAfterEntries).`
            : `Group C stream: used from step ${st.fromStep}; ${fmtInt(st.snapshots)} snapshots; ledger ${fmtInt(st.ledgerEntries)} entries.`,
        );
      }
      if (c.unfinished) out.push('Group C: the project was not finished (a workstream of the approved plan was never delivered).');
      out.push('');
    }
    if (tierOf(sc) !== 'standard') {
      const from = [...new Set(rows.flatMap(r => r.growth.map(b => b.fromStep)))].sort((a, b) => a - b);
      if (from.length > 0) {
        out.push(`Average request input tokens per ${growthBucket(tierOf(sc))}-step bucket:`, '');
        out.push(`| Group | ${from.map(f => `From step ${f}`).join(' | ')} |`, `|---|${from.map(() => '---').join('|')}|`);
        for (const g of ORDER) {
          const r = rows.find(x => x.group === g);
          if (r) out.push(`| ${g} | ${from.map(f => { const b = r.growth.find(x => x.fromStep === f); return b ? fmtInt(b.avgInput) : 'n/a'; }).join(' | ')} |`);
        }
        out.push('');
      }
    }
    const present = ORDER.filter(g => rows.some(r => r.group === g));
    const ids = rows[0]?.perFact.map(f => f.id) ?? [];
    if (ids.length > 0) {
      out.push('Fact visibility % per fact:', '');
      out.push(`| Fact | ${present.join(' | ')} |`, `|---|${present.map(() => '---').join('|')}|`);
      for (const id of ids) {
        const cells = present.map(g => {
          const f = rows.find(r => r.group === g)!.perFact.find(x => x.id === id);
          return f ? pct(f.hits, f.opportunities) : 'n/a';
        });
        out.push(`| ${id} | ${cells.join(' | ')} |`);
      }
      out.push('');
    }
  }
  const tiersPresent = (['standard', 'long', 'xlong'] as const).filter(t => meta.scenarios.some(sc => tierOf(sc) === t));
  for (const t of tiersPresent) {
    const sums = ORDER.map(g => sumGroup(all.filter(r => meta.scenarios.includes(r.scenario) && r.tier === t), g)).filter(
      (r): r is GroupMetrics => r !== undefined,
    );
    out.push(`## Summary (${t} scenarios)`, '');
    out.push(...table(sums, g => {
      const s = sums.find(r => r.group === g)!;
      return [s.contextMedian, s.contextP90, s.contextMax];
    }), '');
  }
  if (meta.probes !== undefined) out.push(...renderProbeSection(meta.probes, tierOf, meta.replay !== undefined));
  if (meta.replay !== undefined) out.push(...renderReplaySection(meta.replay, tierOf, meta.scenarios));
  const eInRun = all.some(r => r.group === 'E' && meta.scenarios.includes(r.scenario));
  const eCompacted = all.some(r => r.group === 'E' && meta.scenarios.includes(r.scenario) && r.compactions > 0);
  const hasXlong = tiersPresent.includes('xlong');
  const streamOn = meta.cStream !== undefined && meta.cStream !== 'off';
  /** `--c-stream core|auto`: the core library's stream mode, not the bench prototype (`on`). */
  const coreStream = streamOn && /^(core|auto)\b/.test(meta.cStream!);
  const protoStream = streamOn && !coreStream;
  const ownOn = protoStream && meta.cStream!.includes('own outputs');
  out.push(
    '## Caveats', '',
    meta.probes === undefined && meta.replay === undefined
      ? '- Results come from a scripted fake model; only context size is measured.'
      : `- Results come from a scripted fake model; only context size is measured, except the ${meta.replay === undefined ? 'fact-probe section, which used' : meta.probes === undefined ? 'replay section, which used' : 'fact-probe and replay sections, which used'} a real model.`,
    '- Quality and consistency conflicts: needs a real model, not measured.',
    `- E approximates DS Bot ${meta.dsbotRef}.`,
    '- B and F approximate Grok Bot and Dots + Space from public descriptions.',
    '- A also stands for Muse/Duet.',
    "- C uses the core's own common segment instead of the shared template.",
    '- Tool definitions are not counted in any group.',
    '- C pays one extra lead brief at step 0 when a scenario opens with a human message.',
    '- A is a single-agent baseline, not a multi-bot alternative: its one append-only history is mostly cacheable, so A can be the cheapest group on cost units.',
    ...(eCompacted
      ? ["- E compacted in this run (see the compactions column); a scenario where E shows 0 compactions stayed below its threshold (window x compact ratio)."]
      : eInRun
        ? ["- E did not compact in this run: every scenario stayed below its compaction threshold (window x compact ratio); pass a smaller --window to see it."]
        : []),
    '- Wake counts (extra requests) for D, E and F depend on how often humans and bots @-mention each other in the scenario.',
    "- Cacheable, in every group: the longest leading run of a request's segments identical to that bot's previous request (on a bot's first request, the fixed template only); " +
      (coreStream
        ? 'in C a segment must also be flagged cacheable by the core, which flags every stream segment, so where C used the stream this prefix rule alone decides; the C upper-bound line is printed only for scenarios that never used it.'
        : protoStream
          ? 'with --c-stream on every C stream segment counts as flagged cacheable, so this prefix rule alone decides for C too.'
          : "in C a segment must also be flagged cacheable by the core. The per-scenario C upper-bound line shows what caching the core's stable segments would give."),
    "- F's context is the shared pages (project, current plan, one per delivered workstream) plus the bot's own history: there is no chat thread.",
    "- In D and E reviewers get a reference to the deliverable, not its text (in E only the author's chat message); a real reviewer would fetch the content with an extra tool call, which is not counted.",
    "- C's lead reviews with the core's review context (the deliverable's text and the reviewed workstream's contracts, conventions, decisions, facts and failures) and replans with its planning context (every human message so far and the previous plan); the host passes the core a trigger with the task line, merged wakes and pending tool results.",
    '- C, E and F always carry the goal and constraints; A, B and D see them only through human messages.',
    "- C's host adds the routed message and any wake merged into a bot's own next step to that bot's trigger; the core's wake detail only says why the bot was woken.",
    '- Fact visibility is literal text matching of a marker: a group that paraphrases a fact counts as missing it.',
    "- Group E's compaction summary is assumed to keep every marker seen before compacting (favourable to E)." +
      (hasXlong && eCompacted ? ' On xlong scenarios, where E compacts, this assumption weighs more.' : ''),
    "- In groups A, B, D, E and F the lead's own history carries a replan and new conventions twice: in its announcement and in its tool call (in A, the single agent's history).",
    '- In groups D and E reviewers get deliverable references, so facts written inside a deliverable reach them less often.',
    "- C misses a fact in three ways, all core behaviour reported as results: (a) relevance projection: a bot's brief shows board items (failures, contracts) of its own part of the plan only, while many facts concern everyone; (b) seen-compression: once a bot has acted on a brief that showed a board item, later briefs show it compactly without its text (a contract without its spec, other items cut short), so they can lack its marker; (c) chat shown once: a chat message reaches a bot once (in its delta, its trigger or the planning context) and afterwards only where a board item restates it, so the lead, which owns no workstream, loses a change after that, and a fact written only as bot chat never reaches the board. An extraction model (not used here) would only turn human chat into board items.",
    "- Tool-call arguments are rendered in the author's own history only (R-L4); other bots see a call's effect (a page, a board item, a deliverable) but not its arguments. A sendMessage text is a posted message, posted once: not again when the same step's reply already contains it.",
  );
  // Scenario- and run-specific caveats print only when they apply (R-L12).
  if (meta.scenarios.includes('event-plan')) {
    out.push("- A fact's category is set by its id prefix; some failure facts come from failed review notes (event-plan records no failure op).");
  }
  // Only E models a context window; any other group whose request outgrows it is reported as such.
  const window = meta.params.window;
  if (window !== undefined) {
    const over = ORDER.filter(g => g !== 'E' && all.some(r => r.group === g && meta.scenarios.includes(r.scenario) && r.contextMax > window));
    if (over.length > 0) {
      const names = over.length === 1 ? over[0]! : `${over.slice(0, -1).join(', ')} and ${over[over.length - 1]}`;
      const [verb, their] = over.length === 1 ? ['exceeds', 'its'] : ['exceed', 'their'];
      out.push(`- ${names} ${verb} the ${fmtInt(window)}-token window in this run: ${their} figures assume an unlimited context window (only E models the window and compaction).`);
    }
  }
  // C's board keeps human messages only when the directives section is on (default, all, or a list containing it).
  const directivesOn = meta.cPublic === undefined || meta.cPublic === 'default' || meta.cPublic === 'all' || meta.cPublic.split(',').includes('directives');
  if (coreStream) {
    out.push(
      "- C uses the core's long-project stream mode (--c-stream core, or auto from the request at which a scenario's ledger holds autoAfterEntries entries; before that C is exactly as without it): " +
        "every request is the core's buildStream (a brief, or a review or planning request for the lead's review and replan steps), and after each scripted request the bench passes the bot's reply and tool-call lines, " +
        "in E's author format (tool arguments and full deliverables), to recordOwnOutput, as D and E histories carry them. " +
        "A snapshot carries the whole board, contracts retired by a replan, and every human message (older ones beyond snapshotHumanKeep folded to 160 characters); later requests append project-wide changes, item-level updates of the bot's memory, notes and part, its own output, and the trigger or review/planning body; " +
        'once more than restreamTokens were appended since the snapshot, the next request is a new snapshot. The per-scenario stream line gives the step of the first streamed request and the snapshot count (each bot\'s first included). ' +
        'The C miss causes (a)-(c) above apply only to what the stream does not restate.',
    );
  }
  if (protoStream) {
    out.push(
      "- C runs the --c-stream prototype: the core is driven as without it, but each bot's request is an append-only stream assembled by the bench. " +
        'A snapshot (common, memory, workspace, a board with every convention, contract, decision, failure, workstream and human message in full, the projection) ' +
        "is followed per request by new or changed project-wide items (to every bot), the new lines of the bot's memory, notes or projection whenever the core's text of one changed (removed items as one 'no longer' line; seen compaction ignored), " +
        "the core's delta and trigger, or the review/planning body; a snapshot on a review or replan takes the lead's projection from a peek brief; " +
        (ownOn
          ? "with --c-stream-own on (a measurement variant) it also appends the bot's own reply and tool-call lines after each scripted request, in E's author format (tool arguments and full deliverables), as D and E histories carry them; "
          : "like C without the stream, it does not carry the bot's own replies or tool calls; ") +
        'once more than restreamTokens were appended since the snapshot, the next request is a new snapshot. Every stream segment counts as flagged cacheable, ' +
        'so no upper-bound line is printed, and the C miss causes (a)-(c) above apply only to what the stream does not restate.',
    );
  }
  if (hasXlong && directivesOn && !streamOn) {
    out.push(`- C keeps only the newest ${DEFAULT_OPTIONS.directivesKeep} human messages on the board (the default); on xlong scenarios older human messages reach the lead mostly only through the planning context and later restatements.`);
  }
  if (eCompacted) {
    out.push("- When the markers exceed E's summary budget, E keeps markers in scenario order and drops the rest.");
  }
  out.push('');
  return out.join('\n');
}

export function writeResults(
  dir: string,
  payload: { records: CallRecord[]; metrics: GroupMetrics[]; params: Record<string, number>; cPublic?: string; cStream?: unknown; probes?: ProbeSection; replay?: ReplaySection },
  report: string,
): void {
  mkdirSync(dir, { recursive: true });
  const params: Record<string, number> = {};
  for (const k of Object.keys(payload.params).sort()) params[k] = payload.params[k]!;
  const json = JSON.stringify({ params, ...(payload.cPublic === undefined ? {} : { cPublic: payload.cPublic }), ...(payload.cStream === undefined ? {} : { cStream: payload.cStream }), metrics: payload.metrics, records: payload.records, ...(payload.probes === undefined ? {} : { probes: payload.probes }), ...(payload.replay === undefined ? {} : { replay: payload.replay }) }, null, 2) + '\n';
  writeFileSync(join(dir, 'results.json'), json);
  writeFileSync(join(dir, 'report.md'), report);
}

/** The fact-probe results of a real run, as results.json's `probes` section and the report's input. */
export interface ProbeSection {
  model: string;
  /** Present for an OpenAI-compatible provider only (absent for anthropic, so its output is unchanged). */
  provider?: 'openai';
  /** Host (with port) of --base-url; never the full URL or its query. */
  baseUrlHost?: string;
  maxTokens: number;
  thinking: 'disabled' | 'not sent';
  temperature: string;
  samples: ProbeSamples;
  maxPerScenario?: number;
  groups: Group[];
  /** True when the no-context control (group "none") was asked as well. */
  control: boolean;
  maxCost: number;
  price: ModelPrice;
  /** Real usage and cost over every probe request (as the provider reported it). */
  usage: ModelUsage;
  cost: number;
  /** One entry per scenario-group run in which probing was stopped (cost guard, or a fatal API error). */
  stopped: { scenario: string; group: Group | 'none'; reason: string }[];
  /** True when --replay ran too: --max-cost is one budget for both, so the probe cost is only part of it. */
  sharedBudget?: true;
  records: ProbeRecord[];
}

const VERDICTS: ProbeVerdict[] = ['correct', 'stale', 'wrong', 'error'];
const usd = (n: number): string => `$${n.toFixed(4)}`;
/** A fact's category is its id prefix (change-, conv-, contract-, fail-). */
const categoryOf = (factId: string): string => factId.split('-')[0] ?? factId;

function verdictCells(recs: ProbeRecord[]): string[] {
  return [fmtInt(recs.length), ...VERDICTS.map(v => pct(recs.filter(r => r.verdict === v).length, recs.length))];
}

function renderProbeSection(p: ProbeSection, tierOf: (sc: string) => Tier, replayOn = false): string[] {
  const groups = [...ORDER, 'none' as const].filter(g => p.records.some(r => r.group === g));
  const out: string[] = [
    '## Fact probes (real model)', '',
    `${p.provider === undefined ? '' : `Provider openai-compatible (host ${p.baseUrlHost}); `}Model ${p.model}; max_tokens ${p.maxTokens}; thinking ${p.thinking}; temperature ${p.temperature}; each question asked once (samples ${p.samples}` +
      `${p.maxPerScenario === undefined ? '' : `, at most ${p.maxPerScenario} per scenario`}); groups ${p.groups.join(', ')}. ` +
      'A probe sends the scripted request exactly as the group sent it, plus one uncached question segment; answers are graded by strings only ' +
      '(stale: an old answer appears; wrong: neither expected nor old; error: the request failed or the probe never fired).',
    '',
  ];
  if (p.records.some(r => r.group === 'none')) {
    out.push(
      'Group "none" is the no-context control: each probed fact asked once with the question alone and no project context. ' +
        'Its correct share is what the model gets right from general knowledge, so read the other groups against it.',
      '',
    );
  }
  if (p.stopped.length > 0) {
    out.push(
      `${replayOn ? 'Real-model requests stopped' : 'Probing stopped'}: ${p.stopped[0]!.reason} (in ${p.stopped.map(x => `${x.scenario}/${x.group}`).join(', ')}). ` +
        `${replayOn ? 'Replay requests and probes' : 'Probes'} are sent in run order (scenario by scenario, groups in order), so the groups and scenarios after the stop lost their ${replayOn ? 'requests' : 'probes'} first: ` +
        'their percentages are not comparable with the others; compare the raw probe counts.',
      '',
    );
  }
  out.push('Answers per group and fact category (%):', '');
  out.push('| Group | Category | Probes | Correct | Stale | Wrong | Error |', '|---|---|---|---|---|---|---|');
  for (const g of groups) {
    const mine = p.records.filter(r => r.group === g);
    for (const c of [...new Set(mine.map(r => categoryOf(r.factId)))].sort()) {
      out.push(`| ${g} | ${c} | ${verdictCells(mine.filter(r => categoryOf(r.factId) === c)).join(' | ')} |`);
    }
    out.push(`| ${g} | all | ${verdictCells(mine).join(' | ')} |`);
  }
  out.push('', 'Answers per group and tier (%):', '');
  out.push('| Group | Tier | Probes | Correct | Stale | Wrong | Error |', '|---|---|---|---|---|---|---|');
  for (const g of groups) {
    for (const t of ['standard', 'long', 'xlong'] as const) {
      const mine = p.records.filter(r => r.group === g && tierOf(r.scenario) === t);
      if (mine.length > 0) out.push(`| ${g} | ${t} | ${verdictCells(mine).join(' | ')} |`);
    }
  }
  const sumUsage = (recs: ProbeRecord[]): ModelUsage =>
    recs.reduce<ModelUsage>((a, r) => (r.usage === undefined ? a : {
      inputTokens: a.inputTokens + r.usage.inputTokens, cacheWriteTokens: a.cacheWriteTokens + r.usage.cacheWriteTokens,
      cacheReadTokens: a.cacheReadTokens + r.usage.cacheReadTokens, outputTokens: a.outputTokens + r.usage.outputTokens,
    }), { inputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0, outputTokens: 0 });
  const costOf = (recs: ProbeRecord[]) => recs.reduce((n, r) => (r.usage === undefined ? n : n + usageCost(p.price, r.usage)), 0);
  out.push('', `Real usage and cost (tokens as the provider counted them; prices: ${p.price.source}):`, '');
  out.push('| Group | Requests | Input (uncached) | Cache write | Cache read | Output | Cost |', '|---|---|---|---|---|---|---|');
  const row = (label: string, recs: ProbeRecord[]) => {
    const u = sumUsage(recs);
    return `| ${label} | ${fmtInt(recs.filter(r => r.usage !== undefined).length)} | ${fmtInt(u.inputTokens)} | ${fmtInt(u.cacheWriteTokens)} | ${fmtInt(u.cacheReadTokens)} | ${fmtInt(u.outputTokens)} | ${usd(costOf(recs))} |`;
  };
  for (const g of groups) out.push(row(g, p.records.filter(r => r.group === g)));
  out.push(row('Total', p.records));
  out.push('', p.sharedBudget === true ? `Total real probe cost ${usd(p.cost)}; --max-cost ${usd(p.maxCost)} is one budget shared with the replay requests (see the replay section).` : `Total real cost ${usd(p.cost)} of --max-cost ${usd(p.maxCost)}.`, '');
  out.push(
    "R-B19 comparison for probe requests (requests with reported usage only). Estimated: the bench's token count (an approximation of the model's tokenizer) and its R-B19 cacheable tokens; " +
      'real: prompt tokens = uncached + cache write + cache read, as reported. Real cache reads also depend on what earlier probes wrote within the cache lifetime and on the minimum cacheable length.' +
      (replayOn ? ' With --replay, each probe followed the replay of the same request, so its prefix was just cached and its cache % cannot be compared with a probe-only run.' : ''),
    '',
  );
  out.push('| Group | Est. input | Est. cacheable | Est. cacheable % | Real prompt | Real cache read | Real cache read % | Real cache write |', '|---|---|---|---|---|---|---|---|');
  for (const g of groups) {
    const recs = p.records.filter(r => r.group === g && r.usage !== undefined);
    const estIn = recs.reduce((n, r) => n + r.inputTokens, 0);
    const estC = recs.reduce((n, r) => n + r.cacheableTokens, 0);
    const u = sumUsage(recs);
    const prompt = u.inputTokens + u.cacheWriteTokens + u.cacheReadTokens;
    out.push(`| ${g} | ${fmtInt(estIn)} | ${fmtInt(estC)} | ${pct(estC, estIn)} | ${fmtInt(prompt)} | ${fmtInt(u.cacheReadTokens)} | ${pct(u.cacheReadTokens, prompt)} | ${fmtInt(u.cacheWriteTokens)} |`);
  }
  out.push('');
  return out;
}

/** The dry-run estimate as Markdown (printed and written as probe-estimate.md). */
export function renderProbeEstimate(
  est: { rows: ProbeEstimateRow[]; total: Omit<ProbeEstimateRow, 'scenario' | 'group'> },
  meta: { model: string; provider?: 'openai'; baseUrlHost?: string; maxTokens: number; samples: ProbeSamples; groups: (Group | 'none')[]; maxCost: number | null; maxPerScenario?: number },
  tiers: Record<string, Tier>,
): string {
  const cells = (x: Omit<ProbeEstimateRow, 'scenario' | 'group'>) =>
    [fmtInt(x.probes), fmtInt(x.inputTokens), fmtInt(x.cacheableTokens), fmtInt(x.outputTokens), usd(x.costLow), usd(x.costHigh)].join(' | ');
  const out = [
    '# Probe dry run (no requests sent)', '',
    `${meta.provider === undefined ? '' : `Provider openai-compatible (host ${meta.baseUrlHost}); `}Model ${meta.model}; max_tokens ${meta.maxTokens}; samples ${meta.samples}${meta.maxPerScenario === undefined ? '' : `; at most ${meta.maxPerScenario} probes per scenario`}; groups ${meta.groups.join(', ')}.`,
    '',
    "Tokens are the bench's count (defaultCountTokens: about 4 characters, or 1 CJK character, per token), an approximation of the model's real tokenizer, " +
      `which may count noticeably more. Low: every R-B19 cacheable token is a cache read; high: every one is ${meta.provider === undefined ? 'a cache write' : 'at the input price'}. Output is counted at max_tokens (its upper bound).`,
    '',
    '| Scenario | Tier | Group | Probes | Input tokens | Cacheable | Output (max) | Cost low | Cost high |',
    '|---|---|---|---|---|---|---|---|---|',
    ...est.rows.map(r => `| ${r.scenario} | ${tiers[r.scenario] ?? 'standard'} | ${r.group} | ${cells(r)} |`),
    `| Total | | | ${cells(est.total)} |`,
    '',
  ];
  if (meta.maxCost !== null) {
    out.push(
      est.total.costHigh <= meta.maxCost
        ? `--max-cost ${usd(meta.maxCost)}: the high estimate fits.`
        : `--max-cost ${usd(meta.maxCost)}: the high estimate does not fit; the cost guard would stop probing early.`,
      '',
    );
  }
  return out.join('\n');
}

/** One scenario x group of a replay run, as results.json's `replay.groups` entry (no per-request records). */
export interface ReplayGroupRow {
  scenario: string;
  group: Group;
  /** Replayed requests (including failed ones). */
  requests: number;
  errors: number;
  /** Errored requests that carry no usage (5xx, 429, network, a request too long): their cost is missing from `cost`. */
  errorsNoUsage: number;
  usage: ModelUsage;
  cost: number;
  /** Cache read / (uncached + cache write + cache read) in percent; null without reported prompt tokens. */
  realCacheReadPct: number | null;
  /** The bench's R-B19 cacheable share of the group's input tokens in percent; null without input. */
  estCacheablePct: number | null;
  estCostUnits: number;
  /** The bench's token counts over the same requests (uncached = input - cacheable), to recompute the est. cost at another ratio. */
  estInputTokens: number;
  estCacheableTokens: number;
  /** Every request of this scenario and group was replayed and the real-model requests were not stopped. */
  complete: boolean;
}

/** The replay results of a real run, as results.json's `replay` section and the report's input. Never holds the key or the full base URL. */
export interface ReplaySection {
  model: string;
  provider?: 'openai';
  /** Host (with port) of --base-url; never the full URL or its query. */
  baseUrlHost?: string;
  maxTokens: number;
  price: ModelPrice;
  /** The --cache-ratio the est. cost units use. */
  cacheRatio: number;
  maxCost: number;
  /** Real cost and usage of the replay requests alone (what the group rows sum to). */
  cost: number;
  usage: ModelUsage;
  /** True when --probes ran too: --max-cost is one budget for both. */
  sharedBudget?: true;
  /** One entry per scenario-group run in which real-model requests were stopped; absent when none was. */
  stopped?: { scenario: string; group: Group; reason: string }[];
  groups: ReplayGroupRow[];
}

const signed = (n: number): string => {
  const t = n.toFixed(1);
  return t === '-0.0' || t === '0.0' ? '0.0' : n > 0 ? `+${t}` : t;
};
/** (x - ref) / ref in percent with a sign; n/a without a reference. */
const diffPct = (x: number, ref: number): string => (ref === 0 ? 'n/a' : signed(((x - ref) / ref) * 100));

function renderReplaySection(p: ReplaySection, tierOf: (sc: string) => Tier, scenarios: string[]): string[] {
  const out: string[] = [
    '## Replay on a real model', '',
    `${p.provider === undefined ? '' : `Provider openai-compatible (host ${p.baseUrlHost}); `}Model ${p.model}; max_tokens ${p.maxTokens}. ` +
      'Every request a group made, scripted and extra, was also sent once, in order, to this model with the segments exactly as the group sent them; its answers were discarded and never entered the project. ' +
      `Prices: ${p.price.source}.`,
    '',
    '- Groups share a short fixed template at the start (a few hundred tokens), so a group run later may get slightly more cache hits.',
    "- The real model's answers do not change the project: this measures cost, cache and answers to the probes, not the quality of the work.",
    "- The provider's cache is best effort (DeepSeek does not guarantee hits); that variation is part of the real result, and each configuration ran once.",
    '- Replay output is cut to 16 tokens, so the output part of the real cost is too low; the input part is what this measures.',
    '',
  ];
  if (p.stopped !== undefined && p.stopped.length > 0) {
    out.push(
      `Real-model requests stopped: ${p.stopped[0]!.reason} (in ${p.stopped.map(x => `${x.scenario}/${x.group}`).join(', ')}). ` +
        'The scripted run went on; groups after the stop sent no replay requests. Groups marked incomplete below are left out of the comparison tables.',
      '',
    );
  }
  out.push(
    '| Scenario | Group | Requests | Errors | Input (uncached) | Cache write | Cache read | Output | Real cost | Real cache read % | Est. cacheable % | Est. cost units | Complete |',
    '|---|---|---|---|---|---|---|---|---|---|---|---|---|',
  );
  const nz = (v: number | null): string => (v === null ? 'n/a' : v.toFixed(1));
  for (const r of p.groups) {
    out.push(
      `| ${r.scenario} | ${r.group} | ${fmtInt(r.requests)} | ${fmtInt(r.errors)} | ${fmtInt(r.usage.inputTokens)} | ${fmtInt(r.usage.cacheWriteTokens)} | ${fmtInt(r.usage.cacheReadTokens)} | ${fmtInt(r.usage.outputTokens)} | ${usd(r.cost)} | ${nz(r.realCacheReadPct)} | ${nz(r.estCacheablePct)} | ${fmtCost(r.estCostUnits)} | ${r.complete ? 'yes' : 'no'} |`,
    );
  }
  out.push('', p.sharedBudget === true ? `Total replay cost ${usd(p.cost)}; --max-cost ${usd(p.maxCost)} is one budget shared with the fact probes.` : `Total replay cost ${usd(p.cost)} of --max-cost ${usd(p.maxCost)}.`, '');
  const tiersPresent = (['standard', 'long', 'xlong'] as const).filter(t => scenarios.some(sc => tierOf(sc) === t));
  const ratio = p.price.short.input === 0 ? 0 : Number((p.price.short.cacheRead / p.price.short.input).toFixed(4));
  for (const t of tiersPresent) {
    out.push(`Group C against D and E, ${t} scenarios (negative: C is cheaper). Only scenarios where both groups are complete and no request failed without usage count:`, '');
    out.push(
      `Estimated cost units use --cache-ratio ${p.cacheRatio} (uncached + ratio x cacheable). The last column recomputes the estimated diff at the rate card's price ratio ${ratio} (cache hit / cache miss), the ratio the real cost was paid at.`, '',
    );
    out.push(`| Reference | Scenarios | Real cost C | Real cost ref | Real diff % | Est. units C | Est. units ref | Est. diff % | Est. diff % at price ratio ${ratio} |`, '|---|---|---|---|---|---|---|---|---|');
    const skipped: string[] = [];
    const noted = new Map<string, ReplayGroupRow>();
    const excluded = new Map<string, ReplayGroupRow>();
    for (const ref of ['D', 'E'] as const) {
      const used: string[] = [];
      let c = { cost: 0, units: 0, at: 0 };
      let d = { cost: 0, units: 0, at: 0 };
      const at = (x: ReplayGroupRow) => x.estInputTokens - x.estCacheableTokens + ratio * x.estCacheableTokens;
      for (const sc of scenarios.filter(x => tierOf(x) === t)) {
        const rc = p.groups.find(r => r.scenario === sc && r.group === 'C');
        const rr = p.groups.find(r => r.scenario === sc && r.group === ref);
        if (rc === undefined || rr === undefined) {
          skipped.push(`${sc} vs ${ref}: group ${rc === undefined ? 'C' : ref} is not in this run`);
        } else if (!rc.complete || !rr.complete) {
          skipped.push(`${sc} vs ${ref}: group ${[!rc.complete ? 'C' : '', !rr.complete ? ref : ''].filter(x => x !== '').join(' and ')} incomplete (real-model requests stopped before every request was replayed)`);
        } else if (rc.errorsNoUsage > 0 || rr.errorsNoUsage > 0) {
          for (const x of [rc, rr]) if (x.errorsNoUsage > 0) excluded.set(`${sc}/${x.group}`, x);
        } else {
          used.push(sc);
          for (const x of [rc, rr]) {
            if (x.errors > 0) noted.set(`${sc}/${x.group}`, x);
          }
          c = { cost: c.cost + rc.cost, units: c.units + rc.estCostUnits, at: c.at + at(rc) };
          d = { cost: d.cost + rr.cost, units: d.units + rr.estCostUnits, at: d.at + at(rr) };
        }
      }
      out.push(
        used.length === 0
          ? `| ${ref} | none | n/a | n/a | n/a | n/a | n/a | n/a | n/a |`
          : `| ${ref} | ${used.join(', ')} | ${usd(c.cost)} | ${usd(d.cost)} | ${diffPct(c.cost, d.cost)} | ${fmtCost(c.units)} | ${fmtCost(d.units)} | ${diffPct(c.units, d.units)} | ${diffPct(c.at, d.at)} |`,
      );
    }
    out.push('');
    if (skipped.length > 0) out.push(...skipped.map(x => `Skipped: ${x}.`), '');
    for (const [key, row] of excluded) {
      out.push(`Excluded: ${key} had ${fmtInt(row.errorsNoUsage)} failed replay request${row.errorsNoUsage === 1 ? '' : 's'} without usage; its real cost is missing those requests, so the row is left out of the comparison.`, '');
    }
    for (const [key, row] of noted) {
      out.push(`Errors: ${key} had ${fmtInt(row.errors)} failed replay request${row.errors === 1 ? '' : 's'}, all with reported usage (counted in its real cost).`, '');
    }
  }
  return out;
}

/** The `--dry-run --replay` estimate as Markdown (printed and written as replay-estimate.md). */
export function renderReplayEstimate(
  est: { rows: ReplayEstimateRow[]; total: Omit<ReplayEstimateRow, 'scenario' | 'group'> },
  meta: { model: string; provider?: 'openai'; baseUrlHost?: string; maxTokens: number; maxCost: number | null },
  tiers: Record<string, Tier>,
): string {
  const cells = (x: Omit<ReplayEstimateRow, 'scenario' | 'group'>) =>
    [fmtInt(x.requests), fmtInt(x.inputTokens), fmtInt(x.cacheableTokens), fmtInt(x.outputTokens), usd(x.costLow), usd(x.costHigh)].join(' | ');
  const out = [
    '# Replay dry run (no requests sent)', '',
    `${meta.provider === undefined ? '' : `Provider openai-compatible (host ${meta.baseUrlHost}); `}Model ${meta.model}; max_tokens ${meta.maxTokens}; every request of every selected group is replayed once.`,
    '',
    "Tokens are the bench's count (defaultCountTokens: about 4 characters, or 1 CJK character, per token), an approximation of the model's real tokenizer, " +
      `which may count noticeably more. Low: every R-B19 cacheable token is a cache read; high: every one is ${meta.provider === undefined ? 'a cache write' : 'at the input price'}. Output is counted at max_tokens (its upper bound).`,
    '',
    '| Scenario | Tier | Group | Requests | Input tokens | Cacheable | Output (max) | Cost low | Cost high |',
    '|---|---|---|---|---|---|---|---|---|',
    ...est.rows.map(r => `| ${r.scenario} | ${tiers[r.scenario] ?? 'standard'} | ${r.group} | ${cells(r)} |`),
    `| Total | | | ${cells(est.total)} |`,
    '',
  ];
  if (meta.maxCost !== null) {
    out.push(
      est.total.costHigh <= meta.maxCost
        ? `--max-cost ${usd(meta.maxCost)}: the high estimate fits.`
        : `--max-cost ${usd(meta.maxCost)}: the high estimate does not fit; the cost guard would stop real-model requests early.`,
      '',
    );
  }
  return out.join('\n');
}
