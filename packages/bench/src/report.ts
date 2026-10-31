import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { nearestRank, type GroupMetrics } from './metrics.js';
import type { CallRecord, Group } from './types.js';

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
  meta: { scenarios: string[]; params: Record<string, number>; dsbotRef: 'f823773'; tiers: Record<string, 'standard' | 'long'> },
): string {
  const out: string[] = [
    '> Results come from a scripted fake model: they measure context size only, not task quality.',
    '',
    '# Context bench report',
    '',
    'Parameters:',
    '',
    ...Object.keys(meta.params).sort().map(k => `- ${k}: ${meta.params[k]}`),
    '',
    'Cost units = cacheable tokens x cache ratio + uncached tokens. Saved % = (reference cost - group cost) / reference cost x 100; n/a when the reference cost is 0.',
    '',
  ];
  const tierOf = (sc: string): 'standard' | 'long' => meta.tiers[sc] ?? 'standard';
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
      if (c.unfinished) out.push('Group C: the project was not finished (a workstream of the approved plan was never delivered).');
      out.push('');
    }
    if (tierOf(sc) === 'long') {
      const from = [...new Set(rows.flatMap(r => r.growth.map(b => b.fromStep)))].sort((a, b) => a - b);
      if (from.length > 0) {
        out.push('Average request input tokens per 25-step bucket:', '');
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
  const tiersPresent = (['standard', 'long'] as const).filter(t => meta.scenarios.some(sc => tierOf(sc) === t));
  for (const t of tiersPresent) {
    const sums = ORDER.map(g => sumGroup(all.filter(r => tierOf(r.scenario) === t), g)).filter((r): r is GroupMetrics => r !== undefined);
    out.push(tiersPresent.length > 1 ? `## Summary (${t} scenarios)` : '## Summary (all scenarios)', '');
    out.push(...table(sums, g => {
      const s = sums.find(r => r.group === g)!;
      return [s.contextMedian, s.contextP90, s.contextMax];
    }), '');
  }
  out.push(
    '## Caveats', '',
    '- Results come from a scripted fake model; only context size is measured.',
    '- Quality and consistency conflicts: needs a real model, not measured.',
    `- E approximates DS Bot ${meta.dsbotRef}.`,
    '- B and F approximate Grok Bot and Dots + Space from public descriptions.',
    '- A also stands for Muse/Duet.',
    "- C uses the core's own common segment instead of the shared template.",
    '- Tool definitions are not counted in any group.',
    "- A fact's category is set by its id prefix; some failure facts come from failed review notes (event-plan records no failure op).",
    '- C pays one extra lead brief at step 0 when a scenario opens with a human message.',
    '- A is a single-agent baseline, not a multi-bot alternative: its one append-only history is mostly cacheable, so A can be the cheapest group on cost units.',
    "- The bundled scenarios are short, so E's compaction does not trigger at the default window; pass a smaller --window to see it.",
    '- Wake counts (extra requests) for D, E and F depend on how often humans and bots @-mention each other in the scenario.',
    "- Cacheable, in every group: the longest leading run of a request's segments identical to that bot's previous request (on a bot's first request, the fixed template only); in C a segment must also be flagged cacheable by the core. The per-scenario C upper-bound line shows what caching the core's stable segments would give.",
    "- F's context is the shared pages plus the bot's own history: there is no chat thread.",
    "- In C, D and E reviewers get a reference to the deliverable, not its text (in E only the author's chat message); a real reviewer would fetch the content with an extra tool call, which is not counted.",
    '- C, E and F always carry the goal and constraints; A, B and D see them only through human messages.',
    "- C's host adds the routed message and any wake merged into a bot's own next step to that bot's trigger; the core's wake detail only says why the bot was woken.",
    '- Fact visibility is literal text matching of a marker: a group that paraphrases a fact counts as missing it.',
    "- Group E's compaction summary is assumed to keep every marker seen before compacting (favourable to E).",
    "- When the markers exceed E's summary budget, E keeps markers in scenario order and drops the rest.",
    '',
  );
  return out.join('\n');
}

export function writeResults(
  dir: string,
  payload: { records: CallRecord[]; metrics: GroupMetrics[]; params: Record<string, number> },
  report: string,
): void {
  mkdirSync(dir, { recursive: true });
  const params: Record<string, number> = {};
  for (const k of Object.keys(payload.params).sort()) params[k] = payload.params[k]!;
  const json = JSON.stringify({ params, metrics: payload.metrics, records: payload.records }, null, 2) + '\n';
  writeFileSync(join(dir, 'results.json'), json);
  writeFileSync(join(dir, 'report.md'), report);
}
