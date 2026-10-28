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

export const DEFAULT_OPTIONS: Required<Options> = {
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
};

export function resolveOptions(o?: Options): Required<Options> {
  const resolved: Required<Options> = { ...DEFAULT_OPTIONS };
  if (o) {
    for (const key of Object.keys(DEFAULT_OPTIONS) as (keyof Options)[]) {
      const v = o[key];
      if (v !== undefined) resolved[key] = v;
    }
  }
  return resolved;
}
