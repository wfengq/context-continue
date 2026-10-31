import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { main } from '../src/cli.js';

const tmp = () => mkdtempSync(join(tmpdir(), 'bench-cli-'));

/** Runs main with stderr captured. */
async function run(argv: string[]): Promise<{ code: number; err: string }> {
  let err = '';
  const spy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
    err += String(chunk);
    return true;
  });
  const quiet = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  try {
    return { code: await main(argv), err };
  } finally {
    spy.mockRestore();
    quiet.mockRestore();
  }
}

afterEach(() => vi.restoreAllMocks());

describe('bench cli', () => {
  test('cli writes results.json and report.md with six groups', async () => {
    const out = tmp();
    expect((await run(['run', '--scenario', 'all', '--group', 'all', '--out', out, '--stamp', 'T'])).code).toBe(0);
    const report = readFileSync(join(out, 'T', 'report.md'), 'utf8');
    for (const g of ['A', 'B', 'C', 'D', 'E', 'F']) expect(report).toMatch(new RegExp(`^\\| ${g} \\|`, 'm'));
    for (const id of ['product-plan', 'flappy-bird', 'event-plan']) expect(report).toContain(`## Scenario: ${id}`);
    const json = JSON.parse(readFileSync(join(out, 'T', 'results.json'), 'utf8'));
    expect(json.params).toEqual({ cacheRatio: 0.1, compactRatio: 0.8, summaryTokens: 1500, window: 128000 });
    expect(json.metrics).toHaveLength(18);
    expect(json.records.length).toBeGreaterThan(0);
  });

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

  test('two runs with the same stamp produce byte-identical files', async () => {
    const a = tmp();
    const b = tmp();
    for (const out of [a, b]) {
      expect((await run(['run', '--scenario', 'all', '--group', 'all', '--out', out, '--stamp', 'T'])).code).toBe(0);
    }
    for (const f of ['results.json', 'report.md']) {
      expect(readFileSync(join(a, 'T', f)).equals(readFileSync(join(b, 'T', f)))).toBe(true);
    }
  });

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
});
