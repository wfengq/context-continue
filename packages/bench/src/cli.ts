import { appendFileSync, existsSync, mkdirSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_STREAM_OPTIONS, type PublicBoardSwitches } from '@context-continue/core';
import { CostGuardModel, customPrice, DryRunModel, estimateProbes, estimateReplay, priceFor, usageCost, type ModelPrice } from './cost.js';
import { computeMetrics, type GroupMetrics } from './metrics.js';
import type { Model } from './model.js';
import { AnthropicModel, DEFAULT_MAX_TOKENS, resolveApiKey } from './models/anthropic.js';
import { baseUrlHost, DEFAULT_API_KEY_ENV, OpenAIModel, type ThinkingMode } from './models/openai.js';
import { createPolicy } from './policies/index.js';
import { runControl, type ProbeSamples } from './probe.js';
import { renderProbeEstimate, renderReplayEstimate, renderReport, writeResults, type ProbeSection, type ReplayGroupRow, type ReplaySection } from './report.js';
import { DEFAULT_RESTREAM_TOKENS } from './policies/stream.js';
import { REPLAY_MAX_TOKENS, runScenario } from './runner.js';
import { loadScenario } from './scenario.js';
import type { CallRecord, Group, ModelUsage, ProbeRecord, ReplayRecord, Scenario } from './types.js';

/** The standard scenarios (20–40 steps), in report order. */
export const STANDARD_IDS = ['product-plan', 'flappy-bird', 'event-plan'] as const;
/** The long scenarios (tier long, 150–300 steps), in report order. */
export const LONG_IDS = ['long-app', 'long-event'] as const;
/** The extra-long scenarios (tier xlong, 1,000–1,500 steps), in report order. */
export const XLONG_IDS = ['xlong-product'] as const;
/** Every formal scenario, in report order: the standard ones, then the long ones, then the xlong ones. */
export const SCENARIO_IDS = [...STANDARD_IDS, ...LONG_IDS, ...XLONG_IDS] as const;

/** `--scenario` names that stand for a set of scenarios. */
const SCENARIO_SETS: Record<string, readonly string[]> = { all: SCENARIO_IDS, standard: STANDARD_IDS, long: LONG_IDS, xlong: XLONG_IDS };
const GROUPS: Group[] = ['A', 'B', 'C', 'D', 'E', 'F'];

/** `scenarios/` at the package root; the module sits one level below it in both `src/` and `dist/`. */
const SCENARIO_DIR = fileURLToPath(new URL('../scenarios/', import.meta.url));

const USAGE =
  'Usage: bench run --scenario <id|path.json|standard|long|xlong|all> --group <A..F|all|A,C,D,E> [--window 128000] [--compact-ratio 0.8] ' +
  '[--summary-tokens 1500] [--cache-ratio 0.1] [--c-public default|none|all|directives,contracts,failures] ' +
  '[--c-stream off|on|core|auto] [--restream-tokens 8000] [--c-stream-own off|on] [--auto-after <n>] [--out results] [--stamp <s>] ' +
  '[--probes] [--replay] (either one: [--dry-run] [--max-cost <usd>] [--provider anthropic|openai] [--model claude-haiku-5-5] [--base-url <url>] [--api-key-env <NAME>] [--price <input>,<cacheRead>,<output>] [--thinking disabled|omit]) ' +
  '(--probes only: [--probe-groups A,C,D,E] [--probe-samples fml|all|<n>] [--max-probes <n>] [--no-probe-control])';

/** The fact-probe options (spec 2026-11-07-real-model-probes); present only with --probes. */
interface ProbeOpts {
  groups: Group[];
  /** Groups named in --probe-groups that this run does not include. */
  dropped: Group[];
  samples: ProbeSamples;
  maxPerScenario: number | undefined;
  /** Also ask each probed fact once with no project context (group "none"); on unless --no-probe-control. */
  control: boolean;
}

/** Real-model settings, shared by --probes and --replay (spec 2026-11-07-real-model-replay); absent with neither. */
interface RealArgs {
  provider: 'anthropic' | 'openai';
  /** --provider openai only: the server's base URL (used for requests, never recorded) and its host. */
  baseUrl: string | undefined;
  baseUrlHost: string | undefined;
  /** --provider openai only: the environment variable holding the key. */
  apiKeyEnv: string;
  /** --provider openai only (default disabled): whether the request carries `thinking: {type: "disabled"}`. */
  thinking: ThinkingMode;
  model: string;
  price: ModelPrice;
  dryRun: boolean;
  /** Required for a real run. */
  maxCost: number | undefined;
  /** Also send every request of every selected group to the model (output capped at REPLAY_MAX_TOKENS). */
  replay: boolean;
  probe: ProbeOpts | undefined;
}

const DEFAULT_PROBE_GROUPS: Group[] = ['A', 'C', 'D', 'E'];
/** Usable with --probes or --replay. */
const REAL_FLAGS = ['--dry-run', '--max-cost', '--provider', '--model', '--base-url', '--api-key-env', '--price', '--thinking'];
/** Usable with --probes only. */
const PROBE_ONLY_FLAGS = ['--probe-groups', '--probe-samples', '--max-probes', '--no-probe-control'];
const BOOLEAN_FLAGS = ['--probes', '--replay', '--dry-run', '--no-probe-control'];

/** What main uses from the outside world for probes; tests inject a fake fetch and environment. */
export interface MainDeps {
  fetch?: typeof fetch;
  env?: Record<string, string | undefined>;
  sleep?: (ms: number) => Promise<void>;
}

interface Args {
  scenario: string;
  group: string;
  /** The groups this run covers, in A..F order. */
  groups: Group[];
  window: number;
  compactRatio: number;
  summaryTokens: number;
  cacheRatio: number;
  cPublic: CPublic;
  cStream: CStream;
  out: string;
  stamp: string | undefined;
  real: RealArgs | undefined;
}

class UsageError extends Error {}

const PUBLIC_SECTIONS = ['contracts', 'directives', 'failures'] as const;
interface CPublic {
  /** `default`, `none`, `all`, or the chosen section names in name order. */
  canonical: string;
  switches: PublicBoardSwitches | undefined;
}

/**
 * `default` (pass no publicBoard: whatever the core defaults to), `none`, `all`, or a comma list of
 * distinct section names; anything else is a usage error. Everything but `default` passes all three
 * switches explicitly, so a subset never inherits the core default.
 */
function parseCPublic(raw: string): CPublic {
  if (raw === 'default') return { canonical: 'default', switches: undefined };
  if (raw === 'none') return { canonical: 'none', switches: { directives: false, contracts: false, failures: false } };
  const names = raw === 'all' ? [...PUBLIC_SECTIONS] : raw.split(',');
  const bad = names.find(n => !(PUBLIC_SECTIONS as readonly string[]).includes(n));
  if (bad !== undefined) throw new UsageError(`--c-public: unknown section "${bad}" in "${raw}" (use default, none, all, or a list of ${PUBLIC_SECTIONS.join(', ')})`);
  if (new Set(names).size !== names.length) throw new UsageError(`--c-public: a section is repeated in "${raw}"`);
  const sorted = [...names].sort();
  return {
    canonical: sorted.length === PUBLIC_SECTIONS.length ? 'all' : sorted.join(','),
    switches: Object.fromEntries(PUBLIC_SECTIONS.map(n => [n, sorted.includes(n)])) as PublicBoardSwitches,
  };
}

/**
 * Group C's request text: off (default, the plain core methods); `on`, the bench's stream prototype,
 * with its restream budget, `own` (recorded only when on) being the `--c-stream-own on` measurement
 * variant that also appends each bot's own outputs; `core`, the core library's stream mode (always
 * given the bot's own outputs); `auto`, the core's auto mode with its ledger-size threshold.
 */
type CStream =
  | { mode: 'off' }
  | { mode: 'on'; restreamTokens: number; own?: true }
  | { mode: 'core'; restreamTokens: number }
  | { mode: 'auto'; restreamTokens: number; autoAfterEntries: number };

const STREAM_MODES = ['off', 'on', 'core', 'auto'] as const;

function cStreamLine(c: CStream): string {
  switch (c.mode) {
    case 'off':
      return 'off';
    case 'on':
      return `on (restreamTokens ${c.restreamTokens}${c.own ? ', own outputs' : ''})`;
    case 'core':
      return `core (restreamTokens ${c.restreamTokens})`;
    case 'auto':
      return `auto (restreamTokens ${c.restreamTokens}, autoAfterEntries ${c.autoAfterEntries})`;
  }
}

/** The policy options a `--c-stream` setting passes to group C. */
function streamOpts(c: CStream) {
  switch (c.mode) {
    case 'off':
      return {};
    case 'on':
      return { stream: { restreamTokens: c.restreamTokens, ...(c.own ? { own: true } : {}) } };
    case 'core':
      return { coreStream: { mode: 'on' as const, restreamTokens: c.restreamTokens } };
    case 'auto':
      return { coreStream: { mode: 'auto' as const, restreamTokens: c.restreamTokens, autoAfterEntries: c.autoAfterEntries } };
  }
}

/** A scenario id names `scenarios/<id>.json`; anything ending in `.json` is a path (relative to cwd). */
export function scenarioPath(idOrPath: string): string {
  return idOrPath.endsWith('.json') ? resolve(idOrPath) : join(SCENARIO_DIR, `${idOrPath}.json`);
}

/** UTC `YYYYMMDDTHHmmssZ`; used only as the result directory name. */
function timestamp(d: Date): string {
  return d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

function number(flag: string, raw: string, ok: (n: number) => boolean, what: string): number {
  const n = Number(raw);
  if (raw.trim() === '' || !Number.isFinite(n) || !ok(n)) throw new UsageError(`${flag} must be ${what}, got "${raw}"`);
  return n;
}

/** `--group`: `all`, one group, or a comma list of distinct groups (any order); the result is in A..F order. */
function parseGroups(raw: string): Group[] {
  if (raw === 'all') return [...GROUPS];
  const names = raw.split(',');
  const bad = names.find(n => !GROUPS.includes(n as Group));
  if (bad !== undefined) throw new UsageError(`unknown group "${bad}" in "${raw}" (use A..F, a comma list such as A,C,D,E, or all)`);
  if (new Set(names).size !== names.length) throw new UsageError(`--group: a group is repeated in "${raw}"`);
  return GROUPS.filter(g => names.includes(g));
}

function parseArgs(argv: string[]): Args {
  const [command, ...rest] = argv;
  if (command !== 'run') throw new UsageError(command === undefined ? 'missing command' : `unknown command "${command}"`);
  const seen = new Map<string, string>();
  for (let i = 0; i < rest.length; ) {
    const flag = rest[i]!;
    if (!flag.startsWith('--')) throw new UsageError(`unexpected argument "${flag}"`);
    if (BOOLEAN_FLAGS.includes(flag)) {
      if (seen.has(flag)) throw new UsageError(`${flag} is given more than once`);
      seen.set(flag, '');
      i += 1;
      continue;
    }
    const value = rest[i + 1];
    if (value === undefined || value.startsWith('--')) throw new UsageError(`${flag} needs a value`);
    if (seen.has(flag)) throw new UsageError(`${flag} is given more than once`);
    seen.set(flag, value);
    i += 2;
  }
  const known = ['--scenario', '--group', '--window', '--compact-ratio', '--summary-tokens', '--cache-ratio', '--c-public', '--c-stream', '--restream-tokens', '--c-stream-own', '--auto-after', '--out', '--stamp', '--probes', '--replay', ...REAL_FLAGS, ...PROBE_ONLY_FLAGS];
  for (const flag of seen.keys()) if (!known.includes(flag)) throw new UsageError(`unknown flag ${flag}`);
  const scenario = seen.get('--scenario');
  const group = seen.get('--group');
  if (scenario === undefined) throw new UsageError('--scenario is required');
  if (group === undefined) throw new UsageError('--group is required');
  const runGroups = parseGroups(group);
  const stamp = seen.get('--stamp');
  // A plain name: no separators, and not "." or ".." (or only dots), which would leave --out.
  if (stamp !== undefined && (!/^[\w.-]+$/.test(stamp) || /^\.+$/.test(stamp))) {
    throw new UsageError(`--stamp must be a plain directory name, got "${stamp}"`);
  }
  const int = (n: number) => Number.isInteger(n) && n > 0;
  const streamMode = seen.get('--c-stream') ?? 'off';
  if (!(STREAM_MODES as readonly string[]).includes(streamMode)) throw new UsageError(`--c-stream must be off, on, core or auto, got "${streamMode}"`);
  const restream = seen.get('--restream-tokens');
  if (restream !== undefined && streamMode === 'off') throw new UsageError('--restream-tokens needs --c-stream on, core or auto');
  const own = seen.get('--c-stream-own');
  if (own !== undefined && streamMode !== 'on') throw new UsageError('--c-stream-own needs --c-stream on (core and auto always carry own outputs)');
  if (own !== undefined && own !== 'off' && own !== 'on') throw new UsageError(`--c-stream-own must be off or on, got "${own}"`);
  const autoAfter = seen.get('--auto-after');
  if (autoAfter !== undefined && streamMode !== 'auto') throw new UsageError('--auto-after needs --c-stream auto');
  const restreamTokens = () =>
    number('--restream-tokens', restream ?? String(streamMode === 'on' ? DEFAULT_RESTREAM_TOKENS : DEFAULT_STREAM_OPTIONS.restreamTokens), int, 'a positive integer');
  const cStream: CStream =
    streamMode === 'off'
      ? { mode: 'off' }
      : streamMode === 'on'
        ? { mode: 'on', restreamTokens: restreamTokens(), ...(own === 'on' ? { own: true as const } : {}) }
        : streamMode === 'core'
          ? { mode: 'core', restreamTokens: restreamTokens() }
          : {
              mode: 'auto',
              restreamTokens: restreamTokens(),
              autoAfterEntries: number('--auto-after', autoAfter ?? String(DEFAULT_STREAM_OPTIONS.autoAfterEntries), int, 'a positive integer'),
            };
  return {
    scenario,
    group: runGroups.length === GROUPS.length ? 'all' : runGroups.join(','),
    groups: runGroups,
    window: number('--window', seen.get('--window') ?? '128000', int, 'a positive integer'),
    compactRatio: number('--compact-ratio', seen.get('--compact-ratio') ?? '0.8', n => n > 0 && n <= 1, 'a number in (0, 1]'),
    summaryTokens: number('--summary-tokens', seen.get('--summary-tokens') ?? '1500', int, 'a positive integer'),
    cacheRatio: number('--cache-ratio', seen.get('--cache-ratio') ?? '0.1', n => n >= 0 && n <= 1, 'a number in [0, 1]'),
    cPublic: parseCPublic(seen.get('--c-public') ?? 'default'),
    cStream,
    out: seen.get('--out') ?? 'results',
    stamp,
    real: parseRealArgs(seen, runGroups),
  };
}

function parseRealArgs(seen: Map<string, string>, runGroups: Group[]): RealArgs | undefined {
  const probes = seen.has('--probes');
  const replay = seen.has('--replay');
  const strayProbe = PROBE_ONLY_FLAGS.find(f => seen.has(f));
  if (!probes && strayProbe !== undefined) throw new UsageError(`${strayProbe} needs --probes`);
  if (!probes && !replay) {
    const stray = REAL_FLAGS.find(f => seen.has(f));
    if (stray !== undefined) throw new UsageError(`${stray} needs --probes or --replay`);
    return undefined;
  }
  const provider = seen.get('--provider') ?? 'anthropic';
  if (provider !== 'anthropic' && provider !== 'openai') throw new UsageError(`--provider must be anthropic or openai, got "${provider}"`);
  const rawThinking = seen.get('--thinking') ?? 'disabled';
  if (rawThinking !== 'disabled' && rawThinking !== 'omit') throw new UsageError(`--thinking must be disabled or omit, got "${rawThinking}"`);
  if (provider !== 'openai' && seen.has('--thinking')) throw new UsageError('--thinking needs --provider openai');
  const thinking: ThinkingMode = rawThinking;
  let model: string;
  let price: ModelPrice;
  let baseUrl: string | undefined;
  let host: string | undefined;
  if (provider === 'anthropic') {
    for (const f of ['--price', '--base-url', '--api-key-env']) if (seen.has(f)) throw new UsageError(`${f} needs --provider openai`);
    model = seen.get('--model') ?? 'claude-haiku-5-5';
    try {
      price = priceFor(model);
    } catch (e) {
      throw new UsageError(`--model: ${(e as Error).message}`);
    }
  } else {
    for (const f of ['--base-url', '--model', '--price']) if (!seen.has(f)) throw new UsageError(`--provider openai needs ${f}`);
    model = seen.get('--model')!;
    baseUrl = seen.get('--base-url')!;
    try {
      host = baseUrlHost(baseUrl);
    } catch (e) {
      throw new UsageError(`--base-url: ${(e as Error).message}`);
    }
    const rawPrice = seen.get('--price')!;
    const parts = rawPrice.split(',');
    const nums = parts.map(x => Number(x));
    if (parts.length !== 3 || parts.some(x => !/^\d+(\.\d+)?$/.test(x))) {
      throw new UsageError(`--price must be three non-negative numbers <input>,<cache-hit>,<output> (USD per million tokens), got "${rawPrice}"`);
    }
    price = customPrice(nums[0]!, nums[1]!, nums[2]!);
  }
  const apiKeyEnv = seen.get('--api-key-env') ?? DEFAULT_API_KEY_ENV;
  let probe: ProbeOpts | undefined;
  if (probes) {
    const rawGroups = seen.get('--probe-groups');
    const groups = rawGroups === undefined ? DEFAULT_PROBE_GROUPS : (rawGroups.split(',') as Group[]);
    const badGroup = groups.find(g => !GROUPS.includes(g));
    if (badGroup !== undefined) throw new UsageError(`--probe-groups: unknown group "${badGroup}" in "${rawGroups}" (use a comma list of A..F)`);
    if (new Set(groups).size !== groups.length) throw new UsageError(`--probe-groups: a group is repeated in "${rawGroups}"`);
    const probed = GROUPS.filter(g => groups.includes(g) && runGroups.includes(g));
    if (probed.length === 0) throw new UsageError(`--probe-groups ${groups.join(',')}: none of these groups is in this run (--group ${runGroups.length === GROUPS.length ? 'all' : runGroups.join(',')})`);
    const rawSamples = seen.get('--probe-samples') ?? 'fml';
    const samples: ProbeSamples =
      rawSamples === 'fml' || rawSamples === 'all'
        ? rawSamples
        : number('--probe-samples', rawSamples, n => Number.isInteger(n) && n > 0, 'fml, all or a positive integer');
    const rawMax = seen.get('--max-probes');
    const maxPerScenario = rawMax === undefined ? undefined : number('--max-probes', rawMax, n => Number.isInteger(n) && n >= 0, 'a non-negative integer');
    probe = { groups: probed, dropped: groups.filter(g => !runGroups.includes(g)), samples, maxPerScenario, control: !seen.has('--no-probe-control') };
  }
  const dryRun = seen.has('--dry-run');
  const rawCost = seen.get('--max-cost');
  const maxCost = rawCost === undefined ? undefined : number('--max-cost', rawCost, n => n > 0, 'a positive number of US dollars');
  if (!dryRun && maxCost === undefined) throw new UsageError(`${probes ? '--probes' : '--replay'} sends paid requests: give --max-cost <usd> (or --dry-run for an estimate)`);
  return { provider, thinking, baseUrl, baseUrlHost: host, apiKeyEnv, model, price, dryRun, maxCost, replay, probe };
}

/** Runs the bench; returns the process exit code. Errors go to stderr. */
export async function main(argv: string[], deps: MainDeps = {}): Promise<number> {
  let args: Args;
  try {
    args = parseArgs(argv);
  } catch (e) {
    if (!(e instanceof UsageError)) throw e;
    process.stderr.write(`bench: ${e.message}\n${USAGE}\n`);
    return 2;
  }

  // Load and validate every scenario before running anything.
  const ids = Object.hasOwn(SCENARIO_SETS, args.scenario) ? [...SCENARIO_SETS[args.scenario]!] : [args.scenario];
  // A named set with no scenarios would write an empty report: a usage error.
  if (ids.length === 0) {
    process.stderr.write(`bench: --scenario ${args.scenario}: the "${args.scenario}" set has no scenarios yet\n${USAGE}\n`);
    return 2;
  }
  const scenarios: Scenario[] = [];
  for (const id of ids) {
    try {
      scenarios.push(loadScenario(scenarioPath(id)));
    } catch (e) {
      process.stderr.write(`bench: scenario "${id}": ${(e as Error).message}\n`);
      return 1;
    }
  }

  const groups = args.groups;
  const dir = join(args.out, args.stamp ?? timestamp(new Date()));

  // Real-model requests (probes and/or replay): a dry run sends nothing; a real run needs the key (from the environment only) and a budget.
  const ra = args.real;
  const pa = ra?.probe;
  if (pa !== undefined && pa.dropped.length > 0) {
    process.stderr.write(`bench: note: --probe-groups: ${pa.dropped.join(', ')} not in this run (--group ${args.group}); probing ${pa.groups.join(', ')}\n`);
  }
  if (pa !== undefined && !scenarios.some(s => (s.facts ?? []).some(f => f.probe !== undefined))) {
    process.stderr.write('bench: note: --probes: no fact in these scenarios has a probe; nothing will be probed\n');
  }
  const realRun = ra !== undefined && !ra.dryRun;
  const dryReplay = ra !== undefined && ra.dryRun && ra.replay;
  let probeModel: Model | undefined;
  let guard: CostGuardModel | undefined;
  if (ra !== undefined) {
    if (ra.dryRun) probeModel = new DryRunModel();
    else {
      // The jsonl files hold paid-for answers: never truncate them, and refuse before any request is sent.
      for (const f of [...(pa !== undefined ? ['probes.jsonl'] : []), ...(ra.replay ? ['replay.jsonl'] : [])]) {
        const path = join(dir, f);
        if (existsSync(path) && statSync(path).size > 0) {
          process.stderr.write(`bench: ${path} already exists and is not empty (paid results from an earlier run); choose a new --stamp\n`);
          return 2;
        }
      }
      const injected = {
        ...(deps.fetch === undefined ? {} : { fetch: deps.fetch }), ...(deps.sleep === undefined ? {} : { sleep: deps.sleep }),
      };
      let real: Model;
      if (ra.provider === 'openai') {
        const raw = (deps.env ?? process.env)[ra.apiKeyEnv];
        const key = raw === undefined || raw.trim() === '' ? undefined : raw;
        if (key === undefined) process.stderr.write(`bench: note: ${ra.apiKeyEnv} is not set; sending no Authorization header\n`);
        real = new OpenAIModel({ model: ra.model, baseUrl: ra.baseUrl!, ...(key === undefined ? {} : { apiKey: key }), maxTokens: DEFAULT_MAX_TOKENS, thinking: ra.thinking, ...injected });
      } else {
        let key: string;
        try {
          key = resolveApiKey(deps.env ?? process.env).key;
        } catch (e) {
          process.stderr.write(`bench: ${(e as Error).message}\n`);
          return 2;
        }
        real = new AnthropicModel({ model: ra.model, apiKey: key, maxTokens: DEFAULT_MAX_TOKENS, ...injected });
      }
      // One guard for probes and replay: its budget and its stop cover every real-model request.
      guard = new CostGuardModel(real, ra.price, { maxCost: ra.maxCost!, maxTokens: DEFAULT_MAX_TOKENS });
      probeModel = guard;
      // Each finished probe or replayed request is appended at once, so an interrupted paid run keeps what it bought.
      mkdirSync(dir, { recursive: true });
      if (pa !== undefined) writeFileSync(join(dir, 'probes.jsonl'), '');
      if (ra.replay) writeFileSync(join(dir, 'replay.jsonl'), '');
    }
  }
  const probeRecords: ProbeRecord[] = [];
  const stopped: { scenario: string; group: Group | 'none'; reason: string }[] = [];
  const replayRows: ReplayGroupRow[] = [];
  const replayUsage = (recs: { usage?: ModelUsage }[]): ModelUsage =>
    recs.reduce<ModelUsage>((a, r) => (r.usage === undefined ? a : {
      inputTokens: a.inputTokens + r.usage.inputTokens, cacheWriteTokens: a.cacheWriteTokens + r.usage.cacheWriteTokens,
      cacheReadTokens: a.cacheReadTokens + r.usage.cacheReadTokens, outputTokens: a.outputTokens + r.usage.outputTokens,
    }), { inputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0, outputTokens: 0 });
  const opts = {
    window: args.window,
    compactRatio: args.compactRatio,
    summaryTokens: args.summaryTokens,
    ...(args.cPublic.switches === undefined ? {} : { publicBoard: args.cPublic.switches }),
    ...streamOpts(args.cStream),
  };
  const records: CallRecord[] = [];
  const metrics: GroupMetrics[] = [];
  for (const s of scenarios) {
    if (pa !== undefined && pa.control) {
      // The no-context control: each fact the sampling would probe, asked once with only the question.
      const c = await runControl(s, {
        model: probeModel!, samples: pa.samples,
        ...(pa.maxPerScenario === undefined ? {} : { maxPerScenario: pa.maxPerScenario }),
        ...(ra!.dryRun ? {} : { onProbe: (rec: ProbeRecord) => appendFileSync(join(dir, 'probes.jsonl'), JSON.stringify(rec) + '\n') }),
      });
      probeRecords.push(...c.records);
      if (c.stopped !== undefined) stopped.push({ scenario: s.id, group: 'none', reason: c.stopped });
    }
    for (const g of groups) {
      const probe =
        pa !== undefined && pa.groups.includes(g)
          ? {
              model: probeModel!, samples: pa.samples,
              ...(pa.maxPerScenario === undefined ? {} : { maxPerScenario: pa.maxPerScenario }),
              ...(ra!.dryRun ? {} : { onProbe: (rec: ProbeRecord) => appendFileSync(join(dir, 'probes.jsonl'), JSON.stringify(rec) + '\n') }),
            }
          : undefined;
      const replay =
        realRun && ra.replay
          ? { model: guard!, onReplay: (rec: ReplayRecord) => appendFileSync(join(dir, 'replay.jsonl'), JSON.stringify(rec) + '\n') }
          : undefined;
      const run = await runScenario(s, createPolicy(g, opts), { ...(probe === undefined ? {} : { probe }), ...(replay === undefined ? {} : { replay }) });
      probeRecords.push(...(run.probes ?? []));
      // probeStopped is also set when a replay request stopped the real model; realStopped is the one to report with --replay.
      const stop = ra?.replay ? run.realStopped : run.probeStopped;
      if (stop !== undefined) stopped.push({ scenario: s.id, group: g, reason: stop });
      records.push(...run.records);
      const m = computeMetrics(g, s.id, run.records, run.stats, args.cacheRatio, s.tier ?? 'standard', (s.facts ?? []).map(f => f.id));
      metrics.push(m);
      if (run.replay !== undefined) {
        const usage = replayUsage(run.replay);
        const prompt = usage.inputTokens + usage.cacheWriteTokens + usage.cacheReadTokens;
        replayRows.push({
          scenario: s.id, group: g, requests: run.replay.length, errors: run.replay.filter(r => r.error !== undefined).length,
          errorsNoUsage: run.replay.filter(r => r.error !== undefined && r.usage === undefined).length, usage,
          cost: run.replay.reduce((n, r) => (r.usage === undefined ? n : n + usageCost(ra!.price, r.usage)), 0),
          realCacheReadPct: prompt === 0 ? null : (usage.cacheReadTokens / prompt) * 100,
          estCacheablePct: m.inputTokens === 0 ? null : (m.cacheableTokens / m.inputTokens) * 100,
          estCostUnits: m.costUnits, estInputTokens: m.inputTokens, estCacheableTokens: m.cacheableTokens,
          // A group is complete only if every one of its requests was replayed and real-model requests were never stopped in it.
          complete: run.realStopped === undefined && run.replay.length === run.records.length,
        });
      }
    }
  }

  const params = { cacheRatio: args.cacheRatio, compactRatio: args.compactRatio, summaryTokens: args.summaryTokens, window: args.window };
  const tiers = Object.fromEntries(scenarios.map(s => [s.id, s.tier ?? 'standard'] as const));
  const replayTotal = replayUsage(replayRows);
  const replayCost = replayRows.reduce((n, r) => n + r.cost, 0);
  const section: ProbeSection | undefined =
    pa !== undefined && !ra!.dryRun
      ? {
          model: ra!.model, ...(ra!.provider === 'openai' ? { provider: 'openai' as const, baseUrlHost: ra!.baseUrlHost! } : {}), maxTokens: DEFAULT_MAX_TOKENS,
          thinking: ra!.provider === 'openai' && ra!.thinking === 'omit' ? ('not sent' as const) : ('disabled' as const), temperature: ra!.provider === 'openai' ? '0' : 'not sent (model default)', samples: pa.samples,
          ...(pa.maxPerScenario === undefined ? {} : { maxPerScenario: pa.maxPerScenario }),
          // With --replay the guard also paid for the replay requests: the probe totals come from the probe records alone.
          groups: pa.groups, control: pa.control, maxCost: ra!.maxCost!, price: ra!.price,
          usage: ra!.replay ? replayUsage(probeRecords) : guard!.spent.usage,
          cost: ra!.replay ? probeRecords.reduce((n, r) => (r.usage === undefined ? n : n + usageCost(ra!.price, r.usage)), 0) : guard!.spent.cost,
          ...(ra!.replay ? { sharedBudget: true as const } : {}), stopped, records: probeRecords,
        }
      : undefined;
  const replaySection: ReplaySection | undefined =
    realRun && ra.replay
      ? {
          model: ra.model, ...(ra.provider === 'openai' ? { provider: 'openai' as const, baseUrlHost: ra.baseUrlHost! } : {}), maxTokens: REPLAY_MAX_TOKENS,
          price: ra.price, cacheRatio: args.cacheRatio, maxCost: ra.maxCost!, cost: replayCost, usage: replayTotal, ...(pa === undefined ? {} : { sharedBudget: true as const }),
          ...(stopped.some(x => x.group !== 'none') ? { stopped: stopped.filter((x): x is { scenario: string; group: Group; reason: string } => x.group !== 'none') } : {}),
          groups: replayRows,
        }
      : undefined;
  const report = renderReport(metrics, {
    scenarios: scenarios.map(s => s.id), params, cPublic: args.cPublic.canonical, cStream: cStreamLine(args.cStream), dsbotRef: 'f823773', tiers,
    ...(section === undefined ? {} : { probes: section }), ...(replaySection === undefined ? {} : { replay: replaySection }),
  });
  writeResults(dir, { records, metrics, params, cPublic: args.cPublic.canonical, cStream: args.cStream, ...(section === undefined ? {} : { probes: section }), ...(replaySection === undefined ? {} : { replay: replaySection }) }, report);
  process.stdout.write(`bench: wrote ${join(dir, 'results.json')} and ${join(dir, 'report.md')}\n`);
  if (ra !== undefined && ra.dryRun) {
    const base = { model: ra.model, ...(ra.provider === 'openai' ? { provider: 'openai' as const, baseUrlHost: ra.baseUrlHost! } : {}), maxTokens: DEFAULT_MAX_TOKENS };
    let probeEst: { total: { costLow: number; costHigh: number } } | undefined;
    if (pa !== undefined) {
      const est = estimateProbes(probeRecords, ra.price, DEFAULT_MAX_TOKENS);
      const meta = { ...base, samples: pa.samples, groups: [...pa.groups, ...(pa.control ? ['none' as const] : [])], maxCost: ra.maxCost ?? null, ...(pa.maxPerScenario === undefined ? {} : { maxPerScenario: pa.maxPerScenario }) };
      probeEst = est;
      const md = renderProbeEstimate(est, meta, tiers);
      writeFileSync(join(dir, 'probe-estimate.json'), JSON.stringify({ ...meta, price: ra.price, ...est }, null, 2) + '\n');
      writeFileSync(join(dir, 'probe-estimate.md'), md);
      process.stdout.write(md);
      process.stdout.write(`bench: wrote ${join(dir, 'probe-estimate.json')} and ${join(dir, 'probe-estimate.md')}\n`);
    }
    if (dryReplay) {
      const est = estimateReplay(records, ra.price, REPLAY_MAX_TOKENS);
      const meta = { ...base, maxTokens: REPLAY_MAX_TOKENS, maxCost: ra.maxCost ?? null };
      const md = renderReplayEstimate(est, meta, tiers);
      writeFileSync(join(dir, 'replay-estimate.json'), JSON.stringify({ ...meta, price: ra.price, ...est }, null, 2) + '\n');
      writeFileSync(join(dir, 'replay-estimate.md'), md);
      process.stdout.write(md);
      process.stdout.write(`bench: wrote ${join(dir, 'replay-estimate.json')} and ${join(dir, 'replay-estimate.md')}\n`);
      if (probeEst !== undefined) {
        const low = probeEst.total.costLow + est.total.costLow;
        const high = probeEst.total.costHigh + est.total.costHigh;
        const f = (n: number) => `$${n.toFixed(4)}`;
        const fit = ra.maxCost === undefined ? '' : high <= ra.maxCost ? `; the high estimate fits --max-cost ${f(ra.maxCost)}` : `; the high estimate does not fit --max-cost ${f(ra.maxCost)}`;
        process.stdout.write(`bench: probes + replay together, one shared --max-cost budget: ${f(low)} low to ${f(high)} high${fit}\n`);
      }
    }
  } else if (section !== undefined || replaySection !== undefined) {
    const stopClause = stopped.length > 0 ? `; ${ra!.replay ? 'real-model requests' : 'probing'} stopped (${stopped[0]!.reason})` : '';
    if (section !== undefined) {
      process.stdout.write(`bench: ${section.records.length} probes, real cost $${section.cost.toFixed(4)} of --max-cost $${section.maxCost}${replaySection === undefined ? stopClause : ''}\n`);
    }
    if (replaySection !== undefined) {
      const n = replaySection.groups.reduce((x, r) => x + r.requests, 0);
      process.stdout.write(`bench: ${n} replayed requests, real cost $${replaySection.cost.toFixed(4)} of --max-cost $${replaySection.maxCost}${stopClause}\n`);
    }
  }
  return 0;
}

/** True when this module is the program node was started with (not when imported). */
function isEntryPoint(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  main(process.argv.slice(2)).then(
    code => (process.exitCode = code),
    (e: unknown) => {
      process.stderr.write(`bench: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}\n`);
      process.exitCode = 1;
    },
  );
}
