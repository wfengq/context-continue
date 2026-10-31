import { realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { computeMetrics, type GroupMetrics } from './metrics.js';
import { createPolicy } from './policies/index.js';
import { renderReport, writeResults } from './report.js';
import { runScenario } from './runner.js';
import { loadScenario } from './scenario.js';
import type { CallRecord, Group, Scenario } from './types.js';

/** The formal scenarios, in report order. */
export const SCENARIO_IDS = ['product-plan', 'flappy-bird', 'event-plan'] as const;
const GROUPS: Group[] = ['A', 'B', 'C', 'D', 'E', 'F'];

/** `scenarios/` at the package root; the module sits one level below it in both `src/` and `dist/`. */
const SCENARIO_DIR = fileURLToPath(new URL('../scenarios/', import.meta.url));

const USAGE =
  'Usage: bench run --scenario <id|path.json|all> --group <A..F|all> [--window 128000] [--compact-ratio 0.8] ' +
  '[--summary-tokens 1500] [--cache-ratio 0.1] [--out results] [--stamp <s>]';

interface Args {
  scenario: string;
  group: string;
  window: number;
  compactRatio: number;
  summaryTokens: number;
  cacheRatio: number;
  out: string;
  stamp: string | undefined;
}

class UsageError extends Error {}

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

function parseArgs(argv: string[]): Args {
  const [command, ...rest] = argv;
  if (command !== 'run') throw new UsageError(command === undefined ? 'missing command' : `unknown command "${command}"`);
  const seen = new Map<string, string>();
  for (let i = 0; i < rest.length; i += 2) {
    const flag = rest[i]!;
    const value = rest[i + 1];
    if (!flag.startsWith('--')) throw new UsageError(`unexpected argument "${flag}"`);
    if (value === undefined || value.startsWith('--')) throw new UsageError(`${flag} needs a value`);
    if (seen.has(flag)) throw new UsageError(`${flag} is given more than once`);
    seen.set(flag, value);
  }
  const known = ['--scenario', '--group', '--window', '--compact-ratio', '--summary-tokens', '--cache-ratio', '--out', '--stamp'];
  for (const flag of seen.keys()) if (!known.includes(flag)) throw new UsageError(`unknown flag ${flag}`);
  const scenario = seen.get('--scenario');
  const group = seen.get('--group');
  if (scenario === undefined) throw new UsageError('--scenario is required');
  if (group === undefined) throw new UsageError('--group is required');
  if (group !== 'all' && !GROUPS.includes(group as Group)) throw new UsageError(`unknown group "${group}" (use A..F or all)`);
  const stamp = seen.get('--stamp');
  // A plain name: no separators, and not "." or ".." (or only dots), which would leave --out.
  if (stamp !== undefined && (!/^[\w.-]+$/.test(stamp) || /^\.+$/.test(stamp))) {
    throw new UsageError(`--stamp must be a plain directory name, got "${stamp}"`);
  }
  const int = (n: number) => Number.isInteger(n) && n > 0;
  return {
    scenario,
    group,
    window: number('--window', seen.get('--window') ?? '128000', int, 'a positive integer'),
    compactRatio: number('--compact-ratio', seen.get('--compact-ratio') ?? '0.8', n => n > 0 && n <= 1, 'a number in (0, 1]'),
    summaryTokens: number('--summary-tokens', seen.get('--summary-tokens') ?? '1500', int, 'a positive integer'),
    cacheRatio: number('--cache-ratio', seen.get('--cache-ratio') ?? '0.1', n => n >= 0 && n <= 1, 'a number in [0, 1]'),
    out: seen.get('--out') ?? 'results',
    stamp,
  };
}

/** Runs the bench; returns the process exit code. Errors go to stderr. */
export async function main(argv: string[]): Promise<number> {
  let args: Args;
  try {
    args = parseArgs(argv);
  } catch (e) {
    if (!(e instanceof UsageError)) throw e;
    process.stderr.write(`bench: ${e.message}\n${USAGE}\n`);
    return 2;
  }

  // Load and validate every scenario before running anything.
  const ids = args.scenario === 'all' ? [...SCENARIO_IDS] : [args.scenario];
  const scenarios: Scenario[] = [];
  for (const id of ids) {
    try {
      scenarios.push(loadScenario(scenarioPath(id)));
    } catch (e) {
      process.stderr.write(`bench: scenario "${id}": ${(e as Error).message}\n`);
      return 1;
    }
  }

  const groups = args.group === 'all' ? GROUPS : [args.group as Group];
  const opts = { window: args.window, compactRatio: args.compactRatio, summaryTokens: args.summaryTokens };
  const records: CallRecord[] = [];
  const metrics: GroupMetrics[] = [];
  for (const s of scenarios) {
    for (const g of groups) {
      const run = await runScenario(s, createPolicy(g, opts));
      records.push(...run.records);
      metrics.push(computeMetrics(run.records, run.stats, args.cacheRatio));
    }
  }

  const params = { cacheRatio: args.cacheRatio, compactRatio: args.compactRatio, summaryTokens: args.summaryTokens, window: args.window };
  const report = renderReport(metrics, { scenarios: scenarios.map(s => s.id), params, dsbotRef: 'f823773' });
  const dir = join(args.out, args.stamp ?? timestamp(new Date()));
  writeResults(dir, { records, metrics, params }, report);
  process.stdout.write(`bench: wrote ${join(dir, 'results.json')} and ${join(dir, 'report.md')}\n`);
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
