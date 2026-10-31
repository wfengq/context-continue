import { describe, expect, test } from 'vitest';
import { computeMetrics, nearestRank } from '../src/metrics.js';
import type { CallRecord, PolicyStats } from '../src/types.js';

const zero: PolicyStats = { compactions: 0, pauses: 0, coreErrors: 0 };
const rec = (inputTokens: number, cacheableTokens: number, kind: 'scripted' | 'extra' = 'scripted', step = 0, botId = 'x'): CallRecord => ({
  group: 'B', scenario: 's', step, botId, kind, inputTokens, cacheableTokens,
});
const recs = (i: number, c: number) => [rec(i, c)];

describe('computeMetrics', () => {
  test('costUnits = cacheable×ratio + uncached', () => {
    const m = computeMetrics('B', 's', recs(100, 60), zero, 0.1);
    expect(m).toMatchObject({ inputTokens: 100, cacheableTokens: 60, uncachedTokens: 40, costUnits: 46 });
  });

  test('median/p90/max with nearest-rank; empty → 0, never NaN', () => {
    const rs = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100].map(n => rec(n, 0));
    const m = computeMetrics('B', 's', rs, zero, 0.1);
    expect([m.contextMedian, m.contextP90, m.contextMax]).toEqual([50, 90, 100]);
    expect(nearestRank([], 0.5)).toBe(0);
    const e = computeMetrics('D', 'empty', [], zero, 0.1);
    expect(e).toMatchObject({ group: 'D', scenario: 'empty', inputTokens: 0, costUnits: 0, contextMedian: 0, contextP90: 0, contextMax: 0, series: [], unfinished: false });
  });

  test('counts scripted and extra requests, builds the series and copies stats', () => {
    const m = computeMetrics(
      'B', 's',
      [rec(5, 0, 'scripted', 0, 'a'), rec(7, 0, 'extra', 1, 'b')],
      { compactions: 2, pauses: 1, coreErrors: 3, unfinished: true },
      0.1,
    );
    expect(m).toMatchObject({ group: 'B', scenario: 's', scriptedRequests: 1, extraRequests: 1, compactions: 2, pauses: 1, coreErrors: 3, unfinished: true });
    expect(m.series).toEqual([{ step: 0, botId: 'a', inputTokens: 5 }, { step: 1, botId: 'b', inputTokens: 7 }]);
  });

  test('nearest rank on one value and on 1..10', () => {
    expect([nearestRank([7], 0.5), nearestRank([7], 0.9)]).toEqual([7, 7]);
    const ten = [10, 9, 8, 7, 6, 5, 4, 3, 2, 1];
    expect([nearestRank(ten, 0.5), nearestRank(ten, 0.9), nearestRank(ten, 1)]).toEqual([5, 9, 10]);
  });

  test('group and scenario are explicit; a record of another group or scenario is an error', () => {
    expect(() => computeMetrics('C', 's', recs(1, 0), zero, 0.1)).toThrow(/group B.*C/);
    expect(() => computeMetrics('B', 'other', recs(1, 0), zero, 0.1)).toThrow(/scenario/);
  });

  test('C upper bound: core-flagged cacheable tokens and their cost units; absent for other groups', () => {
    const c = { ...rec(100, 20), group: 'C' as const };
    const m = computeMetrics('C', 's', [c], { ...zero, cacheableUpperBound: 60 }, 0.1);
    // 60 × 0.1 + 40 = 46
    expect(m.upperBound).toEqual({ cacheableTokens: 60, costUnits: 46 });
    expect(computeMetrics('B', 's', recs(100, 20), zero, 0.1).upperBound).toBeUndefined();
  });
});
