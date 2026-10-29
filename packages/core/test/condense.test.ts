import { expect, test, vi } from 'vitest';
import { CONDENSE_INSTRUCTION, condenseSegments, type CondenseFn } from '../src/condense.js';

// Total is measured as count of pinned + condensed (if non-empty) + recent joined with '\n\n'.
const count = (s: string) => s.length;
const seg = (i: number) => `r${i}`.padEnd(5, '.');
const big = (n: number) => ({
  pinned: ['PIN'],
  condensed: 'old',
  recent: Array.from({ length: n }, (_, i) => seg(i)),
});

test('under budget returns state unchanged and never calls condense', async () => {
  const condense = vi.fn<CondenseFn>(async () => 'x');
  const state = big(2);
  const r = await condenseSegments(state, { maxTokens: 1000, recentKeep: 5, count, condense });
  expect(r).toEqual({ ok: true, state: big(2) });
  expect(condense).not.toHaveBeenCalled();
});

test('over budget: evicts all but the last recentKeep recent segments into the summary', async () => {
  const calls: unknown[] = [];
  const r = await condenseSegments(big(10), {
    maxTokens: 50,
    recentKeep: 5,
    count,
    condense: async i => {
      calls.push(i);
      return 'sum';
    },
  });
  expect(r).toMatchObject({ ok: true, state: { condensed: 'sum', recent: big(10).recent.slice(5) } });
  expect(calls).toHaveLength(1);
  expect(calls[0]).toEqual({ pinned: ['PIN'], condensed: 'old', evicted: big(10).recent.slice(0, 5) });
});

test('pinned items are never passed for rewriting and always kept', async () => {
  const r = await condenseSegments(big(10), {
    maxTokens: 50,
    recentKeep: 5,
    count,
    // A misbehaving condense that mutates the pinned array it was handed must not affect the result.
    condense: async i => {
      i.pinned.length = 0;
      i.pinned.push('HACKED');
      return 'sum';
    },
  });
  expect(r).toMatchObject({ ok: true, state: { pinned: ['PIN'] } });
});

test('still over budget shrinks recentKeep down to 1 before failing', async () => {
  const calls: { condensed: string; evicted: string[] }[] = [];
  const condense: CondenseFn = async i => {
    calls.push({ condensed: i.condensed, evicted: i.evicted });
    return 'sum';
  };
  const ok = await condenseSegments(big(10), { maxTokens: 30, recentKeep: 5, count, condense });
  expect(ok).toMatchObject({ ok: true, state: { recent: big(10).recent.slice(7) } });
  expect(calls.map(c => c.evicted.length)).toEqual([5, 6, 7]);
  // every retry starts from the ORIGINAL summary
  expect(calls.every(c => c.condensed === 'old')).toBe(true);

  calls.length = 0;
  const bad = await condenseSegments(big(10), { maxTokens: 12, recentKeep: 5, count, condense });
  expect(bad.ok).toBe(false);
  expect(calls.map(c => c.evicted.length)).toEqual([5, 6, 7, 8, 9]);
});

test('condense throwing or returning empty → ok:false and caller keeps the original', async () => {
  const state = big(10);
  const threw = vi.fn<CondenseFn>(async () => {
    throw new Error('model down');
  });
  const r1 = await condenseSegments(state, { maxTokens: 50, recentKeep: 5, count, condense: threw });
  expect(r1).toMatchObject({ ok: false });
  if (!r1.ok) expect(r1.reason).toContain('model down');
  expect(threw).toHaveBeenCalledTimes(1);

  for (const empty of ['', '   \n']) {
    const r2 = await condenseSegments(state, { maxTokens: 50, recentKeep: 5, count, condense: async () => empty });
    expect(r2.ok).toBe(false);
  }
  const r3 = await condenseSegments(state, {
    maxTokens: 50,
    recentKeep: 5,
    count,
    condense: (async () => 42) as unknown as CondenseFn,
  });
  expect(r3.ok).toBe(false);
  expect(state).toEqual(big(10));
});

test('no condense function: evicted segments are dropped and the old summary kept', async () => {
  const r = await condenseSegments(big(10), { maxTokens: 50, recentKeep: 5, count });
  expect(r).toEqual({ ok: true, state: { pinned: ['PIN'], condensed: 'old', recent: big(10).recent.slice(5) } });

  const empty = await condenseSegments({ ...big(10), condensed: '' }, { maxTokens: 50, recentKeep: 5, count });
  expect(empty).toMatchObject({ ok: true, state: { condensed: '' } });
});

test('pinned alone over budget → ok:false without calling condense', async () => {
  const condense = vi.fn<CondenseFn>(async () => 'sum');
  const r = await condenseSegments(
    { pinned: ['P'.repeat(40)], condensed: '', recent: ['a', 'b'] },
    { maxTokens: 20, recentKeep: 1, count, condense },
  );
  expect(r.ok).toBe(false);
  expect(condense).not.toHaveBeenCalled();
});

test('recent shorter than recentKeep still evicts what it can; nothing to evict fails', async () => {
  const r = await condenseSegments(big(3), { maxTokens: 28, recentKeep: 5, count, condense: async () => 'sum' });
  expect(r).toMatchObject({ ok: true, state: { recent: big(3).recent.slice(1) } });
  const one = await condenseSegments(big(1), { maxTokens: 5, recentKeep: 5, count, condense: async () => 'sum' });
  expect(one.ok).toBe(false);
});

test('CONDENSE_INSTRUCTION is a fixed non-empty English instruction', () => {
  expect(CONDENSE_INSTRUCTION.length).toBeGreaterThan(50);
  expect(CONDENSE_INSTRUCTION).toMatch(/pinned/i);
  expect(CONDENSE_INSTRUCTION).not.toMatch(/\{\{|\$\{/);
});
