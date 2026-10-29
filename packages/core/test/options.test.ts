import { expect, test } from 'vitest';
import { resolveOptions, DEFAULT_OPTIONS } from '../src/options.js';

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
