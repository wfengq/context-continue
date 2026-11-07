import type { FactProbe, ProbeVerdict, Scenario, Step } from './types.js';

/** Which opportunities of a fact are probed: first / middle / last, every one, or n evenly spaced ones. */
export type ProbeSamples = 'fml' | 'all' | number;

export interface ProbeOptions {
  /** Default 'fml'. */
  samples?: ProbeSamples;
  /** At most this many probes per scenario (default no cap); see `scheduleProbes` for which are kept. */
  maxPerScenario?: number;
}

/** The final, uncached segment a probe request appends to the scripted request's segments. */
export function probeQuestion(question: string): string {
  return `Question: ${question}\nAnswer briefly.`;
}

/** Lower case, "×" as "x", no spaces around an "x" between digits ("12 x 12" → "12x12"), whitespace runs as one space, trimmed. */
export function normaliseAnswer(text: string): string {
  return text.toLowerCase().replace(/×/g, 'x').replace(/(\d)\s*x\s*(?=\d)/g, '$1x').replace(/\s+/g, ' ').trim();
}

/**
 * String grading (no model): a `reject` hit is 'stale' (it wins over an `expect` hit), else an
 * `expect` hit is 'correct', else 'wrong'. Matching is substring on normalised text (`normaliseAnswer`).
 */
export function gradeAnswer(probe: FactProbe, answer: string): ProbeVerdict {
  const a = normaliseAnswer(answer);
  if ((probe.reject ?? []).some(r => a.includes(normaliseAnswer(r)))) return 'stale';
  if (probe.expect.some(e => a.includes(normaliseAnswer(e)))) return 'correct';
  return 'wrong';
}

const requester = (s: Scenario, st: Step): string | undefined =>
  st.kind === 'work' ? st.botId : st.kind === 'human' ? undefined : s.lead;

/** Indices (ascending, deduped) into `n` opportunities for a sampling rule. */
export function sampleIndices(n: number, samples: ProbeSamples): number[] {
  if (n <= 0) return [];
  if (samples === 'all') return [...Array(n).keys()];
  if (samples === 'fml') return [...new Set([0, Math.floor((n - 1) / 2), n - 1])];
  if (!Number.isInteger(samples) || samples < 1) throw new Error(`probe samples must be 'fml', 'all' or a positive integer, got ${samples}`);
  if (samples === 1) return [n - 1];
  const k = Math.min(samples, n);
  return [...new Set([...Array(k).keys()].map(i => Math.floor((i * (n - 1)) / (k - 1))))];
}

/**
 * The probes of a scenario, independent of the group: for each fact with a probe, its opportunities
 * are the steps whose requester (work bot, or the lead for review/replan) is in the fact's audience
 * ("*" = everyone) and that come after fact.step — the same requests `factsSeen`/`factsMissed` count.
 * The sampled opportunities are ordered for the cap as a round-robin over facts (scenario order):
 * every fact's last sample, then every fact's first, then the remaining samples in step order, rank by
 * rank. `maxPerScenario` keeps a prefix of that order.
 */
export function scheduleProbes(s: Scenario, opts: ProbeOptions = {}): { factId: string; step: number }[] {
  const samples = opts.samples ?? 'fml';
  const perFact: { factId: string; steps: number[] }[] = [];
  for (const f of s.facts ?? []) {
    if (f.probe === undefined) continue;
    const opportunities: number[] = [];
    s.steps.forEach((st, i) => {
      const bot = requester(s, st);
      if (i > f.step && bot !== undefined && (f.audience.includes('*') || f.audience.includes(bot))) opportunities.push(i);
    });
    const picked = sampleIndices(opportunities.length, samples).map(i => opportunities[i]!);
    if (picked.length === 0) continue;
    // Priority within a fact: last, first, then the rest in step order.
    const last = picked[picked.length - 1]!;
    const ranked = picked.length === 1 ? [last] : [last, picked[0]!, ...picked.slice(1, -1)];
    perFact.push({ factId: f.id, steps: ranked });
  }
  const out: { factId: string; step: number }[] = [];
  for (let rank = 0; perFact.some(p => rank < p.steps.length); rank++)
    for (const p of perFact) if (rank < p.steps.length) out.push({ factId: p.factId, step: p.steps[rank]! });
  const cap = opts.maxPerScenario;
  if (cap !== undefined && (!Number.isInteger(cap) || cap < 0)) throw new Error(`probe maxPerScenario must be a non-negative integer, got ${cap}`);
  return cap === undefined ? out : out.slice(0, cap);
}
