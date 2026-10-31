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
  /**
   * Group C only: what a provider that caches the core's flagged stable segments could cache, and
   * the cost units that would give. Shown as a caveat line, never in the tables (R-B19).
   */
  /** Fact visibility: opportunities are scripted requests after a fact's step whose audience includes the bot. */
  tier: 'standard' | 'long';
  factOpportunities: number;
  factHits: number;
  factMisses: number;
  /** One entry per scenario fact, in scenario order; a fact with no opportunity has 0/0. */
  perFact: { id: string; opportunities: number; hits: number }[];
  /** Average input tokens of all requests per 25-step bucket (fromStep 0, 25, ...); empty buckets omitted. */
  growth: { fromStep: number; avgInput: number }[];
  upperBound?: { cacheableTokens: number; costUnits: number };
}

/** Nearest-rank percentile (p in (0,1]); an empty set gives 0. */
export function nearestRank(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.max(1, Math.ceil(p * sorted.length));
  return sorted[Math.min(rank, sorted.length) - 1]!;
}

export function computeMetrics(
  group: Group,
  scenario: string,
  records: CallRecord[],
  stats: PolicyStats,
  cacheRatio: number,
  tier: 'standard' | 'long',
  /** The scenario's fact ids in order; defaults to the ids seen in the records (first-seen order). */
  factIds?: string[],
): GroupMetrics {
  for (const r of records) {
    if (r.group !== group) throw new Error(`computeMetrics: record of group ${r.group} in metrics for group ${group}`);
    if (r.scenario !== scenario) throw new Error(`computeMetrics: record of scenario ${r.scenario} in metrics for scenario ${scenario}`);
  }
  const inputTokens = records.reduce((n, r) => n + r.inputTokens, 0);
  const cacheableTokens = records.reduce((n, r) => n + r.cacheableTokens, 0);
  const uncachedTokens = inputTokens - cacheableTokens;
  const sizes = records.map(r => r.inputTokens);
  const cost = (cacheable: number) => cacheable * cacheRatio + (inputTokens - cacheable);
  const ids = factIds ?? [...new Set(records.flatMap(r => [...(r.factsSeen ?? []), ...(r.factsMissed ?? [])]))];
  const perFact = ids.map(id => {
    const hits = records.filter(r => r.factsSeen?.includes(id)).length;
    const misses = records.filter(r => r.factsMissed?.includes(id)).length;
    return { id, opportunities: hits + misses, hits };
  });
  const factHits = records.reduce((n, r) => n + (r.factsSeen?.length ?? 0), 0);
  const factMisses = records.reduce((n, r) => n + (r.factsMissed?.length ?? 0), 0);
  const buckets = new Map<number, number[]>();
  for (const r of records) {
    const from = Math.floor(r.step / 25) * 25;
    buckets.set(from, [...(buckets.get(from) ?? []), r.inputTokens]);
  }
  const growth = [...buckets.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([fromStep, v]) => ({ fromStep, avgInput: Math.round(v.reduce((n, x) => n + x, 0) / v.length) }));
  const m: GroupMetrics = {
    tier,
    factOpportunities: factHits + factMisses,
    factHits,
    factMisses,
    perFact,
    growth,
    group,
    scenario,
    inputTokens,
    cacheableTokens,
    uncachedTokens,
    costUnits: cost(cacheableTokens),
    scriptedRequests: records.filter(r => r.kind === 'scripted').length,
    extraRequests: records.filter(r => r.kind === 'extra').length,
    contextMedian: nearestRank(sizes, 0.5),
    contextP90: nearestRank(sizes, 0.9),
    contextMax: sizes.reduce((max, n) => Math.max(max, n), 0),
    series: records.map(r => ({ step: r.step, botId: r.botId, inputTokens: r.inputTokens })),
    compactions: stats.compactions,
    pauses: stats.pauses,
    coreErrors: stats.coreErrors,
    unfinished: stats.unfinished ?? false,
  };
  if (stats.cacheableUpperBound !== undefined) {
    m.upperBound = { cacheableTokens: stats.cacheableUpperBound, costUnits: cost(stats.cacheableUpperBound) };
  }
  return m;
}
