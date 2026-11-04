import { expect, test } from 'vitest';
import { resolveOptions, DEFAULT_OPTIONS } from '../src/options.js';
import { makeProject } from './helpers.js';

test('defaults match spec 6.1', () => {
  expect(DEFAULT_OPTIONS).toMatchObject({ extractEvery: 10, idleMs: 60_000, recentForRouter: 5, boardMaxTokens: 3_000,
    notesMaxTokens: 2_000, memoryMaxTokens: 1_500, maxBotTurnsPerHumanMessage: 6, maxReviewRounds: 3,
    maxPlanRejects: 3, maxPromotionsPerTurn: 3, maxHops: 4, recentKeep: 5, leadTimeoutMs: 600_000 });
  expect(resolveOptions({ maxHops: 2 }).maxHops).toBe(2);
});

test('DEFAULT_OPTIONS is frozen and resolveOptions returns a fresh copy', () => {
  expect(Object.isFrozen(DEFAULT_OPTIONS)).toBe(true);
  expect(() => {
    (DEFAULT_OPTIONS as { maxHops: number }).maxHops = 99;
  }).toThrow();
  const r = resolveOptions();
  r.maxHops = 1;
  expect(DEFAULT_OPTIONS.maxHops).toBe(4);
});

test('resolveOptions rejects non-finite or non-positive numbers with INVALID_OP', () => {
  for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, '3' as unknown as number]) {
    expect(() => resolveOptions({ maxHops: bad })).toThrow(expect.objectContaining({ code: 'INVALID_OP' }));
  }
  expect(() => resolveOptions({ leadTimeoutMs: -5 })).toThrow(/leadTimeoutMs/);
});

test('directivesKeep defaults to 20 and is validated like the other numeric options', () => {
  expect(DEFAULT_OPTIONS.directivesKeep).toBe(20);
  expect(resolveOptions({ directivesKeep: 3 }).directivesKeep).toBe(3);
  expect(() => resolveOptions({ directivesKeep: 0 })).toThrow(/directivesKeep/);
});

test('publicBoard rejects non-boolean switches', async () => {
  const bad: unknown[] = [
    { directives: 'yes' },
    { contracts: 1 },
    { failures: null },
    { unknown: true },
    'all',
    null,
    [],
  ];
  for (const publicBoard of bad) {
    await expect(makeProject({ publicBoard: publicBoard as never })).rejects.toThrow(
      expect.objectContaining({ code: 'INVALID_OP' }),
    );
  }
  await expect(makeProject({ publicBoard: { directives: true, contracts: false } })).resolves.toBeDefined();
});
