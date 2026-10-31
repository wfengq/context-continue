import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import type { GroupMetrics } from '../src/metrics.js';
import { fmtInt, renderReport, writeResults } from '../src/report.js';
import type { Group } from '../src/types.js';

const meta = { scenarios: ['s1', 's2'], params: { ratio: 0.1 }, dsbotRef: 'f823773' as const };
const gm = (group: Group, scenario: string, input: number, extra: Partial<GroupMetrics> = {}): GroupMetrics => ({
  group, scenario, inputTokens: input, cacheableTokens: 0, uncachedTokens: input, costUnits: input,
  scriptedRequests: 2, extraRequests: 1, contextMedian: input / 2, contextP90: input, contextMax: input,
  series: [{ step: 0, botId: 'a', inputTokens: input }], compactions: 0, pauses: 0, coreErrors: 0, unfinished: false, ...extra,
});
const groups: Group[] = ['A', 'B', 'C', 'D', 'E', 'F'];
const all = (): GroupMetrics[] =>
  ['s1', 's2'].flatMap(s => groups.map((g, i) => gm(g, s, 1000 * (i + 1) + (s === 's2' ? 7 : 0))));

describe('renderReport', () => {
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
      "- The bundled scenarios are short, so E's compaction does not trigger at the default window; pass a smaller --window to see it.",
    );
    expect(lines).toContain(
      '- Wake counts (extra requests) for D, E and F depend on how often humans and bots @-mention each other in the scenario.',
    );
  });

  test('byte-identical for identical input', () => {
    expect(renderReport(all(), meta)).toBe(renderReport(all(), meta));
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
