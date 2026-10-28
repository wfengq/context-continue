import { expect, test } from 'vitest';
import { resolveOptions, DEFAULT_OPTIONS } from '../src/options.js';

test('defaults match spec 6.1', () => {
  expect(DEFAULT_OPTIONS).toMatchObject({ extractEvery: 10, idleMs: 60_000, recentForRouter: 5, boardMaxTokens: 3_000,
    notesMaxTokens: 2_000, memoryMaxTokens: 1_500, maxBotTurnsPerHumanMessage: 6, maxReviewRounds: 3,
    maxPlanRejects: 3, maxPromotionsPerTurn: 3, maxHops: 4, recentKeep: 5, leadTimeoutMs: 600_000 });
  expect(resolveOptions({ maxHops: 2 }).maxHops).toBe(2);
});
