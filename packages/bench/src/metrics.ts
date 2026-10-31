import type { CallRecord, Group, PolicyStats } from './types.js';

export interface GroupMetrics {
  group: Group;
  scenario: string;
  inputTokens: number;
  cacheableTokens: number;
  uncachedTokens: number;
  costUnits: number;
  scriptedRequests: number;
  extraRequests: number;
  contextMedian: number;
  contextP90: number;
  contextMax: number;
  series: { step: number; botId: string; inputTokens: number }[];
  compactions: number;
  pauses: number;
  coreErrors: number;
  /** Group C: the project could not be finished (a workstream never delivered). */
  unfinished: boolean;
}

/** Nearest-rank percentile (p in (0,1]); an empty set gives 0. */
export function nearestRank(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.max(1, Math.ceil(p * sorted.length));
  return sorted[Math.min(rank, sorted.length) - 1]!;
}

export function computeMetrics(records: CallRecord[], stats: PolicyStats, cacheRatio: number): GroupMetrics {
  const inputTokens = records.reduce((n, r) => n + r.inputTokens, 0);
  const cacheableTokens = records.reduce((n, r) => n + r.cacheableTokens, 0);
  const uncachedTokens = inputTokens - cacheableTokens;
  const sizes = records.map(r => r.inputTokens);
  return {
    group: records[0]?.group ?? 'A',
    scenario: records[0]?.scenario ?? '',
    inputTokens,
    cacheableTokens,
    uncachedTokens,
    costUnits: cacheableTokens * cacheRatio + uncachedTokens,
    scriptedRequests: records.filter(r => r.kind === 'scripted').length,
    extraRequests: records.filter(r => r.kind === 'extra').length,
    contextMedian: nearestRank(sizes, 0.5),
    contextP90: nearestRank(sizes, 0.9),
    contextMax: sizes.reduce((m, n) => Math.max(m, n), 0),
    series: records.map(r => ({ step: r.step, botId: r.botId, inputTokens: r.inputTokens })),
    compactions: stats.compactions,
    pauses: stats.pauses,
    coreErrors: stats.coreErrors,
    unfinished: stats.unfinished ?? false,
  };
}
