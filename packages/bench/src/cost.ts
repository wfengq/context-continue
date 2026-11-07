import { defaultCountTokens } from '@context-continue/core';
import type { Model, ModelRequest } from './model.js';
import { ProbeStop } from './probe.js';
import type { ModelUsage, ProbeRecord, ToolCall } from './types.js';

/** USD per million tokens. `cacheWrite` is the 5-minute cache write (the only TTL the adapter uses). */
export interface Rates {
  input: number;
  cacheWrite: number;
  cacheRead: number;
  output: number;
}

export interface ModelPrice {
  /** Rates for a request whose prompt (uncached + cache write + cache read tokens) is at most `longPromptAbove`. */
  short: Rates;
  /** Rates above that prompt length. */
  long: Rates;
  longPromptAbove: number;
  source: string;
}

/**
 * Price table. claude-haiku-5-5 from the claude-api skill (models table cached 2026-10-06, and
 * shared/model-migration.md "Migrating to Claude Haiku 5.5"): $0.10 / $0.50 per MTok input / output
 * for prompts of 100K tokens or fewer, $0.50 / $2.50 above; cache reads 0.1x the input rate, 5-minute
 * cache writes 1.25x. Check https://platform.claude.com/docs/en/about-claude/pricing before a paid run.
 */
export const PRICES: Record<string, ModelPrice> = {
  'claude-haiku-5-5': {
    short: { input: 0.1, cacheWrite: 0.125, cacheRead: 0.01, output: 0.5 },
    long: { input: 0.5, cacheWrite: 0.625, cacheRead: 0.05, output: 2.5 },
    longPromptAbove: 100_000,
    source: 'claude-api skill (cached 2026-10-06): $0.10/$0.50 per MTok up to 100K prompt tokens, $0.50/$2.50 above; cache read 0.1x input, 5-minute cache write 1.25x input',
  },
};

export function priceFor(model: string): ModelPrice {
  const p = Object.hasOwn(PRICES, model) ? PRICES[model] : undefined;
  if (p === undefined) throw new Error(`no price for model "${model}" (known: ${Object.keys(PRICES).join(', ')}); add it to PRICES in src/cost.ts`);
  return p;
}

const ratesFor = (p: ModelPrice, promptTokens: number): Rates => (promptTokens > p.longPromptAbove ? p.long : p.short);

/** The USD cost of one request's reported usage. */
export function usageCost(p: ModelPrice, u: ModelUsage): number {
  const r = ratesFor(p, u.inputTokens + u.cacheWriteTokens + u.cacheReadTokens);
  return (u.inputTokens * r.input + u.cacheWriteTokens * r.cacheWrite + u.cacheReadTokens * r.cacheRead + u.outputTokens * r.output) / 1e6;
}

/**
 * Estimated USD cost of one probe from the bench's token counts (an approximation of the model's
 * tokenizer): `low` reads every cacheable token from the cache, `high` writes every one; the rest
 * is uncached input, and the output is `maxTokens` (its upper bound) in both.
 */
export function estimateProbeCost(p: ModelPrice, t: { inputTokens: number; cacheableTokens: number }, maxTokens: number): { low: number; high: number } {
  const r = ratesFor(p, t.inputTokens);
  const rest = (t.inputTokens - t.cacheableTokens) * r.input + maxTokens * r.output;
  return { low: (t.cacheableTokens * r.cacheRead + rest) / 1e6, high: (t.cacheableTokens * r.cacheWrite + rest) / 1e6 };
}

/** Sums the real usage a model reports and its cost. */
export class CostAccumulator {
  requests = 0;
  cost = 0;
  usage: ModelUsage = { inputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0, outputTokens: 0 };
  constructor(private readonly price: ModelPrice) {}
  add(u: ModelUsage): number {
    const c = usageCost(this.price, u);
    this.requests++;
    this.cost += c;
    this.usage = {
      inputTokens: this.usage.inputTokens + u.inputTokens,
      cacheWriteTokens: this.usage.cacheWriteTokens + u.cacheWriteTokens,
      cacheReadTokens: this.usage.cacheReadTokens + u.cacheReadTokens,
      outputTokens: this.usage.outputTokens + u.outputTokens,
    };
    return c;
  }
}

/**
 * Wraps a probe model with a budget: before each request, if the real cost so far plus the `high`
 * estimate of this request (times `margin`, for the approximate token count) would pass `maxCost`,
 * it throws ProbeStop, and from then on every call does, without reaching the model.
 */
export class CostGuardModel implements Model {
  readonly spent: CostAccumulator;
  private stopped: string | undefined;
  private readonly count: (text: string) => number;
  private readonly margin: number;

  constructor(
    private readonly inner: Model,
    private readonly price: ModelPrice,
    private readonly opts: { maxCost: number; maxTokens: number; margin?: number; count?: (text: string) => number },
  ) {
    this.spent = new CostAccumulator(price);
    this.count = opts.count ?? defaultCountTokens;
    this.margin = opts.margin ?? 1.5;
  }

  async complete(r: ModelRequest): Promise<{ reply: string; ops: ToolCall[]; usage?: ModelUsage }> {
    if (this.stopped !== undefined) throw new ProbeStop(this.stopped);
    let inputTokens = 0;
    let cacheableTokens = 0;
    for (const s of r.segments) {
      const n = this.count(s.text);
      inputTokens += n;
      if (s.cacheable) cacheableTokens += n;
    }
    const next = estimateProbeCost(this.price, { inputTokens, cacheableTokens }, this.opts.maxTokens).high * this.margin;
    if (this.spent.cost + next > this.opts.maxCost) {
      this.stopped = `--max-cost ${this.opts.maxCost} reached: spent $${this.spent.cost.toFixed(4)} on ${this.spent.requests} probes, next probe estimated at up to $${next.toFixed(4)}`;
      throw new ProbeStop(this.stopped);
    }
    const out = await this.inner.complete(r);
    if (out.usage !== undefined) this.spent.add(out.usage);
    return out;
  }
}

/** The dry-run probe model: sends nothing, answers nothing. */
export class DryRunModel implements Model {
  async complete(): Promise<{ reply: string; ops: ToolCall[] }> {
    return { reply: '', ops: [] };
  }
}

export interface ProbeEstimateRow {
  scenario: string;
  group: ProbeRecord['group'];
  probes: number;
  /** Bench token counts (defaultCountTokens), an approximation of the model's tokenizer. */
  inputTokens: number;
  cacheableTokens: number;
  /** max_tokens per probe: the output's upper bound. */
  outputTokens: number;
  costLow: number;
  costHigh: number;
}

/** The dry-run estimate: per scenario and group (in run order), and the total. */
export function estimateProbes(records: ProbeRecord[], price: ModelPrice, maxTokens: number): { rows: ProbeEstimateRow[]; total: Omit<ProbeEstimateRow, 'scenario' | 'group'> } {
  const rows: ProbeEstimateRow[] = [];
  for (const r of records) {
    if (r.error === 'not fired') continue;
    let row = rows.find(x => x.scenario === r.scenario && x.group === r.group);
    if (row === undefined) {
      row = { scenario: r.scenario, group: r.group, probes: 0, inputTokens: 0, cacheableTokens: 0, outputTokens: 0, costLow: 0, costHigh: 0 };
      rows.push(row);
    }
    const e = estimateProbeCost(price, r, maxTokens);
    row.probes++;
    row.inputTokens += r.inputTokens;
    row.cacheableTokens += r.cacheableTokens;
    row.outputTokens += maxTokens;
    row.costLow += e.low;
    row.costHigh += e.high;
  }
  const sum = (f: (x: ProbeEstimateRow) => number) => rows.reduce((n, x) => n + f(x), 0);
  return {
    rows,
    total: {
      probes: sum(x => x.probes), inputTokens: sum(x => x.inputTokens), cacheableTokens: sum(x => x.cacheableTokens),
      outputTokens: sum(x => x.outputTokens), costLow: sum(x => x.costLow), costHigh: sum(x => x.costHigh),
    },
  };
}
