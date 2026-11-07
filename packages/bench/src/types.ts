import type { PlanInput } from '@context-continue/core';

export type Group = 'A' | 'B' | 'C' | 'D' | 'E' | 'F';

export interface ToolCall {
  name: string;
  args: unknown;
}

export type Step =
  | { kind: 'human'; text: string; mentions?: string[] }
  | { kind: 'work'; botId: string; workstreamId: string; reply: string; ops?: ToolCall[] }
  | { kind: 'review'; deliverableOf: string; passed: boolean; notes: string; conventions?: string[] }
  | { kind: 'replan'; plan: PlanInput };

/** A key piece of information a scenario introduces at `step`; `marker` must appear in that step's text. */
export interface Fact {
  /** Prefix gives the category: change-, conv-, contract-, fail-. */
  id: string;
  /**
   * Must appear in the step's text. Markers introduced in op args are matched against
   * JSON.stringify(args), so they must not contain characters JSON escapes (quotes, backslashes, newlines).
   */
  marker: string;
  step: number;
  /** Employees who need to know it, or ["*"] for all of them. */
  audience: string[];
  /** Optional question for a real model (spec 2026-11-07-real-model-probes); graded by strings only. */
  probe?: FactProbe;
}

export interface FactProbe {
  question: string;
  /** The answer must contain one of these (case-insensitive, "×" read as "x", whitespace collapsed). */
  expect: string[];
  /** Old answers: containing one of these grades the answer 'stale', even when an expect string is also there. */
  reject?: string[];
}

export type ProbeVerdict = 'correct' | 'stale' | 'wrong';

/** Token usage a real model reports for one request; absent for fake models. */
export interface ModelUsage {
  inputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
}

/**
 * One probe request: the scripted request of `step` (its exact segments, as the group sent them)
 * plus a question segment, sent to the probe model after that request. Kept apart from CallRecord.
 */
export interface ProbeRecord {
  group: Group;
  scenario: string;
  step: number;
  /** The scripted request's botId (group A: its single agent). */
  botId: string;
  factId: string;
  question: string;
  answer: string;
  verdict: ProbeVerdict;
  /** Counted like CallRecord, including the uncached question segment. */
  inputTokens: number;
  cacheableTokens: number;
  usage?: ModelUsage;
}

/** 'standard' is 20–40 steps, 'long' 150–300, 'xlong' 1,000–1,500. */
export type Tier = 'standard' | 'long' | 'xlong';

export interface Scenario {
  id: string;
  /** Defaults to 'standard'. */
  tier?: Tier;
  goal: string;
  constraints: string[];
  owner: string;
  lead: string;
  employees: { botId: string; persona: string; skills: string[] }[];
  /** The core library's PlanInput; group A does not use it. */
  plan: PlanInput;
  /** Fixed reply for extra requests; defaults to "Noted.". */
  idleReply?: string;
  steps: Step[];
  facts?: Fact[];
}

export interface CallRecord {
  group: Group;
  scenario: string;
  step: number;
  botId: string;
  kind: 'scripted' | 'extra';
  inputTokens: number;
  /** Always <= inputTokens. */
  cacheableTokens: number;
  /** Adjacent segments with the same kind and cacheable flag are merged (tokens summed). */
  segments?: { kind: string; tokens: number; cacheable: boolean }[];
  /**
   * Scripted requests only, and only when the request has fact opportunities (the fact's audience
   * includes this bot or "*", and the request's step is after the fact's step): ids whose marker is
   * in the request's full text / is not. In scenario fact order; both omitted without opportunities.
   */
  factsSeen?: string[];
  factsMissed?: string[];
}

export interface PolicyStats {
  compactions: number;
  pauses: number;
  coreErrors: number;
  /** Group C only: a workstream of the approved plan was still not delivered after the last step. */
  unfinished?: boolean;
  /**
   * Group C only: tokens the core flags cacheable, summed over every request — what a provider that
   * caches the core's stable segments (not only an identical prefix) could cache. Report caveat only.
   */
  cacheableUpperBound?: number;
  /**
   * Group C on the core stream (`--c-stream core|auto`) only: the step of the first streamed request
   * (null when `auto` never switched on), the number of snapshot requests (each bot's first one
   * included), and the ledger size at the end of the run.
   */
  stream?: { fromStep: number | null; snapshots: number; ledgerEntries: number };
}
