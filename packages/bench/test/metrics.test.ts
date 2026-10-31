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
    const m = computeMetrics(recs(100, 60), zero, 0.1);
    expect(m).toMatchObject({ inputTokens: 100, cacheableTokens: 60, uncachedTokens: 40, costUnits: 46 });
  });

  test('median/p90/max with nearest-rank; empty → 0, never NaN', () => {
    const rs = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100].map(n => rec(n, 0));
    const m = computeMetrics(rs, zero, 0.1);
    expect([m.contextMedian, m.contextP90, m.contextMax]).toEqual([50, 90, 100]);
    expect(nearestRank([], 0.5)).toBe(0);
    const e = computeMetrics([], zero, 0.1);
    expect(e).toMatchObject({ inputTokens: 0, costUnits: 0, contextMedian: 0, contextP90: 0, contextMax: 0, series: [], unfinished: false });
  });

  test('counts scripted and extra requests, builds the series and copies stats', () => {
    const m = computeMetrics(
      [rec(5, 0, 'scripted', 0, 'a'), rec(7, 0, 'extra', 1, 'b')],
      { compactions: 2, pauses: 1, coreErrors: 3, unfinished: true },
      0.1,
    );
    expect(m).toMatchObject({ group: 'B', scenario: 's', scriptedRequests: 1, extraRequests: 1, compactions: 2, pauses: 1, coreErrors: 3, unfinished: true });
    expect(m.series).toEqual([{ step: 0, botId: 'a', inputTokens: 5 }, { step: 1, botId: 'b', inputTokens: 7 }]);
  });
});
