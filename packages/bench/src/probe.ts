import type { FactProbe, ProbeRecord, ProbeVerdict, Scenario, Step } from './types.js';

/**
 * Thrown by the probe model (or `onProbe`) to stop probing for the rest of the run, e.g. when a cost
 * budget is reached. The probe that threw it is not recorded; the scripted run continues unchanged.
 */
export class ProbeStop extends Error {
  constructor(message = 'probing stopped') {
    super(message);
    this.name = 'ProbeStop';
  }
}

/** Which opportunities of a fact are probed: first / middle / last, every one, or n evenly spaced ones. */
export type ProbeSamples = 'fml' | 'all' | number;

export interface ProbeOptions {
  /** Default 'fml'. */
  samples?: ProbeSamples;
  /** At most this many probes per scenario (default no cap); see `scheduleProbes` for which are kept. */
  maxPerScenario?: number;
}

/** What `runScenario` takes to probe: the scheduling options, the probe model, and an optional sink. */
export interface ProbeRunOptions extends ProbeOptions {
  model: import('./model.js').Model;
  /** Called with each probe record as soon as it exists (errors and "not fired" records included). */
  onProbe?: (rec: ProbeRecord) => void | Promise<void>;
}

const MAX_ERROR_LENGTH = 200;

/**
 * A probe error's message for the record: the Error's message only (never its request, headers or
 * cause), with key-like tokens masked, one line, at most 200 characters.
 */
export function probeErrorMessage(e: unknown): string {
  const raw = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
  const masked = raw
    // Header / key-value secrets, with an optional auth scheme word: `Authorization: Bearer x`, {"x-api-key":"y"}.
    .replace(/((?:proxy-)?authorization|x-api-key|api[_-]?key|access[_-]?token|secret)(["']?\s*[:=]\s*["']?)(?:(?:bearer|basic|token)\s+)?[^\s"',}]+/gi, '$1$2***')
    // A scheme word followed by a credential anywhere: `bearer ghp_…`, `Basic dXNl…`.
    .replace(/\b(bearer|basic|token)\s+[^\s"',}]+/gi, '$1 ***')
    // URL query parameters that carry keys: `?key=…`, `&api_key=…`, `?access_token=…`.
    .replace(/([?&](?:key|api[_-]?key|access[_-]?token|token)=)[^&#\s"']+/gi, '$1***')
    // JWTs: three base64url parts joined by dots, the first a base64 JSON header ("eyJ"); host names stay.
    .replace(/\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}/g, '***')
    // Well-known key prefixes.
    .replace(/\bsk-[A-Za-z0-9_-]+/g, 'sk-***')
    .replace(/\b(gh[pousr]_)[A-Za-z0-9]+/g, '$1***')
    .replace(/\s+/g, ' ')
    .trim();
  return masked.length > MAX_ERROR_LENGTH ? `${masked.slice(0, MAX_ERROR_LENGTH - 1)}…` : masked;
}

/** The final, uncached segment a probe request appends to the scripted request's segments. */
export function probeQuestion(question: string): string {
  return `Question: ${question}\nAnswer briefly.`;
}

/** Lower case, "×" as "x", no spaces around an "x" between digits ("12 x 12" → "12x12"), whitespace runs as one space, trimmed. */
export function normaliseAnswer(text: string): string {
  return text.toLowerCase().replace(/×/g, 'x').replace(/(\d)\s*x\s*(?=\d)/g, '$1x').replace(/\s+/g, ' ').trim();
}

const ALNUM = /[\p{L}\p{N}]/u;
/** Scripts written without spaces between words: a neighbour from these never breaks a boundary. */
const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
/** A neighbouring character that joins a term to a longer word (letters and digits, except CJK). */
const joins = (c: string | undefined): boolean => c !== undefined && ALNUM.test(c) && !CJK.test(c);

/**
 * True when normalised `term` occurs in normalised `text` with a boundary at each alphanumeric edge:
 * the character before / after the occurrence must not be a letter or digit ("12x12" is not in
 * "112x120", "eu-central-1" is not in "eu-central-10"), except Han / Kana / Hangul, which have no
 * spaces ("北京" is in "北京市").
 */
export function containsTerm(text: string, term: string): boolean {
  const t = normaliseAnswer(text);
  const n = normaliseAnswer(term);
  if (n.length === 0) return false;
  const startEdge = ALNUM.test(n[0]!);
  const endEdge = ALNUM.test(n[n.length - 1]!);
  for (let i = t.indexOf(n); i !== -1; i = t.indexOf(n, i + 1)) {
    const before = t[i - 1];
    const after = t[i + n.length];
    if (startEdge && joins(before)) continue;
    if (endEdge && joins(after)) continue;
    return true;
  }
  return false;
}

/**
 * String grading (no model): a `reject` hit is 'stale' (it wins over an `expect` hit), else an
 * `expect` hit is 'correct', else 'wrong'. Matching is `containsTerm` on normalised text.
 */
export function gradeAnswer(probe: FactProbe, answer: string): ProbeVerdict {
  if ((probe.reject ?? []).some(r => containsTerm(answer, r))) return 'stale';
  if (probe.expect.some(e => containsTerm(answer, e))) return 'correct';
  return 'wrong';
}

function checkProbeOptions(opts: ProbeOptions): void {
  const { samples, maxPerScenario: cap } = opts;
  if (samples !== undefined && samples !== 'fml' && samples !== 'all' && !(Number.isInteger(samples) && samples >= 1))
    throw new Error(`probe samples must be 'fml', 'all' or a positive integer, got ${String(samples)}`);
  if (cap !== undefined && !(Number.isInteger(cap) && cap >= 0)) throw new Error(`probe maxPerScenario must be a non-negative integer, got ${String(cap)}`);
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
  checkProbeOptions(opts);
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
  return cap === undefined ? out : out.slice(0, cap);
}
