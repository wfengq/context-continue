import { ContextError } from './errors.js';

export interface Options {
  extractEvery?: number; // default 10
  idleMs?: number; // default 60_000
  recentForRouter?: number; // default 5
  boardMaxTokens?: number; // default 3_000
  notesMaxTokens?: number; // default 2_000
  memoryMaxTokens?: number; // default 1_500
  maxBotTurnsPerHumanMessage?: number; // default 6
  maxReviewRounds?: number; // default 3
  maxPlanRejects?: number; // default 3
  maxPromotionsPerTurn?: number; // default 3
  maxHops?: number; // default 4
  recentKeep?: number; // recent segments kept by three-part condensing, default 5
  leadTimeoutMs?: number; // how long to wait for the lead before escalating to a human, default 600_000
}

export const DEFAULT_OPTIONS: Readonly<Required<Options>> = Object.freeze({
  extractEvery: 10,
  idleMs: 60_000,
  recentForRouter: 5,
  boardMaxTokens: 3_000,
  notesMaxTokens: 2_000,
  memoryMaxTokens: 1_500,
  maxBotTurnsPerHumanMessage: 6,
  maxReviewRounds: 3,
  maxPlanRejects: 3,
  maxPromotionsPerTurn: 3,
  maxHops: 4,
  recentKeep: 5,
  leadTimeoutMs: 600_000,
});

/** Defaults filled in; throws INVALID_OP for a value that is not a finite positive number. */
export function resolveOptions(o?: Options): Required<Options> {
  const resolved: Required<Options> = { ...DEFAULT_OPTIONS };
  if (o) {
    for (const key of Object.keys(DEFAULT_OPTIONS) as (keyof Options)[]) {
      const v = o[key];
      if (v === undefined) continue;
      if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) {
        throw new ContextError('INVALID_OP', `Option ${key} must be a finite positive number, got ${String(v)}`);
      }
      resolved[key] = v;
    }
  }
  return resolved;
}
