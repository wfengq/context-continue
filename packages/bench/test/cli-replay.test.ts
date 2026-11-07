import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { main, scenarioPath, type MainDeps } from '../src/cli.js';

const tmp = () => mkdtempSync(join(tmpdir(), 'bench-replay-'));
const KEY = 'sk-deepseek-TOPSECRETKEYVALUE';
const BASE = 'https://api.deepseek.com/v1?token=URLSECRET';
const oa = ['--provider', 'openai', '--base-url', BASE, '--model', 'deepseek-chat', '--api-key-env', 'DEEPSEEK_API_KEY', '--price', '0.28,0.028,0.42'];

async function run(argv: string[], deps?: MainDeps): Promise<{ code: number; err: string; out: string }> {
  let err = '';
  let out = '';
  const e = vi.spyOn(process.stderr, 'write').mockImplementation((c: string | Uint8Array) => ((err += String(c)), true));
  const o = vi.spyOn(process.stdout, 'write').mockImplementation((c: string | Uint8Array) => ((out += String(c)), true));
  try {
    return { code: await main(argv, deps), err, out };
  } finally {
    e.mockRestore();
    o.mockRestore();
  }
}

afterEach(() => vi.restoreAllMocks());

/** A fetch stub that answers every request with fixed DeepSeek-style usage and counts calls. */
function stub() {
  const calls: { body: { max_tokens: number } }[] = [];
  const fetch = (async (_url: unknown, init: RequestInit) => {
    calls.push({ body: JSON.parse(init.body as string) });
    return new Response(JSON.stringify({ choices: [{ message: { content: 'ok' }, finish_reason: 'length' }], usage: { prompt_tokens: 1000, completion_tokens: 16, prompt_cache_hit_tokens: 600, prompt_cache_miss_tokens: 400 } }), { status: 200 });
  }) as typeof globalThis.fetch;
  return { fetch, calls };
}

const read = (dir: string, f: string) => readFileSync(join(dir, f), 'utf8');
const base = (out: string, group = 'all') => ['run', '--scenario', 'flappy-bird', '--group', group, '--out', out, '--stamp', 'S'];
const deps = (fetch: typeof globalThis.fetch): MainDeps => ({ fetch, env: { DEEPSEEK_API_KEY: KEY }, sleep: async () => {} });

describe('bench cli: --replay', () => {
  test('usage errors exit 2 and create no output directory', async () => {
    const { fetch, calls } = stub();
    const cases: [string[], RegExp][] = [
      [['--replay'], /--max-cost/],
      [['--replay', '--probe-groups', 'A', '--max-cost', '1'], /--probe-groups needs --probes/],
      [['--replay', '--probe-samples', 'all', '--dry-run'], /--probe-samples needs --probes/],
      [['--replay', '--max-probes', '3', '--dry-run'], /--max-probes needs --probes/],
      [['--replay', '--no-probe-control', '--dry-run'], /--no-probe-control needs --probes/],
      [['--max-cost', '1'], /needs --probes or --replay/],
      [['--replay', '--provider', 'openai', '--dry-run'], /needs --base-url/],
    ];
    for (const [extra, err] of cases) {
      const out = join(tmp(), 'o');
      const r = await run([...base(out), ...extra], deps(fetch));
      expect(r.code, extra.join(' ')).toBe(2);
      expect(r.err).toMatch(err);
      expect(existsSync(out)).toBe(false);
    }
    expect(calls).toHaveLength(0);
  });

  test('--replay with an openai provider, base URL, model and price is valid', async () => {
    const { fetch, calls } = stub();
    const r = await run([...base(join(tmp(), 'o'), 'A'), '--replay', ...oa, '--max-cost', '1'], deps(fetch));
    expect(r.code, r.err).toBe(0);
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every(c => c.body.max_tokens === 16)).toBe(true);
  });

  test('--dry-run --replay never calls fetch and estimates one request per recorded request', async () => {
    const { fetch, calls } = stub();
    const out = tmp();
    const r = await run([...base(out), '--replay', '--dry-run', ...oa], deps(fetch));
    expect(r.code, r.err).toBe(0);
    expect(calls).toHaveLength(0);
    const dir = join(out, 'S');
    expect(readdirSync(dir).sort()).toEqual(['replay-estimate.json', 'replay-estimate.md', 'report.md', 'results.json']);
    const est = JSON.parse(read(dir, 'replay-estimate.json'));
    const json = JSON.parse(read(dir, 'results.json'));
    expect(est.rows).toHaveLength(6);
    for (const row of est.rows) {
      expect(row.requests).toBe(json.records.filter((x: { group: string }) => x.group === row.group).length);
      expect(row.outputTokens).toBe(row.requests * 16);
    }
    expect(est.total.requests).toBe(json.records.length);
    expect(r.out).toContain('Replay dry run');
    expect(json.replay).toBeUndefined();
    expect(JSON.stringify(est)).not.toContain('URLSECRET');
  });

  test('a real run: replay.jsonl, unchanged records, summed usage, a comparison table, and no key or URL anywhere', async () => {
    const plain = tmp();
    const out = tmp();
    expect((await run(base(plain))).code).toBe(0);
    const { fetch, calls } = stub();
    const r = await run([...base(out), '--replay', ...oa, '--max-cost', '5'], deps(fetch));
    expect(r.code, r.err).toBe(0);
    const dir = join(out, 'S');
    const json = JSON.parse(read(dir, 'results.json'));
    const plainJson = JSON.parse(read(join(plain, 'S'), 'results.json'));
    const { replay, ...rest } = json;
    expect(rest).toEqual(plainJson);
    expect(calls).toHaveLength(json.records.length);
    expect(read(dir, 'replay.jsonl').trim().split('\n')).toHaveLength(json.records.length);
    expect(replay.maxTokens).toBe(16);
    expect(replay.baseUrlHost).toBe('api.deepseek.com');
    expect(replay.stopped).toBeUndefined();
    expect(replay.groups).toHaveLength(6);
    expect(replay.groups.every((g: { complete: boolean }) => g.complete)).toBe(true);
    for (const k of ['inputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'outputTokens']) {
      expect(replay.groups.reduce((n: number, g: { usage: Record<string, number> }) => n + g.usage[k]!, 0)).toBe(replay.usage[k]);
    }
    expect(replay.cost).toBeCloseTo(calls.length * (400 * 0.28 + 600 * 0.028 + 16 * 0.42) / 1e6, 10);
    expect(replay.groups[0].realCacheReadPct).toBeCloseTo(60, 10);
    expect(readdirSync(dir).sort()).toEqual(['replay.jsonl', 'report.md', 'results.json']);
    const report = read(dir, 'report.md');
    expect(report).toContain('> The replay section used a real model (openai-compatible, deepseek-chat)');
    expect(report).toContain('## Replay on a real model');
    expect(report).toMatch(/\| D \| flappy-bird \| \$/);
    expect(report).not.toMatch(/Skipped:/);
    for (const f of readdirSync(dir)) {
      const text = read(dir, f);
      expect(text, f).not.toContain(KEY);
      expect(text, f).not.toContain('URLSECRET');
      expect(text, f).not.toContain('/v1');
    }
    expect(r.out + r.err).not.toContain(KEY);
    expect(r.out + r.err).not.toContain('URLSECRET');
  }, 60_000);

  test('a guard stop mid-run: stopped groups are incomplete, left out of the comparison and named, with only --replay', async () => {
    const out = tmp();
    const { fetch } = stub();
    const r = await run([...base(out), '--replay', ...oa, '--max-cost', '0.03'], deps(fetch));
    expect(r.code, r.err).toBe(0);
    const dir = join(out, 'S');
    const json = JSON.parse(read(dir, 'results.json'));
    const g = (x: string) => json.replay.groups.find((y: { group: string }) => y.group === x);
    expect(g('A').complete).toBe(true);
    const incomplete = json.replay.groups.filter((y: { complete: boolean }) => !y.complete).map((y: { group: string }) => y.group);
    expect(incomplete.length).toBeGreaterThan(0);
    // Groups after the stop sent nothing and still show as incomplete.
    expect(g('F').requests).toBe(0);
    expect(g('F').complete).toBe(false);
    expect(json.replay.stopped.length).toBeGreaterThan(0);
    expect(json.replay.stopped[0].reason).toMatch(/--max-cost 0.03 reached/);
    const report = read(dir, 'report.md');
    expect(report).toMatch(/Real-model requests stopped: --max-cost 0.03 reached/);
    expect(report).not.toMatch(/Probing stopped/);
    expect(report).toMatch(/Skipped: flappy-bird vs D: group .* incomplete/);
    expect(report).toMatch(/\| D \| none \|/);
    expect(r.out).toMatch(/real-model requests stopped \(--max-cost 0.03 reached/);
    expect(r.out).not.toMatch(/probing stopped/);
  }, 60_000);

  test('--probes with --replay share one guard and one stop; the probe totals exclude replay spending', async () => {
    const s = JSON.parse(readFileSync(scenarioPath('flappy-bird'), 'utf8'));
    for (const f of s.facts) delete f.probe;
    s.facts[0].probe = { question: 'What hitbox size did the team agree?', expect: ['ok'] };
    const path = join(tmp(), 'f.json');
    writeFileSync(path, JSON.stringify(s));
    const out = tmp();
    const { fetch, calls } = stub();
    const r = await run(['run', '--scenario', path, '--group', 'A', '--out', out, '--stamp', 'S', '--probes', '--replay', '--probe-groups', 'A', ...oa, '--max-cost', '5'], deps(fetch));
    expect(r.code, r.err).toBe(0);
    const json = JSON.parse(read(join(out, 'S'), 'results.json'));
    expect(json.probes.records.length).toBeGreaterThan(0);
    expect(calls).toHaveLength(json.records.length + json.probes.records.length);
    expect(json.probes.usage.outputTokens).toBe(json.probes.records.length * 16);
    expect(json.replay.usage.outputTokens).toBe(json.records.length * 16);
    expect(json.probes.cost + json.replay.cost).toBeCloseTo(calls.length * (400 * 0.28 + 600 * 0.028 + 16 * 0.42) / 1e6, 10);
    expect(read(join(out, 'S'), 'report.md')).toContain('The fact-probe and replay sections used a real model');
  }, 60_000);
});
