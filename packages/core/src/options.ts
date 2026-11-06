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
  directivesKeep?: number; // newest human chat messages shown under Directives on the public board, default 20
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
  directivesKeep: 20,
});

/** Options that count items; a fraction would be meaningless. */
const INTEGER_OPTIONS: ReadonlySet<keyof Options> = new Set(['directivesKeep']);

/** Defaults filled in; throws INVALID_OP for a value that is not a finite positive number (an integer for counts like directivesKeep). */
export function resolveOptions(o?: Options): Required<Options> {
  const resolved: Required<Options> = { ...DEFAULT_OPTIONS };
  if (o) {
    for (const key of Object.keys(DEFAULT_OPTIONS) as (keyof Options)[]) {
      const v = o[key];
      if (v === undefined) continue;
      if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) {
        throw new ContextError('INVALID_OP', `Option ${key} must be a finite positive number, got ${String(v)}`);
      }
      if (INTEGER_OPTIONS.has(key) && !Number.isInteger(v)) {
        throw new ContextError('INVALID_OP', `Option ${key} must be an integer, got ${String(v)}`);
      }
      resolved[key] = v;
    }
  }
  return resolved;
}

// ---------------------------------------------------------------------------
// Long-project stream mode (spec 2026-11-06 §2.1)
// ---------------------------------------------------------------------------

export type StreamMode = 'off' | 'on' | 'auto';

export interface StreamOptions {
  /** `off` (default): every existing output unchanged. `on`: every bot gets a stream. `auto`: on once the ledger reaches `autoAfterEntries`. */
  mode?: StreamMode;
  /** Tokens appended after a snapshot before the next request restreams, default 8_000. */
  restreamTokens?: number;
  /** `auto`: ledger entries after which requests use the stream. Provisional default; chosen by the bench evaluation. */
  autoAfterEntries?: number;
  /** Human messages a snapshot shows in full (the newest); older ones are folded to 160 characters, default 40. */
  snapshotHumanKeep?: number;
}

export const DEFAULT_STREAM_OPTIONS: Readonly<Required<StreamOptions>> = Object.freeze({
  mode: 'off',
  restreamTokens: 8_000,
  autoAfterEntries: 400,
  snapshotHumanKeep: 40,
});

const STREAM_MODES: readonly StreamMode[] = ['off', 'on', 'auto'];
const STREAM_COUNTS = ['restreamTokens', 'autoAfterEntries', 'snapshotHumanKeep'] as const;

/** Defaults filled in; INVALID_OP for a non-object, an unknown mode or a count that is not a positive integer. Unknown keys are ignored. */
export function resolveStreamOptions(s?: StreamOptions): Required<StreamOptions> {
  const resolved: Required<StreamOptions> = { ...DEFAULT_STREAM_OPTIONS };
  if (s === undefined) return resolved;
  if (typeof s !== 'object' || s === null || Array.isArray(s)) {
    throw new ContextError('INVALID_OP', `stream must be an object, got ${String(s)}`);
  }
  if (s.mode !== undefined) {
    if (!STREAM_MODES.includes(s.mode)) throw new ContextError('INVALID_OP', `stream.mode must be one of ${STREAM_MODES.join(', ')}, got ${String(s.mode)}`);
    resolved.mode = s.mode;
  }
  for (const key of STREAM_COUNTS) {
    const v: unknown = s[key];
    if (v === undefined) continue;
    if (typeof v !== 'number' || !Number.isInteger(v) || v <= 0) {
      throw new ContextError('INVALID_OP', `stream.${key} must be a positive integer, got ${String(v)}`);
    }
    resolved[key] = v;
  }
  return resolved;
}
