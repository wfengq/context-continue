import { defaultCountTokens } from '@context-continue/core';
import { ScriptedModel, type Model } from './model.js';
import { DEFAULT_IDLE_REPLY } from './scenario.js';
import { planLines } from './text.js';
import type { CallRecord, Group, PolicyStats, Scenario, Step, ToolCall } from './types.js';

/** The fixed instruction every group puts first in every request. */
export const BASE_TEMPLATE =
  'You are a member of a project team of humans and AI bots working toward one shared goal. ' +
  'Read the context below, do only the part of the work that is yours, use the tools when an action is needed, ' +
  'and reply concisely.';

export interface Segment {
  text: string;
  cacheable: boolean;
  /** Recorded in `CallRecord.segments` when present. */
  kind?: string;
}

export interface RunContext {
  scenario: Scenario;
  count(text: string): number;
  /**
   * Sends one request. Input tokens are the sum of the segments' token counts; cacheable tokens the
   * sum over cacheable segments. A scripted request passes the step's scripted output to the model.
   */
  call(a: { botId: string; step: number; kind: 'scripted' | 'extra'; segments: Segment[] }): Promise<{ reply: string; ops: ToolCall[] }>;
  /** True when waking `botId` at step `step` merges into step `step + 1`, which `botId` performs. */
  isMerged(botId: string, step: number): boolean;
  /** Who performs a step: the bot for `work`, the lead for `review`/`replan`, the owner for `human`. */
  actorOf(step: Step): string;
}

export interface Policy {
  group: Group;
  onStep(step: Step, index: number, ctx: RunContext): Promise<void>;
  finish(): Promise<PolicyStats>;
}

/**
 * The scripted model output of a step (R-B2, amended by R-L7): in a group chat the lead announces
 * what it decides, so a review's reply is its notes plus one `New convention: …` line per
 * convention, and a replan's reply is the new plan in the compact layout (`planLines`).
 */
export function scriptedOutput(step: Step, index: number): { reply: string; ops: ToolCall[] } {
  switch (step.kind) {
    case 'work':
      return { reply: step.reply, ops: step.ops ?? [] };
    case 'review':
      return {
        reply: [step.notes, ...(step.conventions ?? []).map(c => `New convention: ${c}`)].join('\n'),
        ops: [{
          name: 'submitReview',
          args: { deliverableOf: step.deliverableOf, passed: step.passed, notes: step.notes, conventions: step.conventions ?? [] },
        }],
      };
    case 'replan':
      return { reply: ['New plan:', ...planLines(step.plan)].join('\n'), ops: [{ name: 'proposePlan', args: { plan: step.plan } }] };
    case 'human':
      throw new Error(`step ${index}: a human step has no scripted output`);
  }
}

export async function runScenario(
  s: Scenario,
  policy: Policy,
  opts: { model?: Model } = {},
): Promise<{ records: CallRecord[]; stats: PolicyStats }> {
  const model = opts.model ?? new ScriptedModel(s.idleReply ?? DEFAULT_IDLE_REPLY);
  const records: CallRecord[] = [];
  const counted = new Map<string, number>();
  const count = (text: string): number => {
    let n = counted.get(text);
    if (n === undefined) {
      n = defaultCountTokens(text);
      counted.set(text, n);
    }
    return n;
  };
  const actorOf = (step: Step): string => {
    switch (step.kind) {
      case 'work':
        return step.botId;
      case 'review':
      case 'replan':
        return s.lead;
      case 'human':
        return s.owner;
    }
  };

  const ctx: RunContext = {
    scenario: s,
    count,
    actorOf,
    isMerged(botId, step) {
      const next = s.steps[step + 1];
      return next !== undefined && next.kind !== 'human' && actorOf(next) === botId;
    },
    async call({ botId, step, kind, segments }) {
      const current = s.steps[step];
      if (current === undefined) throw new Error(`step ${step}: no such step`);
      const scripted = kind === 'scripted' ? scriptedOutput(current, step) : null;
      let inputTokens = 0;
      let cacheableTokens = 0;
      const kinds: NonNullable<CallRecord['segments']> = [];
      for (const seg of segments) {
        const tokens = count(seg.text);
        inputTokens += tokens;
        if (seg.cacheable) cacheableTokens += tokens;
        if (seg.kind !== undefined) kinds.push({ kind: seg.kind, tokens, cacheable: seg.cacheable });
      }
      const record: CallRecord = { group: policy.group, scenario: s.id, step, botId, kind, inputTokens, cacheableTokens };
      if (kinds.length > 0) record.segments = kinds;
      if (kind === 'scripted' && s.facts !== undefined) {
        const full = segments.map(g => g.text).join('\n');
        const seen: string[] = [];
        const missed: string[] = [];
        for (const f of s.facts) {
          if (step <= f.step || !(f.audience.includes('*') || f.audience.includes(actorOf(current)))) continue;
          (full.includes(f.marker) ? seen : missed).push(f.id);
        }
        if (seen.length + missed.length > 0) {
          record.factsSeen = seen;
          record.factsMissed = missed;
        }
      }
      records.push(record);
      return model.complete({ botId, segments: segments.map(g => ({ text: g.text, cacheable: g.cacheable })), scripted });
    },
  };

  for (const [i, step] of s.steps.entries()) await policy.onStep(step, i, ctx);
  return { records, stats: await policy.finish() };
}
