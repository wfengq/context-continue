import { describe, expect, test } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Model, ModelRequest } from '../src/model.js';
import { createPolicy, type PolicyOptions } from '../src/policies/index.js';
import { gradeAnswer, probeQuestion, scheduleProbes } from '../src/probe.js';
import { runScenario, type Policy, type RunContext } from '../src/runner.js';
import { validateScenario } from '../src/scenario.js';
import type { Group, Scenario, Step } from '../src/types.js';

const ws = (id: string, owner: string) => ({ id, title: id, brief: `do ${id}`, owner, dependsOn: [] as string[] });
const work = (botId: string, reply: string) => ({ kind: 'work', botId, workstreamId: botId, reply });

/** 0 human (fact), then alternating art / logic work steps; art's requests are at 1,3,5,7,9. */
function scenario(facts?: unknown[], extraSteps = 0): Scenario {
  const steps: unknown[] = [{ kind: 'human', text: 'Board is 12×12 now (CHANGE-BOARD), was 10x10.' }];
  for (let i = 0; i < 10 + extraSteps; i++) steps.push(work(i % 2 === 0 ? 'art' : 'logic', `r${i}`));
  return validateScenario({
    id: 'p', goal: 'g', constraints: [], owner: 'human', lead: 'pm',
    employees: ['pm', 'art', 'logic'].map(botId => ({ botId, persona: 'p', skills: [] })),
    plan: { workstreams: [ws('art', 'art'), ws('logic', 'logic')], contracts: [] },
    steps,
    facts: facts ?? [{
      id: 'change-board', marker: 'CHANGE-BOARD', step: 0, audience: ['art'],
      probe: { question: 'What is the board size?', expect: ['12x12'], reject: ['10x10'] },
    }],
  });
}

/** Answers with the first expect string present in the context, else the first reject string present, else "unknown". */
class ContextModel implements Model {
  requests: ModelRequest[] = [];
  constructor(private readonly s: Scenario) {}
  async complete(r: ModelRequest) {
    this.requests.push(r);
    for (const f of this.s.facts ?? []) {
      if (!f.probe || !r.segments[r.segments.length - 1]!.text.includes(f.probe.question)) continue;
      const context = r.segments.slice(0, -1).map(g => g.text).join('\n').replace(/×/g, 'x');
      const hit = f.probe.expect.find(e => context.includes(e)) ?? f.probe.reject?.find(e => context.includes(e));
      return { reply: hit ?? 'unknown', ops: [] };
    }
    return { reply: 'unknown', ops: [] };
  }
}

/** One scripted request per non-human step with fixed segments and the step index in the text. */
function fixedPolicy(): Policy {
  return {
    group: 'A',
    async onStep(step: Step, index: number, ctx: RunContext) {
      if (step.kind === 'human') return;
      await ctx.call({ botId: ctx.actorOf(step), step: index, kind: 'scripted', segments: [
        { text: 'base', cacheable: true, kind: 'template' },
        { text: `step ${index}`, cacheable: false },
      ] });
    },
    async finish() { return { compactions: 0, pauses: 0, coreErrors: 0 }; },
  };
}

describe('gradeAnswer', () => {
  const p = { question: 'q', expect: ['12x12', 'twelve by twelve'], reject: ['10x10'] };
  test('expect hit is correct, case-insensitive, × normalised, whitespace collapsed', () => {
    expect(gradeAnswer(p, 'The board is 12X12.')).toBe('correct');
    expect(gradeAnswer(p, 'It is 12×12')).toBe('correct');
    expect(gradeAnswer(p, 'Twelve   by\ntwelve')).toBe('correct');
    expect(gradeAnswer(p, '12 x 12')).toBe('correct');
  });
  test('reject hit is stale, even when an expect string also appears', () => {
    expect(gradeAnswer(p, '10x10')).toBe('stale');
    expect(gradeAnswer(p, 'It was 10 × 10, now 12x12')).toBe('stale');
  });
  test('neither is wrong', () => {
    expect(gradeAnswer(p, 'unknown')).toBe('wrong');
    expect(gradeAnswer({ question: 'q', expect: ['eu-central-1'] }, 'us-east-1')).toBe('wrong');
  });
  test('expect strings with × match answers with x', () => {
    expect(gradeAnswer({ question: 'q', expect: ['12×12'] }, '12x12')).toBe('correct');
  });
});

describe('probe validation', () => {
  const withProbe = (probe: unknown) => () => scenario([{ id: 'change-board', marker: 'CHANGE-BOARD', step: 0, audience: ['art'], probe }]);
  test('accepts a valid probe and keeps it', () => {
    expect(scenario().facts![0]!.probe).toEqual({ question: 'What is the board size?', expect: ['12x12'], reject: ['10x10'] });
  });
  test('rejects empty question, empty expect, blank strings', () => {
    expect(withProbe({ question: '', expect: ['a'] })).toThrow(/question/);
    expect(withProbe({ question: 'q', expect: [] })).toThrow(/expect/);
    expect(withProbe({ question: 'q', expect: [' '] })).toThrow(/expect/);
    expect(withProbe({ question: 'q', expect: ['a'], reject: [''] })).toThrow(/reject/);
  });
  test('rejects a reject string contained in an expect string', () => {
    expect(withProbe({ question: 'q', expect: ['12x12'], reject: ['12'] })).toThrow(/reject "12" is contained in expect "12x12"/);
  });
});

describe('scheduleProbes', () => {
  test('first / middle / last opportunity by default', () => {
    // art's opportunities: steps 1,3,5,7,9 -> first 1, middle 5, last 9
    expect(scheduleProbes(scenario())).toEqual([
      { factId: 'change-board', step: 9 }, { factId: 'change-board', step: 1 }, { factId: 'change-board', step: 5 },
    ]);
  });
  test("'all' and a number of evenly spaced samples", () => {
    expect(scheduleProbes(scenario(), { samples: 'all' }).map(p => p.step).sort((a, b) => a - b)).toEqual([1, 3, 5, 7, 9]);
    expect(scheduleProbes(scenario(), { samples: 1 }).map(p => p.step)).toEqual([9]);
    expect(scheduleProbes(scenario(), { samples: 2 }).map(p => p.step).sort((a, b) => a - b)).toEqual([1, 9]);
  });
  test('dedupes when there are few opportunities', () => {
    const s = scenario([{ id: 'change-board', marker: 'CHANGE-BOARD', step: 0, audience: ['art'], probe: { question: 'q', expect: ['12x12'] } }], -8);
    // steps: 0 human, 1 art, 2 logic -> one opportunity
    expect(scheduleProbes(s).map(p => p.step)).toEqual([1]);
  });
  test('facts without a probe or without opportunities are skipped', () => {
    const s = scenario([
      { id: 'change-board', marker: 'CHANGE-BOARD', step: 0, audience: ['art'] },
      { id: 'conv-x', marker: 'r9', step: 10, audience: ['art'], probe: { question: 'q', expect: ['a'] } },
    ]);
    expect(scheduleProbes(s)).toEqual([]);
  });
  test('the cap keeps a round-robin over facts: every last sample, then every first, then middles', () => {
    const s = scenario([
      { id: 'change-board', marker: 'CHANGE-BOARD', step: 0, audience: ['art'], probe: { question: 'q1', expect: ['12x12'] } },
      { id: 'conv-y', marker: 'r1', step: 2, audience: ['logic'], probe: { question: 'q2', expect: ['r1'] } },
    ]);
    // logic opportunities after step 2: 4,6,8,10
    expect(scheduleProbes(s, { maxPerScenario: 3 })).toEqual([
      { factId: 'change-board', step: 9 }, { factId: 'conv-y', step: 10 }, { factId: 'change-board', step: 1 },
    ]);
    expect(scheduleProbes(s, { maxPerScenario: 0 })).toEqual([]);
  });
  test('"*" audience uses every requester', () => {
    const s = scenario([{ id: 'change-board', marker: 'CHANGE-BOARD', step: 0, audience: ['*'], probe: { question: 'q', expect: ['12x12'] } }]);
    expect(scheduleProbes(s, { samples: 'all' }).length).toBe(10);
  });
});

describe('runScenario with probes', () => {
  test('a probe is the scripted request plus a question segment, sent after it to the probe model', async () => {
    const s = scenario();
    const main: ModelRequest[] = [];
    const order: string[] = [];
    const mainModel: Model = { async complete(r) { main.push(r); order.push(`main ${r.segments[1]!.text}`); return r.scripted ?? { reply: 'idle', ops: [] }; } };
    const probeModel: Model = { async complete(r) { order.push(`probe ${r.segments[1]!.text}`); return { reply: 'It is 12×12', ops: [] }; } };
    const run = await runScenario(s, fixedPolicy(), { model: mainModel, probe: { model: probeModel } });
    expect(order.slice(0, 3)).toEqual(['main step 1', 'probe step 1', 'main step 2']);
    expect(run.probes).toEqual([1, 5, 9].map(step => ({
      group: 'A', scenario: 'p', step, botId: 'art', factId: 'change-board', question: 'What is the board size?',
      answer: 'It is 12×12', verdict: 'correct',
      inputTokens: expect.any(Number), cacheableTokens: expect.any(Number),
    })));
    const p = run.probes![0]!;
    const rec = run.records.find(r => r.step === 1)!;
    expect(p.cacheableTokens).toBe(rec.cacheableTokens);
    expect(p.inputTokens).toBeGreaterThan(rec.inputTokens);
    // the main model never sees probe requests
    expect(main.length).toBe(10);
  });

  test('probe request segments are exactly the scripted segments plus the question', async () => {
    const s = scenario();
    const seen: ModelRequest[] = [];
    const scriptedSeen: ModelRequest[] = [];
    await runScenario(s, fixedPolicy(), {
      model: { async complete(r) { scriptedSeen.push(r); return r.scripted ?? { reply: '', ops: [] }; } },
      probe: { model: { async complete(r) { seen.push(r); return { reply: 'x', ops: [] }; } } },
    });
    const at1 = scriptedSeen.find(r => r.segments[1]!.text === 'step 1')!;
    expect(seen[0]).toEqual({
      botId: 'art', scripted: null,
      segments: [...at1.segments, { text: probeQuestion('What is the board size?'), cacheable: false }],
    });
    expect(probeQuestion('Q?')).toBe('Question: Q?\nAnswer briefly.');
  });

  test('records and stats are identical with and without probes, for every group', async () => {
    const s = scenario([
      { id: 'change-board', marker: 'CHANGE-BOARD', step: 0, audience: ['*'], probe: { question: 'What is the board size?', expect: ['12x12'], reject: ['10x10'] } },
    ]);
    const defaults: PolicyOptions = { window: 128000, compactRatio: 0.8, summaryTokens: 1500 };
    const variants: [Group, PolicyOptions][] = [
      ...(['A', 'B', 'C', 'D', 'E', 'F'] as Group[]).map(g => [g, defaults] as [Group, PolicyOptions]),
      ['C', { ...defaults, coreStream: { mode: 'on', restreamTokens: 50000 } }],
      ['E', { ...defaults, window: 300, summaryTokens: 100 }],
    ];
    for (const [g, o] of variants) {
      const plain = await runScenario(s, createPolicy(g, o));
      const probed = await runScenario(s, createPolicy(g, o), { probe: { model: new ContextModel(s), samples: 'all' } });
      expect(JSON.stringify(probed.records)).toBe(JSON.stringify(plain.records));
      expect(probed.stats).toEqual(plain.stats);
      expect('probes' in plain).toBe(false);
      expect(probed.probes!.length).toBeGreaterThan(0);
      expect(probed.probes!.every(p => p.group === g)).toBe(true);
    }
  });

  test('each group is probed on its own context: verdicts follow what the context holds', async () => {
    const s = scenario();
    const run = await runScenario(s, fixedPolicy(), { probe: { model: new ContextModel(s) } });
    // fixed policy context never holds the fact
    expect(run.probes!.map(p => p.verdict)).toEqual(['wrong', 'wrong', 'wrong']);
    const a = await runScenario(s, createPolicy('A', { window: 128000, compactRatio: 0.8, summaryTokens: 1500 }), { probe: { model: new ContextModel(s) } });
    // group A keeps the whole history, which has "12×12" and "10x10": the context model answers 12x12
    expect(a.probes!.map(p => [p.step, p.verdict])).toEqual([[1, 'correct'], [5, 'correct'], [9, 'correct']]);
    expect(a.probes!.every(p => p.botId === 'solo')).toBe(true);
  });

  test('a stale answer is recorded as stale', async () => {
    const s = scenario();
    const run = await runScenario(s, fixedPolicy(), { probe: { model: { async complete() { return { reply: '10X10', ops: [] }; } } } });
    expect(run.probes!.map(p => p.verdict)).toEqual(['stale', 'stale', 'stale']);
  });

  test('probe usage reported by the probe model is kept', async () => {
    const s = scenario();
    const usage = { inputTokens: 10, cacheReadTokens: 5, cacheWriteTokens: 0, outputTokens: 3 };
    const run = await runScenario(s, fixedPolicy(), { probe: { model: { async complete() { return { reply: '12x12', ops: [], usage }; } }, maxPerScenario: 1 } });
    expect(run.probes).toHaveLength(1);
    expect(run.probes![0]!.usage).toEqual(usage);
  });
});

describe('real scenarios without probes', () => {
  test('outputs are unchanged: a probe-less run returns no probes field', async () => {
    const s = validateScenario(JSON.parse(readFileSync(join(import.meta.dirname, '../scenarios/flappy-bird.json'), 'utf8')));
    const run = await runScenario(s, createPolicy('C', { window: 128000, compactRatio: 0.8, summaryTokens: 1500 }));
    expect('probes' in run).toBe(false);
  });
});
