import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import type { GroupMetrics } from '../src/metrics.js';
import { fmtInt, renderReport, writeResults } from '../src/report.js';
import type { Group } from '../src/types.js';

const meta = { scenarios: ['s1', 's2'], params: { ratio: 0.1 }, dsbotRef: 'f823773' as const, tiers: { s1: 'standard', s2: 'standard' } as Record<string, 'standard' | 'long' | 'xlong'> };
const gm = (group: Group, scenario: string, input: number, extra: Partial<GroupMetrics> = {}): GroupMetrics => ({
  group, scenario, inputTokens: input, cacheableTokens: 0, uncachedTokens: input, costUnits: input,
  scriptedRequests: 2, extraRequests: 1, contextMedian: input / 2, contextP90: input, contextMax: input,
  series: [{ step: 0, botId: 'a', inputTokens: input }], compactions: 0, pauses: 0, coreErrors: 0, unfinished: false,
  tier: 'standard', factOpportunities: 0, factHits: 0, factMisses: 0, perFact: [], growth: [], ...extra,
});
const groups: Group[] = ['A', 'B', 'C', 'D', 'E', 'F'];
const all = (): GroupMetrics[] =>
  ['s1', 's2'].flatMap(s => groups.map((g, i) => gm(g, s, 1000 * (i + 1) + (s === 's2' ? 7 : 0))));

describe('renderReport', () => {
  test('the real-model header line appears with probes, naming provider and model, and not without', () => {
    const probes = {
      model: 'deepseek-chat', provider: 'openai' as const, baseUrlHost: 'api.example.com', maxTokens: 200, thinking: 'not sent' as const, temperature: '0',
      samples: 'fml' as const, groups: ['A' as Group], control: false, maxCost: 1, price: { input: 1, cacheRead: 1, cacheWrite: 1, output: 1 },
      usage: { inputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0, outputTokens: 0 }, cost: 0, stopped: [], records: [],
    } as unknown as NonNullable<Parameters<typeof renderReport>[1]['probes']>;
    const withP = renderReport(all(), { ...meta, probes });
    const line = withP.split('\n')[1]!;
    expect(line).toMatch(/^> The fact-probe section used a real model \(openai-compatible, deepseek-chat\)/);
    expect(withP.split('\n')[0]).toContain('scripted fake model');
    expect(renderReport(all(), meta)).not.toContain('used a real model');
  });
  test('starts with the disclaimer; one table per scenario plus a summary', () => {
    const md = renderReport(all(), meta);
    expect(md.startsWith('> Results come from a scripted fake model')).toBe(true);
    expect(md.match(/^\| Group \|/gm)).toHaveLength(3);
  });

  test('savings vs B and vs E use one decimal; zero denominator prints n/a', () => {
    const md = renderReport([gm('B', 's1', 1000), gm('E', 's1', 0), gm('C', 's1', 250)], { ...meta, scenarios: ['s1'] });
    const c = md.split('\n').filter(l => l.startsWith('| C |'))[0]!;
    expect(c).toContain('75.0');
    expect(c).toContain('n/a');
    expect(md).not.toMatch(/NaN|Infinity/);
  });

  test('rows only for groups present, in A-F order; thousands separators', () => {
    const md = renderReport([gm('F', 's1', 1234567), gm('A', 's1', 5)], { ...meta, scenarios: ['s1'] });
    const rows = md.split('\n').filter(l => /^\| [A-F] \|/.test(l)).map(l => l[2]);
    expect(rows).toEqual(['A', 'F', 'A', 'F']);
    expect(md).toContain('1,234,567');
    expect(fmtInt(-1234)).toBe('-1,234');
  });

  test('C core errors and unfinished projects are shown', () => {
    const md = renderReport([gm('C', 's1', 100, { coreErrors: 4, unfinished: true })], { ...meta, scenarios: ['s1'] });
    expect(md).toMatch(/^\| C \(not finished\) \|.*\| 4 \|/m);
    expect(md.toLowerCase()).toContain('not finished');
  });

  test('caveats section', () => {
    const md = renderReport(all(), meta);
    expect(md).toContain('needs a real model, not measured');
    expect(md).toContain('E approximates DS Bot f823773');
    expect(md).toContain('B and F approximate Grok Bot and Dots + Space from public descriptions');
    expect(md).toContain('A also stands for Muse/Duet');
    expect(md).toContain("C uses the core's own common segment instead of the shared template");
    expect(md).toContain('Tool definitions are not counted in any group');
    expect(md).toContain('extra lead brief at step 0');
  });

  test('caveats explain how to read the results (R-B18)', () => {
    const lines = renderReport(all(), meta).split('\n');
    expect(lines).toContain(
      "- A is a single-agent baseline, not a multi-bot alternative: its one append-only history is mostly cacheable, so A can be the cheapest group on cost units.",
    );
    expect(lines).toContain(
      "- E did not compact in this run: every scenario stayed below its compaction threshold (window x compact ratio); pass a smaller --window to see it.",
    );
    expect(lines).toContain(
      '- Wake counts (extra requests) for D, E and F depend on how often humans and bots @-mention each other in the scenario.',
    );
  });

  test('savings never print -0.0; n/a when B is absent', () => {
    // E 1000.04 vs B 1000: −0.004 % rounds to "-0.0" with toFixed
    const md = renderReport([gm('B', 's1', 1000), gm('E', 's1', 1000, { costUnits: 1000.04 })], { ...meta, scenarios: ['s1'] });
    expect(md).not.toContain('-0.0');
    expect(md.split('\n').find(l => l.startsWith('| E |'))).toContain('| 0.0 |');
    const noB = renderReport([gm('C', 's1', 10), gm('E', 's1', 20)], { ...meta, scenarios: ['s1'] });
    expect(noB.split('\n').find(l => l.startsWith('| C |'))).toMatch(/\| n\/a \| 50\.0 \|$/);
  });

  test('C upper bound line per scenario when C has one', () => {
    const md = renderReport(
      [gm('C', 's1', 1000, { cacheableTokens: 100, upperBound: { cacheableTokens: 600, costUnits: 460 } })],
      { ...meta, scenarios: ['s1'] },
    );
    expect(md).toContain(
      "Group C upper bound if a provider caches the core's stable segments: cacheable 600, cost units 460.0 (measured: cacheable 100, cost units 1,000.0).",
    );
  });

  test('stream mode: the cacheable caveat drops the core-flag clause and the upper-bound sentence, and says the prefix rule alone decides for C', () => {
    const plain = "- Cacheable, in every group: the longest leading run of a request's segments identical to that bot's previous request (on a bot's first request, the fixed template only); in C a segment must also be flagged cacheable by the core. The per-scenario C upper-bound line shows what caching the core's stable segments would give.";
    for (const cStream of ['on (restreamTokens 8000)', 'on (restreamTokens 8000, own outputs)']) {
      const md = renderReport(all(), { ...meta, cStream });
      expect(md).not.toContain('in C a segment must also be flagged');
      expect(md).not.toContain('upper-bound line shows');
      expect(md.split('\n')).toContain(
        "- Cacheable, in every group: the longest leading run of a request's segments identical to that bot's previous request (on a bot's first request, the fixed template only); with --c-stream on every C stream segment counts as flagged cacheable, so this prefix rule alone decides for C too.",
      );
    }
    expect(renderReport(all(), { ...meta, cStream: 'off' }).split('\n')).toContain(plain);
    expect(renderReport(all(), meta).split('\n')).toContain(plain);
  });

  test('core stream mode: cacheable caveat names the core flags, the core caveat replaces the prototype one, and each scenario gets a stream line', () => {
    const rows = all().map(r => (r.group !== 'C' ? r : { ...r, stream: r.scenario === 's1' ? { fromStep: 12, snapshots: 9, ledgerEntries: 412 } : { fromStep: null, snapshots: 0, ledgerEntries: 180 } }));
    for (const cStream of ['core (restreamTokens 8000)', 'auto (restreamTokens 8000, autoAfterEntries 400)']) {
      const md = renderReport(rows, { ...meta, cStream });
      const lines = md.split('\n');
      expect(lines).toContain(
        "- Cacheable, in every group: the longest leading run of a request's segments identical to that bot's previous request (on a bot's first request, the fixed template only); in C a segment must also be flagged cacheable by the core, which flags every stream segment, so where C used the stream this prefix rule alone decides; the C upper-bound line is printed only for scenarios that never used it.",
      );
      expect(lines).toContain('Group C stream: used from step 12; 9 snapshots; ledger 412 entries.');
      expect(lines).toContain('Group C stream: not used (ledger 180 entries, below autoAfterEntries).');
      expect(md).toContain("- C uses the core's long-project stream mode");
      expect(md).toContain('recordOwnOutput');
      expect(md).not.toContain('- C runs the --c-stream prototype');
    }
    // the stream line is printed only when the metrics carry stream stats
    expect(renderReport(all(), { ...meta, cStream: 'off' })).not.toContain('Group C stream:');
  });

  test('caveats: one cacheable rule, F pages only, references for C/D/E reviewers, goal and constraints (final fixes)', () => {
    const lines = renderReport(all(), meta).split('\n');
    for (const l of [
      "- Cacheable, in every group: the longest leading run of a request's segments identical to that bot's previous request (on a bot's first request, the fixed template only); in C a segment must also be flagged cacheable by the core. The per-scenario C upper-bound line shows what caching the core's stable segments would give.",
      "- F's context is the shared pages (project, current plan, one per delivered workstream) plus the bot's own history: there is no chat thread.",
      "- In D and E reviewers get a reference to the deliverable, not its text (in E only the author's chat message); a real reviewer would fetch the content with an extra tool call, which is not counted.",
      '- C, E and F always carry the goal and constraints; A, B and D see them only through human messages.',
      "- C's host adds the routed message and any wake merged into a bot's own next step to that bot's trigger; the core's wake detail only says why the bot was woken.",
    ]) expect(lines).toContain(l);
    // every earlier caveat is still there
    const md = lines.join('\n');
    for (const k of ['needs a real model, not measured', 'E approximates DS Bot', 'A also stands for Muse/Duet', 'extra lead brief at step 0', 'A is a single-agent baseline']) {
      expect(md).toContain(k);
    }
  });

  test('byte-identical for identical input', () => {
    expect(renderReport(all(), meta)).toBe(renderReport(all(), meta));
  });
});

const withFacts = (g: Group, sc: string, opp: number, hits: number, tier: 'standard' | 'long' | 'xlong' = 'standard', extra: Partial<GroupMetrics> = {}) =>
  gm(g, sc, 100, { tier, factOpportunities: opp, factHits: hits, factMisses: opp - hits, perFact: [{ id: 'fa', opportunities: opp, hits }, { id: 'fz', opportunities: 0, hits: 0 }], ...extra });

describe('renderReport: facts, growth, tiers', () => {
  const mixedMeta = { ...meta, tiers: { s1: 'standard', s2: 'long' } as Record<string, 'standard' | 'long' | 'xlong'> };
  const mixed = () => [
    ...groups.map(g => withFacts(g, 's1', 3, 2)),
    ...groups.map(g => withFacts(g, 's2', 4, 4, 'long', { growth: [{ fromStep: 0, avgInput: 120 }, { fromStep: 50, avgInput: 340 }] })),
  ];

  test('separate summary tables for standard and long; a single tier gives one table', () => {
    const md = renderReport(mixed(), mixedMeta);
    expect(md).toMatch(/## Summary \(standard scenarios\)/);
    expect(md).toMatch(/## Summary \(long scenarios\)/);
    expect(md).not.toMatch(/## Summary \(all scenarios\)/);
    const one = renderReport(all(), meta);
    expect(one.match(/^## Summary.*$/gm)).toEqual(['## Summary (standard scenarios)']);
    const onlyLong = renderReport(mixed().filter(r => r.scenario === 's2'), { ...mixedMeta, scenarios: ['s2'] });
    expect(onlyLong.match(/^## Summary.*$/gm)).toEqual(['## Summary (long scenarios)']);
  });

  test("each scenario's tier comes from its metrics; meta.tiers must agree and list every scenario", () => {
    expect(() => renderReport(mixed(), { ...mixedMeta, tiers: { s1: 'standard', s2: 'standard' } })).toThrow(/s2/);
    expect(() => renderReport(mixed(), { ...mixedMeta, tiers: { s1: 'standard' } })).toThrow(/s2/);
  });

  test('caveats name the doubled replan and conventions in the lead history and the D/E reviewer limit', () => {
    const lines = renderReport(mixed(), mixedMeta).split('\n');
    expect(lines).toContain("- In groups A, B, D, E and F the lead's own history carries a replan and new conventions twice: in its announcement and in its tool call (in A, the single agent's history).");
    expect(lines).toContain('- In groups D and E reviewers get deliverable references, so facts written inside a deliverable reach them less often.');
  });

  test('long summary pools opportunities and hits of its own tier only', () => {
    const md = renderReport(mixed(), mixedMeta);
    const longPart = md.split('## Summary (long scenarios)')[1]!.split('## Caveats')[0]!;
    expect(longPart.split('\n').find(l => l.startsWith('| A |'))).toContain('| 100.0 |');
    const stdPart = md.split('## Summary (standard scenarios)')[1]!.split('## Summary (long')[0]!;
    expect(stdPart.split('\n').find(l => l.startsWith('| A |'))).toContain('| 66.7 |');
  });

  test('scenario tables include "Facts visible %" (one decimal or n/a)', () => {
    const md = renderReport([withFacts('A', 's1', 3, 2), gm('B', 's1', 10)], { ...meta, scenarios: ['s1'] });
    expect(md).toContain('| Facts visible % |');
    expect(md.split('\n').find(l => l.startsWith('| A |'))).toContain('| 66.7 |');
    expect(md.split('\n').find(l => l.startsWith('| B |'))).toContain('| n/a |');
    expect(md).not.toMatch(/NaN|Infinity/);
  });

  test('long scenarios get a growth table; standard ones do not', () => {
    const md = renderReport(mixed(), mixedMeta);
    expect(md.match(/^\| Group \| From step 0 \| From step 50 \|$/gm)).toHaveLength(1);
    const row = md.split('\n').find(l => l === '| A | 120 | 340 |');
    expect(row).toBeDefined();
    expect(md.match(/Average request input tokens per 25-step bucket/g)).toHaveLength(1);
  });

  test('an xlong-only report has one summary table titled for xlong, and a 100-step growth table', () => {
    const xl = groups.map(g => withFacts(g, 'x1', 4, 4, 'xlong', { growth: [{ fromStep: 0, avgInput: 120 }, { fromStep: 100, avgInput: 340 }] }));
    const md = renderReport(xl, { ...meta, scenarios: ['x1'], tiers: { x1: 'xlong' } });
    expect(md.match(/^## Summary.*$/gm)).toEqual(['## Summary (xlong scenarios)']);
    expect(md.match(/Average request input tokens per 100-step bucket/g)).toHaveLength(1);
    expect(md).not.toContain('25-step');
    expect(md.match(/^\| Group \| From step 0 \| From step 100 \|$/gm)).toHaveLength(1);
    expect(md).toContain('| A | 120 | 340 |');
    // mixed with the other tiers: one summary each, in tier order, long's growth table still 25-step
    const m3 = renderReport([...mixed(), ...xl], { ...mixedMeta, scenarios: ['s1', 's2', 'x1'], tiers: { s1: 'standard', s2: 'long', x1: 'xlong' } });
    expect(m3.match(/^## Summary.*$/gm)).toEqual(['## Summary (standard scenarios)', '## Summary (long scenarios)', '## Summary (xlong scenarios)']);
    expect(m3.match(/per 25-step bucket/g)).toHaveLength(1);
    expect(m3.match(/per 100-step bucket/g)).toHaveLength(1);
  });

  test('per-fact visibility table per scenario; zero opportunities print n/a', () => {
    const md = renderReport(mixed(), mixedMeta);
    expect(md.match(/^\| Fact \|/gm)).toHaveLength(2);
    expect(md).toContain('| fa | 66.7 | 66.7 | 66.7 | 66.7 | 66.7 | 66.7 |');
    expect(md).toContain('| fz | n/a | n/a | n/a | n/a | n/a | n/a |');
    expect(md).not.toMatch(/NaN|Infinity/);
  });

  test('caveats state the visibility rule, the E summary assumption and the marker budget rule', () => {
    const lines = renderReport(mixed(), mixedMeta).split('\n');
    expect(lines).toContain('- Fact visibility is literal text matching of a marker: a group that paraphrases a fact counts as missing it.');
    expect(lines).toContain("- Group E's compaction summary is assumed to keep every marker seen before compacting (favourable to E).");
  });

  const TRUNCATION = "- When the markers exceed E's summary budget, E keeps markers in scenario order and drops the rest.";
  const EVENT_PLAN = "- A fact's category is set by its id prefix; some failure facts come from failed review notes (event-plan records no failure op).";

  test('the E marker-budget caveat prints only when E compacted at least once (R-L12)', () => {
    expect(renderReport(mixed(), mixedMeta).split('\n')).not.toContain(TRUNCATION);
    const compacted = mixed().map(r => (r.group === 'E' && r.scenario === 's2' ? { ...r, compactions: 1 } : r));
    expect(renderReport(compacted, mixedMeta).split('\n')).toContain(TRUNCATION);
  });

  test('the E compaction caveat follows whether E compacted in the run', () => {
    const none = "- E did not compact in this run: every scenario stayed below its compaction threshold (window x compact ratio); pass a smaller --window to see it.";
    const some = "- E compacted in this run (see the compactions column); a scenario where E shows 0 compactions stayed below its threshold (window x compact ratio).";
    const plain = renderReport(mixed(), mixedMeta).split('\n');
    expect([plain.includes(none), plain.includes(some)]).toEqual([true, false]);
    const compacted = renderReport(mixed().map(r => (r.group === 'E' && r.scenario === 's2' ? { ...r, compactions: 1 } : r)), mixedMeta).split('\n');
    expect([compacted.includes(none), compacted.includes(some)]).toEqual([false, true]);
    expect(compacted.join('\n')).not.toContain('stay below E');
  });

  const E_SUMMARY = "- Group E's compaction summary is assumed to keep every marker seen before compacting (favourable to E).";
  const XLONG_SUMMARY = `${E_SUMMARY} On xlong scenarios, where E compacts, this assumption weighs more.`;
  const XLONG_DIRECTIVES = '- C keeps only the newest 20 human messages on the board (the default); on xlong scenarios older human messages reach the lead mostly only through the planning context and later restatements.';
  const NO_COMPACT = "- E did not compact in this run: every scenario stayed below its compaction threshold (window x compact ratio); pass a smaller --window to see it.";
  test('the window caveat names the groups other than E whose context max exceeds --window', () => {
    const windowMeta = { ...meta, params: { ratio: 0.1, window: 2500 } };
    const lines = renderReport(all(), windowMeta).split('\n');
    // all(): A 1000/1007, B 2000/2007, C 3000/3007, D 4000/4007, E 5000/5007, F 6000/6007
    expect(lines).toContain('- C, D and F exceed the 2,500-token window in this run: their figures assume an unlimited context window (only E models the window and compaction).');
    expect(renderReport(all(), { ...meta, params: { ratio: 0.1, window: 100000 } })).not.toContain('assume an unlimited context window');
    const onlyF = renderReport(all(), { ...meta, params: { ratio: 0.1, window: 6003 } }).split('\n');
    expect(onlyF).toContain('- F exceeds the 6,003-token window in this run: its figures assume an unlimited context window (only E models the window and compaction).');
  });

  const xlongRun = (compactE: boolean) =>
    mixed().map(r => (r.scenario === 's2' ? { ...r, tier: 'xlong' as const, ...(compactE && r.group === 'E' ? { compactions: 1 } : {}) } : r));
  const xlongMeta = { ...mixedMeta, tiers: { s1: 'standard', s2: 'xlong' } as Record<string, 'standard' | 'long' | 'xlong'> };

  test('the xlong E-summary clause is merged into the E summary caveat, only when xlong and E compacted', () => {
    const plain = renderReport(mixed(), mixedMeta).split('\n');
    expect([plain.includes(E_SUMMARY), plain.includes(XLONG_SUMMARY)]).toEqual([true, false]);
    const noCompact = renderReport(xlongRun(false), xlongMeta).split('\n');
    expect([noCompact.includes(E_SUMMARY), noCompact.includes(XLONG_SUMMARY)]).toEqual([true, false]);
    const compacted = renderReport(xlongRun(true), xlongMeta).split('\n');
    expect([compacted.includes(E_SUMMARY), compacted.includes(XLONG_SUMMARY)]).toEqual([false, true]);
  });

  test('the C directives caveat prints only for an xlong run with C directives on', () => {
    const has = (md: string) => md.split('\n').includes(XLONG_DIRECTIVES);
    expect(has(renderReport(mixed(), mixedMeta))).toBe(false);
    expect(has(renderReport(xlongRun(false), xlongMeta))).toBe(true);
    for (const cPublic of ['default', 'all', 'directives', 'contracts,directives']) expect(has(renderReport(xlongRun(false), { ...xlongMeta, cPublic }))).toBe(true);
    for (const cPublic of ['none', 'contracts', 'contracts,failures']) expect(has(renderReport(xlongRun(false), { ...xlongMeta, cPublic }))).toBe(false);
  });

  test('the "E did not compact" caveat prints only when group E is in the run', () => {
    expect(renderReport(mixed(), mixedMeta).split('\n')).toContain(NO_COMPACT);
    const noE = mixed().filter(r => r.group !== 'E');
    const md = renderReport(noE, mixedMeta);
    expect(md).not.toContain('E did not compact');
    expect(md).not.toContain('E compacted in this run');
  });

  test('the event-plan caveat prints only when event-plan is in the run (R-L12)', () => {
    expect(renderReport(all(), meta).split('\n')).not.toContain(EVENT_PLAN);
    const withEventPlan = all().map(r => (r.scenario === 's2' ? { ...r, scenario: 'event-plan' } : r));
    const md = renderReport(withEventPlan, { ...meta, scenarios: ['s1', 'event-plan'], tiers: { s1: 'standard', 'event-plan': 'standard' } });
    expect(md.split('\n')).toContain(EVENT_PLAN);
  });

  test('report caveats describe C review and replan contexts and no longer list the fixed gaps', () => {
    const md = renderReport(all(), meta);
    const lines = md.split('\n');
    for (const l of [
      "- C's lead reviews with the core's review context (the deliverable's text and the reviewed workstream's contracts, conventions, decisions, facts and failures) and replans with its planning context (every human message so far and the previous plan); the host passes the core a trigger with the task line, merged wakes and pending tool results.",
      "- C misses a fact in three ways, all core behaviour reported as results: (a) relevance projection: a bot's brief shows board items (failures, contracts) of its own part of the plan only, while many facts concern everyone; (b) seen-compression: once a bot has acted on a brief that showed a board item, later briefs show it compactly without its text (a contract without its spec, other items cut short), so they can lack its marker; (c) chat shown once: a chat message reaches a bot once (in its delta, its trigger or the planning context) and afterwards only where a board item restates it, so the lead, which owns no workstream, loses a change after that, and a fact written only as bot chat never reaches the board. An extraction model (not used here) would only turn human chat into board items.",
    ]) expect(lines).toContain(l);
    // the gaps fixed in the core are no longer described
    for (const gone of [
      'In C, D and E reviewers',
      'C misses a fact in two ways',
      'after a bot has viewed a board item in an idle (extra) request',
      'routed only to the owner of the matching workstream, which may not be the lead',
      'a reviewer does not see failures recorded on the workstream it reviews',
    ]) expect(md).not.toContain(gone);
  });

  test("caveats explain that only sendMessage text is shared (R-L4, R-L9)", () => {
    const lines = renderReport(all(), meta).split('\n');
    for (const l of [
      "- Tool-call arguments are rendered in the author's own history only (R-L4); other bots see a call's effect (a page, a board item, a deliverable) but not its arguments. A sendMessage text is a posted message, posted once: not again when the same step's reply already contains it.",
    ]) expect(lines).toContain(l);
  });

  test('byte-identical for identical input; no NaN or Infinity', () => {
    expect(renderReport(mixed(), mixedMeta)).toBe(renderReport(mixed(), mixedMeta));
    expect(renderReport(mixed(), mixedMeta)).not.toMatch(/NaN|Infinity/);
  });
});

describe('C public-board setting', () => {
  test('renderReport prints cPublic in the parameters section; omitted when not given', () => {
    const md = renderReport(all(), { ...meta, cPublic: 'contracts,directives' });
    expect(md).toContain('Parameters:\n\n- ratio: 0.1\n- cPublic: contracts,directives\n\n');
    expect(renderReport(all(), meta)).not.toContain('cPublic');
  });

  test('writeResults puts cPublic as a top-level string between params and metrics', () => {
    const dir = join(mkdtempSync(join(tmpdir(), 'bench-')), 'out', 'stamp');
    const payload = { records: [], metrics: all(), params: { a: 1 }, cPublic: 'all' };
    writeResults(dir, payload, 'R\n');
    const json = readFileSync(join(dir, 'results.json'), 'utf8');
    expect(json).toBe(JSON.stringify({ params: { a: 1 }, cPublic: 'all', metrics: payload.metrics, records: [] }, null, 2) + '\n');
  });
});

describe('writeResults', () => {
  test('writes stable results.json and report.md', () => {
    const dir = join(mkdtempSync(join(tmpdir(), 'bench-')), 'out', 'stamp');
    const payload = { records: [], metrics: all(), params: { b: 2, a: 1 } };
    writeResults(dir, payload, 'REPORT\n');
    const json = readFileSync(join(dir, 'results.json'), 'utf8');
    expect(json.endsWith('}\n')).toBe(true);
    expect(json).toBe(JSON.stringify({ params: { a: 1, b: 2 }, metrics: payload.metrics, records: [] }, null, 2) + '\n');
    expect(readFileSync(join(dir, 'report.md'), 'utf8')).toBe('REPORT\n');
  });
});
