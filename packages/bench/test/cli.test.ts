import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { DEFAULT_STREAM_OPTIONS } from '@context-continue/core';
import { LONG_IDS, main, SCENARIO_IDS, scenarioPath, STANDARD_IDS, XLONG_IDS, type MainDeps } from '../src/cli.js';

const STANDARD = ['product-plan', 'flappy-bird', 'event-plan'];
const LONG = ['long-app', 'long-event'];
const XLONG = ['xlong-product'];

const tmp = () => mkdtempSync(join(tmpdir(), 'bench-cli-'));

/** Runs main with stderr (and stdout) captured. */
async function run(argv: string[], deps?: MainDeps): Promise<{ code: number; err: string; out: string }> {
  let err = '';
  let stdout = '';
  const spy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
    err += String(chunk);
    return true;
  });
  const quiet = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
    stdout += String(chunk);
    return true;
  });
  try {
    return { code: await main(argv, deps), err, out: stdout };
  } finally {
    spy.mockRestore();
    quiet.mockRestore();
  }
}

afterEach(() => vi.restoreAllMocks());

describe('bench cli', () => {
  test('--scenario long runs only the two long scenarios, with one long summary', async () => {
    const out = tmp();
    expect((await run(['run', '--scenario', 'long', '--group', 'all', '--out', out, '--stamp', 'L'])).code).toBe(0);
    const report = readFileSync(join(out, 'L', 'report.md'), 'utf8');
    expect(report.match(/^## Scenario: .*$/gm)).toEqual(LONG.map(id => `## Scenario: ${id}`));
    expect(report.match(/^## Summary.*$/gm)).toEqual(['## Summary (long scenarios)']);
    const json = JSON.parse(readFileSync(join(out, 'L', 'results.json'), 'utf8'));
    expect([...new Set(json.metrics.map((m: { scenario: string }) => m.scenario))]).toEqual(LONG);
    expect(json.metrics.every((m: { tier: string }) => m.tier === 'long')).toBe(true);
  }, 60_000);

  test('--scenario standard runs only the three standard scenarios, with one standard summary', async () => {
    const out = tmp();
    expect((await run(['run', '--scenario', 'standard', '--group', 'all', '--out', out, '--stamp', 'S'])).code).toBe(0);
    const report = readFileSync(join(out, 'S', 'report.md'), 'utf8');
    expect(report.match(/^## Scenario: .*$/gm)).toEqual(STANDARD.map(id => `## Scenario: ${id}`));
    expect(report.match(/^## Summary.*$/gm)).toEqual(['## Summary (standard scenarios)']);
    const json = JSON.parse(readFileSync(join(out, 'S', 'results.json'), 'utf8'));
    expect(json.metrics).toHaveLength(18);
    expect(json.metrics.every((m: { tier: string }) => m.tier === 'standard')).toBe(true);
  });

  test('SCENARIO_IDS lists the three standard scenarios, then the two long ones, then the xlong one', () => {
    expect([...SCENARIO_IDS]).toEqual([...STANDARD, ...LONG, ...XLONG]);
    expect([...SCENARIO_IDS]).toEqual([...STANDARD_IDS, ...LONG_IDS, ...XLONG_IDS]);
  });

  test('--scenario xlong runs only xlong-product, with one xlong summary', async () => {
    // Report shape only, with one group; E's compaction on xlong is asserted in xlong-scenario.test.ts.
    const out = tmp();
    expect((await run(['run', '--scenario', 'xlong', '--group', 'E', '--out', out, '--stamp', 'X'])).code).toBe(0);
    const report = readFileSync(join(out, 'X', 'report.md'), 'utf8');
    expect(report.match(/^## Scenario: .*$/gm)).toEqual(XLONG.map(id => `## Scenario: ${id}`));
    expect(report.match(/^## Summary.*$/gm)).toEqual(['## Summary (xlong scenarios)']);
    const json = JSON.parse(readFileSync(join(out, 'X', 'results.json'), 'utf8'));
    expect(json.metrics.map((m: { scenario: string; tier: string }) => [m.scenario, m.tier])).toEqual([['xlong-product', 'xlong']]);
  }, 120_000);

  test('flags reach the metrics and the E policy', async () => {
    const out = tmp();
    const argv = ['run', '--scenario', 'flappy-bird', '--group', 'E', '--out', out, '--stamp', 'S',
      '--window', '2000', '--compact-ratio', '0.5', '--summary-tokens', '100', '--cache-ratio', '0.5'];
    expect((await run(argv)).code).toBe(0);
    const json = JSON.parse(readFileSync(join(out, 'S', 'results.json'), 'utf8'));
    expect(json.params).toEqual({ cacheRatio: 0.5, compactRatio: 0.5, summaryTokens: 100, window: 2000 });
    expect(json.metrics).toHaveLength(1);
    const m = json.metrics[0];
    expect(m.group).toBe('E');
    expect(m.scenario).toBe('flappy-bird');
    expect(m.compactions).toBeGreaterThan(0);
    expect(m.costUnits).toBe(m.cacheableTokens * 0.5 + m.uncachedTokens);
  });

  test('--scenario all writes results.json and report.md with six groups; two runs with the same stamp are byte-identical', async () => {
    const a = tmp();
    const b = tmp();
    for (const out of [a, b]) {
      expect((await run(['run', '--scenario', 'all', '--group', 'all', '--out', out, '--stamp', 'T'])).code).toBe(0);
    }
    const report = readFileSync(join(a, 'T', 'report.md'), 'utf8');
    for (const g of ['A', 'B', 'C', 'D', 'E', 'F']) expect(report).toMatch(new RegExp(`^\\| ${g} \\|`, 'm'));
    for (const id of [...STANDARD, ...LONG, ...XLONG]) expect(report).toContain(`## Scenario: ${id}`);
    expect(report.match(/^## Summary.*$/gm)).toEqual(['## Summary (standard scenarios)', '## Summary (long scenarios)', '## Summary (xlong scenarios)']);
    const json = JSON.parse(readFileSync(join(a, 'T', 'results.json'), 'utf8'));
    expect(json.params).toEqual({ cacheRatio: 0.1, compactRatio: 0.8, summaryTokens: 1500, window: 128000 });
    expect(json.metrics).toHaveLength(36);
    expect(json.records.length).toBeGreaterThan(0);
    for (const f of ['results.json', 'report.md']) {
      expect(readFileSync(join(a, 'T', f)).equals(readFileSync(join(b, 'T', f)))).toBe(true);
    }
  }, 600_000);

  test('without --stamp the directory is named by a UTC timestamp', async () => {
    const out = tmp();
    expect((await run(['run', '--scenario', 'event-plan', '--group', 'A', '--out', out])).code).toBe(0);
    const dirs = readdirSync(out);
    expect(dirs).toHaveLength(1);
    expect(dirs[0]).toMatch(/^\d{8}T\d{6}Z$/);
  });

  test('invalid scenario path or group exits non-zero with a message', async () => {
    const out = tmp();
    const missing = await run(['run', '--scenario', 'no-such-scenario', '--group', 'all', '--out', out]);
    expect(missing.code).not.toBe(0);
    expect(missing.err).toContain('no-such-scenario');
    const badPath = await run(['run', '--scenario', join(out, 'missing.json'), '--group', 'A', '--out', out]);
    expect(badPath.code).not.toBe(0);
    expect(badPath.err).toContain('missing.json');
    const badGroup = await run(['run', '--scenario', 'all', '--group', 'Z', '--out', out]);
    expect(badGroup.code).not.toBe(0);
    expect(badGroup.err).toMatch(/group/i);
    expect(readdirSync(out)).toEqual([]);
  });

  test('invalid flags, values and commands exit non-zero with a message', async () => {
    const out = tmp();
    const cases = [
      ['run', '--scenario', 'all', '--group', 'all', '--window', 'big', '--out', out],
      ['run', '--scenario', 'all', '--group', 'all', '--compact-ratio', '1.5', '--out', out],
      ['run', '--scenario', 'all', '--group', 'all', '--cache-ratio', '-1', '--out', out],
      ['run', '--scenario', 'all', '--group', 'all', '--summary-tokens', '0', '--out', out],
      ['run', '--scenario', 'all', '--group', 'all', '--colour', 'red', '--out', out],
      ['run', '--scenario', 'all', '--group', 'all', '--out'],
      ['run', '--group', 'all', '--out', out],
      ['walk', '--scenario', 'all', '--group', 'all', '--out', out],
      [],
    ];
    for (const argv of cases) {
      const r = await run(argv);
      expect(r.code, argv.join(' ')).not.toBe(0);
      expect(r.err.length, argv.join(' ')).toBeGreaterThan(0);
    }
    expect(readdirSync(out)).toEqual([]);
  });

  test('a stamp made only of dots is rejected, so the output cannot escape --out', async () => {
    const parent = tmp();
    const out = join(parent, 'out');
    for (const stamp of ['.', '..', '...']) {
      const r = await run(['run', '--scenario', 'event-plan', '--group', 'A', '--out', out, '--stamp', stamp]);
      expect(r.code, stamp).toBe(2);
      expect(r.err).toContain('--stamp');
    }
    expect(readdirSync(parent)).toEqual([]);
  });

  test('a repeated flag is a usage error', async () => {
    const out = tmp();
    const r = await run(['run', '--scenario', 'event-plan', '--group', 'A', '--group', 'B', '--out', out]);
    expect(r.code).toBe(2);
    expect(r.err).toContain('--group');
    expect(readdirSync(out)).toEqual([]);
  });

  describe('--c-public', () => {
    const go = async (extra: string[], group = 'all', scenario = 'product-plan') => {
      const out = tmp();
      const r = await run(['run', '--scenario', scenario, '--group', group, '--out', out, '--stamp', 'T', ...extra]);
      return { ...r, out };
    };
    const results = (out: string) => JSON.parse(readFileSync(join(out, 'T', 'results.json'), 'utf8'));

    test('default is "default": recorded as a top-level string and listed in the report parameters', async () => {
      const r = await go([]);
      expect(r.code).toBe(0);
      const json = results(r.out);
      expect(json.cPublic).toBe('default');
      expect(json.params).toEqual({ cacheRatio: 0.1, compactRatio: 0.8, summaryTokens: 1500, window: 128000 });
      expect(readFileSync(join(r.out, 'T', 'report.md'), 'utf8')).toContain('- cPublic: default\n');
    });

    test('explicit "default" equals omitting the flag, byte for byte', async () => {
      const a = await go([]);
      const b = await go(['--c-public', 'default']);
      for (const f of ['results.json', 'report.md']) expect(readFileSync(join(a.out, 'T', f)).equals(readFileSync(join(b.out, 'T', f)))).toBe(true);
    });

    test('none passes all three switches off explicitly: group C differs from the default (which has directives on)', async () => {
      const def = results((await go([], 'C')).out);
      const none = results((await go(['--c-public', 'none'], 'C')).out);
      expect(none.cPublic).toBe('none');
      expect(none.metrics).not.toEqual(def.metrics);
    });

    test('a subset switches only its sections on: directives alone equals the default; contracts alone turns directives off', async () => {
      const def = results((await go([], 'C')).out);
      const dir = results((await go(['--c-public', 'directives'], 'C')).out);
      expect(dir.metrics).toEqual(def.metrics);
      const con = results((await go(['--c-public', 'contracts'], 'C')).out);
      expect(con.metrics).not.toEqual(def.metrics);
      expect(con.metrics).not.toEqual(results((await go(['--c-public', 'none'], 'C')).out).metrics);
    });

    test('subsets are normalised to name order; the full set is "all"', async () => {
      expect(results((await go(['--c-public', 'contracts,directives'], 'C')).out).cPublic).toBe('contracts,directives');
      expect(results((await go(['--c-public', 'failures,directives'], 'C')).out).cPublic).toBe('directives,failures');
      expect(results((await go(['--c-public', 'failures,contracts,directives'], 'C')).out).cPublic).toBe('all');
      const all = await go(['--c-public', 'all'], 'C');
      expect(results(all.out).cPublic).toBe('all');
      expect(readFileSync(join(all.out, 'T', 'report.md'), 'utf8')).toContain('- cPublic: all\n');
    });

    test('only group C changes; the other groups record the same under any setting', async () => {
      const none = results((await go(['--c-public', 'none'])).out);
      const all = results((await go(['--c-public', 'all'])).out);
      const notC = (x: { group?: string; botId?: string }) => x.group !== 'C';
      expect(all.metrics.filter(notC)).toEqual(none.metrics.filter(notC));
      const recs = (j: { records: { group?: string }[] }) => j.records.filter(notC);
      expect(recs(all).length).toBeGreaterThan(0);
      expect(recs(all)).toEqual(recs(none));
      expect(all.metrics.find((m: { group: string }) => m.group === 'C')).not.toEqual(none.metrics.find((m: { group: string }) => m.group === 'C'));
    });

    test('unknown names, duplicates, empty values and "none" inside a list exit 2 without output', async () => {
      const out = tmp();
      for (const v of ['bogus', 'directives,bogus', 'directives,directives', '', ',', 'directives,', 'none,directives', 'all,directives', 'ALL', 'none,none', 'default,directives']) {
        const r = await run(['run', '--scenario', 'product-plan', '--group', 'C', '--out', out, '--c-public', v]);
        expect(r.code, `"${v}"`).toBe(2);
        expect(r.err, `"${v}"`).toContain('--c-public');
      }
      const dup = await run(['run', '--scenario', 'product-plan', '--group', 'C', '--out', out, '--c-public', 'all', '--c-public', 'default']);
      expect(dup.code).toBe(2);
      expect(readdirSync(out)).toEqual([]);
    });
  });

  describe('--c-stream', () => {
    const go = async (extra: string[], group = 'all', scenario = 'product-plan') => {
      const out = tmp();
      const r = await run(['run', '--scenario', scenario, '--group', group, '--out', out, '--stamp', 'T', ...extra]);
      return { ...r, out };
    };
    const results = (out: string) => JSON.parse(readFileSync(join(out, 'T', 'results.json'), 'utf8'));
    const report = (out: string) => readFileSync(join(out, 'T', 'report.md'), 'utf8');

    test('default is off: recorded as a top-level field and one report parameter line; explicit off is the same, byte for byte', async () => {
      const a = await go([]);
      expect(a.code).toBe(0);
      expect(results(a.out).cStream).toEqual({ mode: 'off' });
      expect(report(a.out)).toContain('- cPublic: default\n- cStream: off\n');
      expect(report(a.out)).not.toContain('--c-stream');
      const b = await go(['--c-stream', 'off']);
      for (const f of ['results.json', 'report.md']) expect(readFileSync(join(a.out, 'T', f)).equals(readFileSync(join(b.out, 'T', f)))).toBe(true);
    });

    test('on records restreamTokens (default 8000, or --restream-tokens) and adds one caveat; other groups record the same', async () => {
      const off = results((await go([])).out);
      const on = await go(['--c-stream', 'on']);
      expect(on.code).toBe(0);
      const json = results(on.out);
      expect(json.cStream).toEqual({ mode: 'on', restreamTokens: 8000 });
      expect(report(on.out)).toContain('- cStream: on (restreamTokens 8000)\n');
      expect(report(on.out)).toContain('- C runs the --c-stream prototype');
      const notC = (x: { group?: string }) => x.group !== 'C';
      expect(json.metrics.filter(notC)).toEqual(off.metrics.filter(notC));
      expect(json.records.filter(notC)).toEqual(off.records.filter(notC));
      expect(json.metrics.find((m: { group: string }) => m.group === 'C')).not.toEqual(off.metrics.find((m: { group: string }) => m.group === 'C'));
      const small = await go(['--c-stream', 'on', '--restream-tokens', '500'], 'C');
      expect(results(small.out).cStream).toEqual({ mode: 'on', restreamTokens: 500 });
      expect(results(small.out).metrics).not.toEqual(json.metrics.filter((m: { group: string }) => m.group === 'C'));
    });

    test('--c-stream-own on records own: true and names it in the parameter line and caveat; off is the same as not giving it', async () => {
      const on = await go(['--c-stream', 'on'], 'C');
      const own = await go(['--c-stream', 'on', '--c-stream-own', 'on'], 'C');
      expect(own.code).toBe(0);
      expect(results(own.out).cStream).toEqual({ mode: 'on', restreamTokens: 8000, own: true });
      expect(report(own.out)).toContain('- cStream: on (restreamTokens 8000, own outputs)\n');
      expect(report(own.out)).toContain("appends the bot's own reply and tool-call lines");
      expect(report(on.out)).not.toContain('own outputs');
      const cost = (out: string) => results(out).metrics[0].costUnits;
      expect(cost(own.out)).toBeGreaterThan(cost(on.out));
      const explicitOff = await go(['--c-stream', 'on', '--c-stream-own', 'off'], 'C');
      for (const f of ['results.json', 'report.md']) expect(readFileSync(join(on.out, 'T', f)).equals(readFileSync(join(explicitOff.out, 'T', f)))).toBe(true);
    });

    test('core records restreamTokens and drives the core stream; non-C groups are unchanged; one parameter line and the core caveat', async () => {
      const off = results((await go([])).out);
      const core = await go(['--c-stream', 'core']);
      expect(core.code).toBe(0);
      const json = results(core.out);
      expect(json.cStream).toEqual({ mode: 'core', restreamTokens: 8000 });
      const md = report(core.out);
      expect(md).toContain('- cStream: core (restreamTokens 8000)\n');
      expect(md).toContain("- C uses the core's long-project stream mode");
      expect(md).not.toContain('- C runs the --c-stream prototype');
      expect(md).toMatch(/Group C stream: used from step 0; \d+ snapshots; ledger \d+ entries\./);
      const notC = (x: { group?: string }) => x.group !== 'C';
      expect(json.metrics.filter(notC)).toEqual(off.metrics.filter(notC));
      expect(json.records.filter(notC)).toEqual(off.records.filter(notC));
      const c = json.metrics.find((m: { group: string }) => m.group === 'C');
      expect(c.upperBound).toBeUndefined();
      expect(c.stream.fromStep).toBe(0);
      const small = await go(['--c-stream', 'core', '--restream-tokens', '500'], 'C');
      expect(results(small.out).cStream).toEqual({ mode: 'core', restreamTokens: 500 });
    });

    test('auto records autoAfterEntries (the core default, or --auto-after); below it C is exactly off', async () => {
      const auto = await go(['--c-stream', 'auto'], 'C');
      expect(auto.code).toBe(0);
      expect(results(auto.out).cStream).toEqual({ mode: 'auto', restreamTokens: 8000, autoAfterEntries: DEFAULT_STREAM_OPTIONS.autoAfterEntries });
      expect(report(auto.out)).toContain(`- cStream: auto (restreamTokens 8000, autoAfterEntries ${DEFAULT_STREAM_OPTIONS.autoAfterEntries})\n`);
      const high = await go(['--c-stream', 'auto', '--auto-after', '1000000'], 'C');
      expect(results(high.out).cStream).toEqual({ mode: 'auto', restreamTokens: 8000, autoAfterEntries: 1000000 });
      const off = results((await go([], 'C')).out);
      const { stream, ...rest } = results(high.out).metrics[0];
      expect(rest).toEqual(off.metrics[0]);
      expect(stream).toEqual({ fromStep: null, snapshots: 0, ledgerEntries: expect.any(Number) });
      expect(results(high.out).records).toEqual(off.records);
      expect(report(high.out)).toMatch(/Group C stream: not used \(ledger \d+ entries, below autoAfterEntries\)\./);
      const low = await go(['--c-stream', 'auto', '--auto-after', '1', '--restream-tokens', '4000'], 'C');
      const core = await go(['--c-stream', 'core', '--restream-tokens', '4000'], 'C');
      expect(results(low.out).metrics).toEqual(results(core.out).metrics);
    });

    test('bad values exit 2 without output; --restream-tokens needs a stream mode; --auto-after needs auto; --c-stream-own needs on', async () => {
      const out = tmp();
      for (const extra of [['--c-stream', 'yes'], ['--c-stream', 'ON'], ['--c-stream', 'on', '--restream-tokens', '0'], ['--c-stream', 'on', '--restream-tokens', '1.5'],
        ['--c-stream', 'on', '--restream-tokens', 'x'], ['--restream-tokens', '4000'], ['--c-stream', 'off', '--restream-tokens', '4000'],
        ['--c-stream-own', 'on'], ['--c-stream', 'off', '--c-stream-own', 'on'], ['--c-stream', 'off', '--c-stream-own', 'off'], ['--c-stream', 'on', '--c-stream-own', 'yes'],
        ['--c-stream', 'core', '--c-stream-own', 'on'], ['--c-stream', 'auto', '--c-stream-own', 'off'], ['--c-stream', 'CORE'],
        ['--auto-after', '100'], ['--c-stream', 'on', '--auto-after', '100'], ['--c-stream', 'core', '--auto-after', '100'],
        ['--c-stream', 'auto', '--auto-after', '0'], ['--c-stream', 'auto', '--auto-after', '2.5'], ['--c-stream', 'auto', '--auto-after', 'x'],
        ['--c-stream', 'core', '--restream-tokens', '0']]) {
        const r = await run(['run', '--scenario', 'product-plan', '--group', 'C', '--out', out, ...extra]);
        expect(r.code, extra.join(' ')).toBe(2);
        expect(r.err, extra.join(' ')).toMatch(/--c-stream|--restream-tokens|--c-stream-own|--auto-after/);
      }
      expect(readdirSync(out)).toEqual([]);
    });
  });
});

describe('bench cli: fact probes', () => {
  const KEY = 'sk-ant-api03-TOPSECRETKEYVALUE';

  /** flappy-bird without the bundled probes, written to a scratch file. */
  function unprobedScenario(): string {
    const s = JSON.parse(readFileSync(scenarioPath('flappy-bird'), 'utf8'));
    for (const f of s.facts) delete f.probe;
    const path = join(tmp(), 'flappy-unprobed.json');
    writeFileSync(path, JSON.stringify(s));
    return path;
  }

  /** flappy-bird with probes on two facts only (the bundled probes removed), written to a scratch file. */
  function probeScenario(): string {
    const s = JSON.parse(readFileSync(scenarioPath('flappy-bird'), 'utf8'));
    for (const f of s.facts) delete f.probe;
    s.facts[0].probe = { question: 'What hitbox size did the team agree?', expect: ['12x12'], reject: ['10x10'] };
    s.facts[2].probe = { question: 'How does the player flap on mobile?', expect: ['tap'] };
    const path = join(tmp(), 'flappy-probes.json');
    writeFileSync(path, JSON.stringify(s));
    return path;
  }

  /** A fetch stub answering every request "12x12 tap" with fixed usage; records each request body. */
  function stubFetch(usage = { input_tokens: 100, cache_creation_input_tokens: 600, cache_read_input_tokens: 0, output_tokens: 5 }) {
    const bodies: { headers: Record<string, string>; body: { messages: { content: { text: string; cache_control?: unknown }[] }[] } }[] = [];
    const fetch = (async (_url: unknown, init: RequestInit) => {
      bodies.push({ headers: init.headers as Record<string, string>, body: JSON.parse(init.body as string) });
      return new Response(JSON.stringify({ content: [{ type: 'text', text: '12x12, tap' }], stop_reason: 'end_turn', usage }), { status: 200 });
    }) as typeof globalThis.fetch;
    return { fetch, bodies };
  }

  const files = (dir: string) => readdirSync(dir).sort();
  const read = (dir: string, f: string) => readFileSync(join(dir, f), 'utf8');

  test('--probes --dry-run sends nothing, prints and writes the estimate, and leaves results.json and report.md as without probes', async () => {
    const path = probeScenario();
    const plain = tmp();
    const dry = tmp();
    expect((await run(['run', '--scenario', path, '--group', 'all', '--out', plain, '--stamp', 'S'])).code).toBe(0);
    const { fetch, bodies } = stubFetch();
    const r = await run(['run', '--scenario', path, '--group', 'all', '--out', dry, '--stamp', 'S', '--probes', '--dry-run'], { fetch, env: {} });
    expect(r.code).toBe(0);
    expect(bodies).toHaveLength(0);
    for (const f of ['results.json', 'report.md']) expect(read(join(dry, 'S'), f)).toBe(read(join(plain, 'S'), f));
    expect(files(join(dry, 'S'))).toEqual(['probe-estimate.json', 'probe-estimate.md', 'report.md', 'results.json']);
    const est = JSON.parse(read(join(dry, 'S'), 'probe-estimate.json'));
    expect(est.model).toBe('claude-haiku-5-5');
    expect(est.groups).toEqual(['A', 'C', 'D', 'E', 'none']);
    expect([...new Set(est.rows.map((x: { group: string }) => x.group))]).toEqual(['none', 'A', 'C', 'D', 'E']);
    // fml on two facts: at most 3 opportunities each.
    for (const row of est.rows) expect(row.probes).toBeGreaterThan(0);
    expect(est.total.probes).toBe(est.rows.reduce((n: number, x: { probes: number }) => n + x.probes, 0));
    expect(est.total.costHigh).toBeGreaterThan(est.total.costLow);
    expect(r.out).toContain('Probe dry run');
    expect(r.out).toContain('approximation');
    expect(read(join(dry, 'S'), 'probe-estimate.md')).toContain('| Total |');
  }, 60_000);

  test('a real run records probes in results.json, probes.jsonl and the report; scripted results are unchanged; the key appears nowhere', async () => {
    const path = probeScenario();
    const plain = tmp();
    const out = tmp();
    expect((await run(['run', '--scenario', path, '--group', 'all', '--out', plain, '--stamp', 'S'])).code).toBe(0);
    const { fetch, bodies } = stubFetch();
    const r = await run(['run', '--scenario', path, '--group', 'all', '--out', out, '--stamp', 'S', '--probes', '--max-cost', '5', '--probe-groups', 'A,C'],
      { fetch, env: { ANTHROPIC_API_KEY: KEY }, sleep: async () => {} });
    expect(r.code, r.err).toBe(0);
    expect(bodies.length).toBeGreaterThan(0);
    expect(bodies.every(b => b.headers['x-api-key'] === KEY)).toBe(true);
    // Every probe request ends with the uncached question and has a breakpoint on a cacheable block.
    for (const b of bodies) {
      const content = b.body.messages[0]!.content;
      expect(content[content.length - 1]!.text).toMatch(/^Question: /);
      expect(content[content.length - 1]!.cache_control).toBeUndefined();
    }
    const dir = join(out, 'S');
    const json = JSON.parse(read(dir, 'results.json'));
    const plainJson = JSON.parse(read(join(plain, 'S'), 'results.json'));
    const { probes, ...rest } = json;
    expect(rest).toEqual(plainJson);
    expect(probes.model).toBe('claude-haiku-5-5');
    expect(probes.groups).toEqual(['A', 'C']);
    expect(probes.records).toHaveLength(bodies.length);
    expect(probes.records.every((p: { verdict: string }) => p.verdict === 'correct')).toBe(true);
    expect(probes.usage.cacheWriteTokens).toBe(600 * bodies.length);
    expect(probes.cost).toBeCloseTo(bodies.length * (100 * 0.1 + 600 * 0.125 + 5 * 0.5) / 1e6, 10);
    const lines = read(dir, 'probes.jsonl').trim().split('\n').map(l => JSON.parse(l));
    expect(lines).toEqual(probes.records);
    const report = read(dir, 'report.md');
    expect(report).toContain('## Fact probes (real model)');
    expect(report).toMatch(/\| A \| contract \| \d+ \| 100\.0 \| 0\.0 \| 0\.0 \| 0\.0 \|/);
    expect(report).toContain('R-B19');
    for (const f of files(dir)) expect(read(dir, f)).not.toContain('TOPSECRETKEYVALUE');
    expect(r.out + r.err).not.toContain('TOPSECRETKEYVALUE');
  }, 60_000);

  test('the no-context control asks each probed fact once with the question alone, counted by the guard and shown as group "none"', async () => {
    const path = probeScenario();
    const out = tmp();
    const { fetch, bodies } = stubFetch();
    const r = await run(['run', '--scenario', path, '--group', 'all', '--out', out, '--stamp', 'S', '--probes', '--max-cost', '5', '--probe-groups', 'A,C'],
      { fetch, env: { ANTHROPIC_API_KEY: KEY }, sleep: async () => {} });
    expect(r.code, r.err).toBe(0);
    const json = JSON.parse(read(join(out, 'S'), 'results.json'));
    const records = json.probes.records as { group: string; factId: string; step: number; botId: string; inputTokens: number; cacheableTokens: number }[];
    const control = records.filter(x => x.group === 'none');
    // Two probed facts, each asked once.
    expect(control.map(x => x.factId).sort()).toEqual(['change-portrait-tap', 'contract-hitbox-12x12']);
    expect(control.every(x => x.step === -1 && x.botId === '' && x.cacheableTokens === 0 && x.inputTokens > 0)).toBe(true);
    expect(json.probes.control).toBe(true);
    // The control request is only the question segment: no project context, nothing cached.
    const questionOnly = bodies.filter(b => b.body.messages[0]!.content.length === 1);
    expect(questionOnly).toHaveLength(2);
    expect(questionOnly.every(b => /^Question: .*\nAnswer briefly\.$/.test(b.body.messages[0]!.content[0]!.text))).toBe(true);
    // Control requests are in the cost accounting like any other probe.
    expect(json.probes.records).toHaveLength(bodies.length);
    expect(json.probes.usage.cacheWriteTokens).toBe(600 * bodies.length);
    const report = read(join(out, 'S'), 'report.md');
    expect(report).toContain('no-context control');
    expect(report).toMatch(/\| none \| all \| 2 \|/);
    expect(report).toMatch(/\| none \| standard \| 2 \|/);
    expect(report).toMatch(/\| none \| 2 \|/);
    // The scripted results do not change.
    const plain = tmp();
    expect((await run(['run', '--scenario', path, '--group', 'all', '--out', plain, '--stamp', 'S'])).code).toBe(0);
    const { probes: _p, ...rest } = json;
    expect(rest).toEqual(JSON.parse(read(join(plain, 'S'), 'results.json')));
  }, 60_000);

  test('--no-probe-control leaves the control out; the flag needs --probes', async () => {
    const path = probeScenario();
    const out = tmp();
    const { fetch, bodies } = stubFetch();
    const r = await run(['run', '--scenario', path, '--group', 'A', '--out', out, '--stamp', 'S', '--probes', '--max-cost', '5', '--no-probe-control'],
      { fetch, env: { ANTHROPIC_API_KEY: KEY }, sleep: async () => {} });
    expect(r.code, r.err).toBe(0);
    const json = JSON.parse(read(join(out, 'S'), 'results.json'));
    expect(json.probes.control).toBe(false);
    expect(json.probes.records.some((x: { group: string }) => x.group === 'none')).toBe(false);
    expect(bodies.every(b => b.body.messages[0]!.content.length > 1)).toBe(true);
    expect(read(join(out, 'S'), 'report.md')).not.toContain('no-context control');
    const stray = await run(['run', '--scenario', path, '--group', 'A', '--out', tmp(), '--no-probe-control'], { fetch, env: {} });
    expect(stray.code).toBe(2);
    expect(stray.err).toMatch(/--no-probe-control needs --probes/);
  });

  test('--dry-run counts the control: its own estimate rows, none when --no-probe-control is given', async () => {
    const path = probeScenario();
    const { fetch, bodies } = stubFetch();
    const on = tmp();
    const off = tmp();
    expect((await run(['run', '--scenario', path, '--group', 'A', '--out', on, '--stamp', 'S', '--probes', '--dry-run'], { fetch, env: {} })).code).toBe(0);
    expect((await run(['run', '--scenario', path, '--group', 'A', '--out', off, '--stamp', 'S', '--probes', '--dry-run', '--no-probe-control'], { fetch, env: {} })).code).toBe(0);
    expect(bodies).toHaveLength(0);
    const a = JSON.parse(read(join(on, 'S'), 'probe-estimate.json'));
    const b = JSON.parse(read(join(off, 'S'), 'probe-estimate.json'));
    const none = a.rows.find((x: { group: string }) => x.group === 'none');
    expect(none.probes).toBe(2);
    expect(none.cacheableTokens).toBe(0);
    expect(none.costHigh).toBeGreaterThan(0);
    expect(b.rows.some((x: { group: string }) => x.group === 'none')).toBe(false);
    expect(a.total.probes).toBe(b.total.probes + 2);
    expect(read(join(on, 'S'), 'probe-estimate.md')).toContain('| none |');
  });

  test('--dry-run on the bundled flappy-bird plans its five probes, and the control asks five facts', async () => {
    const { fetch, bodies } = stubFetch();
    const dir = tmp();
    const r = await run(['run', '--scenario', 'flappy-bird', '--group', 'A', '--out', dir, '--stamp', 'S', '--probes', '--dry-run'], { fetch, env: {} });
    expect(r.code, r.err).toBe(0);
    expect(r.err).not.toMatch(/has a probe/);
    expect(bodies).toHaveLength(0);
    const est = JSON.parse(read(join(dir, 'S'), 'probe-estimate.json'));
    const row = (g: string) => est.rows.find((x: { group: string }) => x.group === g);
    expect(row('none').probes).toBe(5);
    // fml samples: each of the 5 facts has up to three opportunities for group A.
    expect(row('A').probes).toBeGreaterThanOrEqual(5);
    expect(row('A').probes).toBeLessThanOrEqual(15);
  });

  test('--max-cost: probing stops once the next probe\'s estimate would pass the budget; spend can exceed it by one probe; finished probes are written', async () => {
    const path = probeScenario();
    const out = tmp();
    // Deliberately unrealistic usage: $0.10 of output per probe, so three probes ($0.30) pass the $0.25 budget.
    const { fetch, bodies } = stubFetch({ input_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 200_000 });
    const r = await run(['run', '--scenario', path, '--group', 'all', '--out', out, '--stamp', 'S', '--probes', '--max-cost', '0.25'],
      { fetch, env: { ANTHROPIC_API_KEY: KEY }, sleep: async () => {} });
    expect(r.code, r.err).toBe(0);
    expect(bodies).toHaveLength(3);
    const json = JSON.parse(read(join(out, 'S'), 'results.json'));
    expect(json.probes.records).toHaveLength(3);
    expect(json.probes.cost).toBeCloseTo(0.3, 10);
    expect(json.probes.stopped.length).toBeGreaterThan(0);
    expect(json.probes.stopped[0].reason).toMatch(/--max-cost 0.25 reached/);
    expect(read(join(out, 'S'), 'report.md')).toMatch(/Probing stopped/);
    expect(read(join(out, 'S'), 'report.md')).toMatch(/not comparable/);
  }, 60_000);

  test('usage errors exit 2 without output or requests', async () => {
    const out = tmp();
    const { fetch, bodies } = stubFetch();
    const base = ['run', '--scenario', 'flappy-bird', '--group', 'all', '--out', out];
    const cases: [string[], RegExp][] = [
      [['--probes'], /--max-cost/],
      [['--dry-run'], /needs --probes/],
      [['--max-cost', '1'], /needs --probes/],
      [['--model', 'claude-haiku-5-5'], /needs --probes/],
      [['--probes', '--dry-run', '--model', 'gpt-x'], /no price for model "gpt-x"/],
      [['--probes', '--dry-run', '--probe-groups', 'A,Z'], /--probe-groups/],
      [['--probes', '--dry-run', '--probe-groups', 'A,A'], /--probe-groups/],
      [['--probes', '--dry-run', '--probe-samples', '0'], /--probe-samples/],
      [['--probes', '--dry-run', '--probe-samples', 'some'], /--probe-samples/],
      [['--probes', '--dry-run', '--max-probes', '-1'], /--max-probes/],
      [['--probes', '--max-cost', '0'], /--max-cost/],
      [['--probes', '--max-cost', 'lots'], /--max-cost/],
      [['--probes', '--probes', '--dry-run'], /more than once/],
    ];
    for (const [extra, msg] of cases) {
      const r = await run([...base, ...extra], { fetch, env: { ANTHROPIC_API_KEY: KEY } });
      expect(r.code, extra.join(' ')).toBe(2);
      expect(r.err, extra.join(' ')).toMatch(msg);
    }
    const onlyB = await run(['run', '--scenario', 'flappy-bird', '--group', 'B', '--out', out, '--probes', '--dry-run'], { fetch, env: {} });
    expect(onlyB.code).toBe(2);
    expect(onlyB.err).toMatch(/--probe-groups/);
    // Groups named in --probe-groups but not run are dropped with a note.
    const dropped = await run(['run', '--scenario', unprobedScenario(), '--group', 'C', '--out', tmp(), '--stamp', 'S', '--probes', '--dry-run'], { fetch, env: {} });
    expect(dropped.code).toBe(0);
    expect(dropped.err).toMatch(/--probe-groups: A, D, E not in this run/);
    // No fact with a probe: a note.
    expect(dropped.err).toMatch(/no fact in these scenarios has a probe/);
    const noKey = await run([...base, '--probes', '--max-cost', '1'], { fetch, env: {} });
    expect(noKey.code).toBe(2);
    expect(noKey.err).toMatch(/ANTHROPIC_API_KEY is not set/);
    expect(bodies).toHaveLength(0);
    expect(readdirSync(out)).toEqual([]);
  });

  test('BENCH_PROXY_INJECTS_API_KEY=1 sends a placeholder key when ANTHROPIC_API_KEY is absent', async () => {
    const path = probeScenario();
    const out = tmp();
    const { fetch, bodies } = stubFetch();
    const r = await run(['run', '--scenario', path, '--group', 'A', '--out', out, '--stamp', 'S', '--probes', '--max-cost', '1', '--max-probes', '1'],
      { fetch, env: { BENCH_PROXY_INJECTS_API_KEY: '1' } });
    expect(r.code, r.err).toBe(0);
    // One control probe (--max-probes caps it too) and one group probe.
    expect(bodies).toHaveLength(2);
    expect(bodies.every(b => b.headers['x-api-key'] === 'proxy-injected')).toBe(true);
  });
});

describe('bench cli: openai-compatible probes', () => {
  const KEY = 'sk-deepseek-TOPSECRETKEYVALUE';
  const BASE = 'https://api.deepseek.com/v1?token=URLSECRET';
  const scenario = (): string => {
    const s = JSON.parse(readFileSync(scenarioPath('flappy-bird'), 'utf8'));
    for (const f of s.facts) delete f.probe;
    s.facts[0].probe = { question: 'What hitbox size did the team agree?', expect: ['12x12'], reject: ['10x10'] };
    const path = join(tmp(), 'flappy-probes.json');
    writeFileSync(path, JSON.stringify(s));
    return path;
  };
  const stub = () => {
    const calls: { url: string; headers: Record<string, string>; body: { model: string; messages: { content: string }[] } }[] = [];
    const fetch = (async (url: unknown, init: RequestInit) => {
      calls.push({ url: String(url), headers: init.headers as Record<string, string>, body: JSON.parse(init.body as string) });
      return new Response(JSON.stringify({ choices: [{ message: { content: '12x12' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1000, completion_tokens: 5, prompt_cache_hit_tokens: 600, prompt_cache_miss_tokens: 400 } }), { status: 200 });
    }) as typeof globalThis.fetch;
    return { fetch, calls };
  };
  const base = (out: string) => ['run', '--scenario', scenario(), '--group', 'A', '--out', out, '--stamp', 'S', '--probes'];
  const oa = ['--provider', 'openai', '--base-url', BASE, '--model', 'deepseek-chat', '--api-key-env', 'DEEPSEEK_API_KEY', '--price', '0.28,0.028,0.42'];

  test('a real run: bearer key, usage and cost from the user price, only the host recorded, key and URL query nowhere', async () => {
    const out = tmp();
    const { fetch, calls } = stub();
    const r = await run([...base(out), ...oa, '--max-cost', '1'], { fetch, env: { DEEPSEEK_API_KEY: KEY }, sleep: async () => {} });
    expect(r.code, r.err).toBe(0);
    expect(calls.length).toBeGreaterThan(0);
    expect(calls[0]!.url).toBe('https://api.deepseek.com/v1/chat/completions?token=URLSECRET');
    expect(calls[0]!.headers.authorization).toBe(`Bearer ${KEY}`);
    expect(calls[0]!.body.model).toBe('deepseek-chat');
    const dir = join(out, 'S');
    const json = JSON.parse(readFileSync(join(dir, 'results.json'), 'utf8'));
    expect(json.probes.provider).toBe('openai');
    expect(json.probes.baseUrlHost).toBe('api.deepseek.com');
    expect(json.probes.usage.cacheWriteTokens).toBe(0);
    expect(json.probes.cost).toBeCloseTo(calls.length * (400 * 0.28 + 600 * 0.028 + 5 * 0.42) / 1e6, 10);
    const report = readFileSync(join(dir, 'report.md'), 'utf8');
    expect(report).toContain('Provider openai-compatible (host api.deepseek.com)');
    expect(report).toContain('the user is responsible');
    for (const f of readdirSync(dir)) {
      const text = readFileSync(join(dir, f), 'utf8');
      expect(text, f).not.toContain(KEY);
      expect(text, f).not.toContain('URLSECRET');
      expect(text, f).not.toContain('/v1');
    }
    expect(r.out + r.err).not.toContain(KEY);
  });

  test('no key variable: one stderr note naming it, and no Authorization header', async () => {
    const { fetch, calls } = stub();
    const r = await run([...base(tmp()), ...oa, '--max-cost', '1'], { fetch, env: {}, sleep: async () => {} });
    expect(r.code, r.err).toBe(0);
    expect(r.err.match(/DEEPSEEK_API_KEY is not set/g)).toHaveLength(1);
    expect(calls.length).toBeGreaterThan(0);
    expect(Object.keys(calls[0]!.headers).map(k => k.toLowerCase())).not.toContain('authorization');
  });

  test('a local server with zero prices; the default key variable is OPENAI_API_KEY', async () => {
    const { fetch, calls } = stub();
    const r = await run([...base(tmp()), '--provider', 'openai', '--base-url', 'http://localhost:11434/v1', '--model', 'qwen', '--price', '0,0,0', '--max-cost', '1'],
      { fetch, env: { OPENAI_API_KEY: KEY }, sleep: async () => {} });
    expect(r.code, r.err).toBe(0);
    expect(calls[0]!.url).toBe('http://localhost:11434/v1/chat/completions');
    expect(calls[0]!.headers.authorization).toBe(`Bearer ${KEY}`);
  });

  test('the dry run needs the openai flags, sends nothing, and records the host', async () => {
    const out = tmp();
    const { fetch, calls } = stub();
    const r = await run([...base(out), ...oa, '--dry-run'], { fetch, env: {} });
    expect(r.code, r.err).toBe(0);
    expect(calls).toHaveLength(0);
    const est = JSON.parse(readFileSync(join(out, 'S', 'probe-estimate.json'), 'utf8'));
    expect(est.baseUrlHost).toBe('api.deepseek.com');
    expect(JSON.stringify(est)).not.toContain('URLSECRET');
    expect(est.total.costHigh).toBeGreaterThanOrEqual(est.total.costLow);
  });

  test('usage errors exit 2 before any request', async () => {
    const { fetch, calls } = stub();
    const cases: { args: string[]; err: RegExp }[] = [
      { args: ['--price', '1,2,3', '--max-cost', '1'], err: /--price needs --provider openai/ },
      { args: ['--base-url', 'http://x', '--max-cost', '1'], err: /--base-url needs --provider openai/ },
      { args: ['--provider', 'openai', '--model', 'm', '--price', '1,1,1', '--max-cost', '1'], err: /needs --base-url/ },
      { args: ['--provider', 'openai', '--base-url', 'http://x', '--price', '1,1,1', '--max-cost', '1'], err: /needs --model/ },
      { args: ['--provider', 'openai', '--base-url', 'http://x', '--model', 'm', '--max-cost', '1'], err: /needs --price/ },
      { args: ['--provider', 'openai', '--base-url', 'ftp://x', '--model', 'm', '--price', '1,1,1', '--max-cost', '1'], err: /--base-url/ },
      { args: ['--provider', 'openai', '--base-url', 'http://x', '--model', 'm', '--price', '1,1', '--max-cost', '1'], err: /--price must be/ },
      { args: ['--provider', 'openai', '--base-url', 'http://x', '--model', 'm', '--price', '1,-1,1', '--max-cost', '1'], err: /--price must be/ },
      { args: ['--provider', 'openai', '--base-url', 'http://x', '--model', 'm', '--price', '1,x,1', '--max-cost', '1'], err: /--price must be/ },
      { args: ['--provider', 'openai', '--base-url', 'http://x', '--model', 'm', '--price', '1,,1', '--max-cost', '1'], err: /--price must be/ },
      { args: ['--provider', 'openai', '--base-url', 'http://x', '--model', 'm', '--price', '1,1,1'], err: /--max-cost/ },
      { args: ['--provider', 'nope', '--max-cost', '1'], err: /--provider must be/ },
    ];
    for (const c of cases) {
      const r = await run([...base(tmp()), ...c.args], { fetch, env: { OPENAI_API_KEY: KEY, ANTHROPIC_API_KEY: KEY } });
      expect(r.code, c.args.join(' ')).toBe(2);
      expect(r.err, c.args.join(' ')).toMatch(c.err);
    }
    expect(calls).toHaveLength(0);
    // The provider flags need --probes.
    const stray = await run(['run', '--scenario', 'flappy-bird', '--group', 'A', '--out', tmp(), '--provider', 'openai'], { fetch, env: {} });
    expect(stray.code).toBe(2);
    expect(stray.err).toMatch(/--provider needs --probes/);
  });

  test('a fatal status stops probing and is reported without the key', async () => {
    const out = tmp();
    let n = 0;
    const fetch = (async () => {
      n++;
      return new Response(JSON.stringify({ error: { message: `invalid key ${KEY}` } }), { status: 401 });
    }) as typeof globalThis.fetch;
    const r = await run([...base(out), ...oa, '--max-cost', '1'], { fetch, env: { DEEPSEEK_API_KEY: KEY }, sleep: async () => {} });
    expect(r.code, r.err).toBe(0);
    expect(n).toBe(1);
    const dir = join(out, 'S');
    for (const f of readdirSync(dir)) expect(readFileSync(join(dir, f), 'utf8'), f).not.toContain(KEY);
  });
});
