import { describe, expect, test } from 'vitest';
import { ScriptedModel, type Model, type ModelRequest } from '../src/model.js';
import { BASE_TEMPLATE, runScenario, type Policy, type RunContext } from '../src/runner.js';
import { validateScenario } from '../src/scenario.js';
import { fmtBot, fmtDeliverable, fmtHuman, fmtOps, fmtTask, fmtTool } from '../src/text.js';
import type { Scenario, Step } from '../src/types.js';

const ws = (id: string, owner: string) => ({ id, title: id, brief: `do ${id}`, owner, dependsOn: [] as string[] });

function tiny(steps?: unknown[]): Scenario {
  return validateScenario({
    id: 'tiny', goal: 'g', constraints: [], owner: 'human', lead: 'pm',
    employees: [
      { botId: 'pm', persona: 'p', skills: [] },
      { botId: 'art', persona: 'p', skills: [] },
      { botId: 'logic', persona: 'p', skills: [] },
    ],
    plan: { workstreams: [ws('art', 'art'), ws('logic', 'logic')], contracts: [] },
    steps: steps ?? [
      { kind: 'human', text: 'hi' },
      { kind: 'work', botId: 'art', workstreamId: 'art', reply: 'done', ops: [{ name: 'submitDeliverable', args: { workstreamId: 'art', summary: 's', content: 'c' } }] },
    ],
  });
}

/** Sends one scripted request with fixed segments for every non-human step, acting as that step's actor. */
function recordingPolicy(segments: { text: string; cacheable: boolean; kind?: string }[]): Policy {
  return {
    group: 'A',
    async onStep(step: Step, index: number, ctx: RunContext) {
      if (step.kind === 'human') return;
      await ctx.call({ botId: ctx.actorOf(step), step: index, kind: 'scripted', segments });
    },
    async finish() { return { compactions: 0, pauses: 0, coreErrors: 0 }; },
  };
}

class SpyModel implements Model {
  requests: ModelRequest[] = [];
  async complete(r: ModelRequest) {
    this.requests.push(r);
    return r.scripted ?? { reply: 'idle', ops: [] };
  }
}

describe('text formats', () => {
  test('history line formats', () => {
    expect(fmtHuman('human', 'hi')).toBe('[human human] hi');
    expect(fmtBot('art', 'done')).toBe('[bot art] done');
    expect(fmtTool('art', 'submitDeliverable')).toBe('[tool art] submitDeliverable: ok');
    expect(fmtDeliverable('art', 2, 'body')).toBe('[deliverable art v2] body');
    expect(fmtDeliverable('art', 2, null)).toBe('[deliverable art v2 ref]');
    expect(fmtTask('solo', { kind: 'work', botId: 'art', workstreamId: 'art', reply: '' })).toBe('[task solo] work on workstream art');
    expect(fmtTask('pm', { kind: 'review', deliverableOf: 'art', passed: true, notes: '' })).toBe('[task pm] review the deliverable of art');
    expect(fmtTask('pm', { kind: 'replan', plan: { workstreams: [], contracts: [] } })).toBe('[task pm] replan');
  });
});

describe('fmtOps', () => {
  test('tool line per op, deliverable line with per-workstream version', () => {
    const versions = new Map<string, number>();
    const d = (content: string) => ({ name: 'submitDeliverable', args: { workstreamId: 'art', summary: 's', content } });
    expect(fmtOps('art', [d('one'), { name: 'updateNotes', args: { text: 'note' } }, d('two')], versions, false)).toEqual([
      '[tool art] submitDeliverable: ok', '[deliverable art v1] one',
      '[tool art] updateNotes: ok\n  text: note',
      '[tool art] submitDeliverable: ok', '[deliverable art v2] two',
    ]);
    expect(fmtOps('art', [d('three')], versions, true)).toEqual(['[tool art] submitDeliverable: ok', '[deliverable art v3 ref]']);
  });
  test('renders every call\'s arguments in a compact field layout; args can be left out', () => {
    const rf = { name: 'recordFailure', args: { text: 'Tried X', reason: 'slow', affects: ['a', 'b'] } };
    expect(fmtOps('bot', [rf], new Map(), false)).toEqual(['[tool bot] recordFailure: ok\n  tried: Tried X\n  why it failed: slow\n  affects: a, b']);
    expect(fmtOps('bot', [rf], new Map(), false, false)).toEqual(['[tool bot] recordFailure: ok']);
    const review = { name: 'submitReview', args: { deliverableOf: 'w', passed: false, notes: 'Bad.', conventions: ['C1', 'C2'] } };
    expect(fmtOps('lead', [review], new Map(), false)).toEqual(['[tool lead] submitReview: ok\n  verdict: failed\n  notes: Bad.\n  conventions: C1; C2']);
    const msg = { name: 'sendMessage', args: { text: 'Hi', act: 'query', mentions: ['x'] } };
    expect(fmtOps('bot', [msg], new Map(), false)).toEqual(['[tool bot] sendMessage: ok\n  to: x\n  act: query\n  text: Hi']);
  });
  test('throws on malformed submitDeliverable args', () => {
    expect(() => fmtOps('art', [{ name: 'submitDeliverable', args: { workstreamId: 'art', content: 'c' } }], new Map(), false))
      .toThrow(/malformed submitDeliverable/);
  });
});

describe('ScriptedModel', () => {
  test('returns scripted output or idleReply', async () => {
    const m = new ScriptedModel('Noted.');
    const ops = [{ name: 'submitDeliverable', args: { a: 1 } }];
    expect(await m.complete({ botId: 'x', segments: [], scripted: { reply: 'r', ops } })).toEqual({ reply: 'r', ops });
    expect(await m.complete({ botId: 'x', segments: [], scripted: null })).toEqual({ reply: 'Noted.', ops: [] });
  });
});

describe('runScenario', () => {
  test('BASE_TEMPLATE is a fixed English instruction', () => {
    expect(BASE_TEMPLATE).toMatch(/^You are a member of a project team/);
    expect(BASE_TEMPLATE).toMatch(/reply concisely/);
  });

  test('call records tokens, cacheable sum and segment kinds', async () => {
    // 'aaaa' = 1 token, 'bbbbbbbb' = 2 tokens (ASCII: ceil(len/4)).
    const { records } = await runScenario(tiny(), recordingPolicy([{ text: 'aaaa', cacheable: true }, { text: 'bbbbbbbb', cacheable: false }]));
    expect(records).toHaveLength(1);
    expect(records[0]).toEqual({ group: 'A', scenario: 'tiny', step: 1, botId: 'art', kind: 'scripted', inputTokens: 3, cacheableTokens: 1 });

    const kinds = await runScenario(tiny(), recordingPolicy([
      { text: 'aaaa', cacheable: true, kind: 'common' },
      { text: 'zz', cacheable: false },
      { text: 'bbbbbbbbb', cacheable: false, kind: 'delta' },
    ]));
    // 'zz' = 1, 'bbbbbbbbb' (9 chars) = 3.
    expect(kinds.records[0]).toMatchObject({ inputTokens: 5, cacheableTokens: 1 });
    expect(kinds.records[0]!.segments).toEqual([
      { kind: 'common', tokens: 1, cacheable: true },
      { kind: 'delta', tokens: 3, cacheable: false },
    ]);
  });

  test('scripted call passes the work step reply/ops; extra call passes null and gets idleReply', async () => {
    const spy = new SpyModel();
    const out: unknown[] = [];
    const policy: Policy = {
      group: 'B',
      async onStep(step, i, ctx) {
        if (step.kind !== 'work') return;
        out.push(await ctx.call({ botId: 'pm', step: i, kind: 'extra', segments: [{ text: 'x', cacheable: false }] }));
        out.push(await ctx.call({ botId: 'art', step: i, kind: 'scripted', segments: [{ text: 'x', cacheable: false }] }));
      },
      async finish() { return { compactions: 1, pauses: 2, coreErrors: 3 }; },
    };
    const { records, stats } = await runScenario(tiny(), policy, { model: spy });
    expect(stats).toEqual({ compactions: 1, pauses: 2, coreErrors: 3 });
    expect(records.map(r => [r.group, r.botId, r.kind])).toEqual([['B', 'pm', 'extra'], ['B', 'art', 'scripted']]);
    expect(spy.requests.map(r => r.scripted)).toEqual([
      null,
      { reply: 'done', ops: [{ name: 'submitDeliverable', args: { workstreamId: 'art', summary: 's', content: 'c' } }] },
    ]);
    expect(spy.requests[0]).toEqual({ botId: 'pm', segments: [{ text: 'x', cacheable: false }], scripted: null });
    expect(out[0]).toEqual({ reply: 'idle', ops: [] });
  });

  test('default model answers extra calls with the scenario idleReply', async () => {
    const out: unknown[] = [];
    const policy: Policy = {
      group: 'B',
      async onStep(step, i, ctx) {
        if (step.kind === 'human') out.push(await ctx.call({ botId: 'pm', step: i, kind: 'extra', segments: [] }));
      },
      async finish() { return { compactions: 0, pauses: 0, coreErrors: 0 }; },
    };
    const s = { ...tiny(), idleReply: 'Ok then.' };
    await runScenario(s, policy);
    expect(out).toEqual([{ reply: 'Ok then.', ops: [] }]);
  });

  test('scripted output for review and replan steps', async () => {
    const plan = { workstreams: [ws('art', 'art')], contracts: [] };
    const s = tiny([
      { kind: 'review', deliverableOf: 'art', passed: false, notes: 'Too dark.', conventions: ['use palette P'] },
      { kind: 'review', deliverableOf: 'logic', passed: true, notes: 'Fine.' },
      { kind: 'replan', plan },
    ]);
    const spy = new SpyModel();
    await runScenario(s, recordingPolicy([]), { model: spy });
    expect(spy.requests.map(r => [r.botId, r.scripted])).toEqual([
      ['pm', { reply: 'Too dark.', ops: [{ name: 'submitReview', args: { deliverableOf: 'art', passed: false, notes: 'Too dark.', conventions: ['use palette P'] } }] }],
      ['pm', { reply: 'Fine.', ops: [{ name: 'submitReview', args: { deliverableOf: 'logic', passed: true, notes: 'Fine.', conventions: [] } }] }],
      ['pm', { reply: 'Replanning.', ops: [{ name: 'proposePlan', args: { plan } }] }],
    ]);
  });

  test('work step without ops gives an empty ops list', async () => {
    const spy = new SpyModel();
    await runScenario(tiny([{ kind: 'work', botId: 'logic', workstreamId: 'logic', reply: 'r' }]), recordingPolicy([]), { model: spy });
    expect(spy.requests[0]!.scripted).toEqual({ reply: 'r', ops: [] });
  });

  test('scripted call on a human step is an error', async () => {
    const policy: Policy = {
      group: 'A',
      async onStep(_step, i, ctx) { await ctx.call({ botId: 'pm', step: i, kind: 'scripted', segments: [] }); },
      async finish() { return { compactions: 0, pauses: 0, coreErrors: 0 }; },
    };
    await expect(runScenario(tiny([{ kind: 'human', text: 'hi' }]), policy)).rejects.toThrow(/step 0/);
  });

  test('steps are driven in order, human steps included', async () => {
    const seen: [string, number][] = [];
    const policy: Policy = {
      group: 'A',
      async onStep(step, i) { seen.push([step.kind, i]); },
      async finish() { return { compactions: 0, pauses: 0, coreErrors: 0 }; },
    };
    await runScenario(tiny(), policy);
    expect(seen).toEqual([['human', 0], ['work', 1]]);
  });

  test('actorOf: work → its bot, review/replan → lead', async () => {
    let ctx!: RunContext;
    const policy: Policy = {
      group: 'A',
      async onStep(_s, _i, c) { ctx = c; },
      async finish() { return { compactions: 0, pauses: 0, coreErrors: 0 }; },
    };
    await runScenario(tiny(), policy);
    expect(ctx.actorOf({ kind: 'work', botId: 'art', workstreamId: 'art', reply: '' })).toBe('art');
    expect(ctx.actorOf({ kind: 'review', deliverableOf: 'art', passed: true, notes: '' })).toBe('pm');
    expect(ctx.actorOf({ kind: 'replan', plan: { workstreams: [], contracts: [] } })).toBe('pm');
    expect(ctx.count('aaaaa')).toBe(2);
  });

  test('isMerged is true only when the next step is that bot acting', async () => {
    const s = tiny([
      { kind: 'human', text: 'hi' },                                            // 0
      { kind: 'work', botId: 'art', workstreamId: 'art', reply: 'a' },          // 1
      { kind: 'review', deliverableOf: 'art', passed: true, notes: 'ok' },      // 2
      { kind: 'human', text: 'more' },                                          // 3
      { kind: 'replan', plan: { workstreams: [ws('art', 'art')], contracts: [] } }, // 4
    ]);
    let ctx!: RunContext;
    const policy: Policy = {
      group: 'A',
      async onStep(_s, _i, c) { ctx = c; },
      async finish() { return { compactions: 0, pauses: 0, coreErrors: 0 }; },
    };
    await runScenario(s, policy);
    expect(ctx.isMerged('art', 0)).toBe(true);    // step 1 is art's work
    expect(ctx.isMerged('pm', 0)).toBe(false);
    expect(ctx.isMerged('pm', 1)).toBe(true);     // step 2 review → lead
    expect(ctx.isMerged('art', 1)).toBe(false);
    expect(ctx.isMerged('pm', 2)).toBe(false);    // step 3 is human
    expect(ctx.isMerged('human', 2)).toBe(false);
    expect(ctx.isMerged('pm', 3)).toBe(true);     // step 4 replan → lead
    expect(ctx.isMerged('pm', 4)).toBe(false);    // no next step
  });
});

describe('fact visibility per request', () => {
  const factsScenario = (audience: string[] = ['*'], extraFacts: unknown[] = []) => validateScenario({
    ...tiny([
      { kind: 'human', text: 'Rule: MAX-5MB-UPLOAD applies. ZZZ' },
      { kind: 'work', botId: 'art', workstreamId: 'art', reply: 'ok', ops: [] },
      { kind: 'work', botId: 'logic', workstreamId: 'logic', reply: 'ok2', ops: [] },
    ]),
    facts: [{ id: 'conv-1', marker: 'MAX-5MB-UPLOAD', step: 0, audience }, ...extraFacts],
  });
  const withCtx = (hasMarker: boolean): Policy => ({
    group: 'A',
    async onStep(step: Step, index: number, ctx: RunContext) {
      if (step.kind === 'human') return;
      const text = hasMarker ? 'history MAX-5MB-UPLOAD' : 'history';
      await ctx.call({ botId: ctx.actorOf(step), step: index, kind: 'scripted', segments: [{ text: 'a', cacheable: true }, { text, cacheable: false }] });
    },
    async finish() { return { compactions: 0, pauses: 0, coreErrors: 0 }; },
  });

  test('a scripted request after a fact step records it seen when the marker is in its context', async () => {
    const { records } = await runScenario(factsScenario(), withCtx(true));
    expect(records.map(r => r.factsSeen)).toEqual([['conv-1'], ['conv-1']]);
    expect(records.map(r => r.factsMissed)).toEqual([[], []]);
  });

  test('a request whose context lacks the marker records it missed', async () => {
    const { records } = await runScenario(factsScenario(), withCtx(false));
    expect(records.map(r => r.factsSeen)).toEqual([[], []]);
    expect(records.map(r => r.factsMissed)).toEqual([['conv-1'], ['conv-1']]);
  });

  test('extra requests and requests at or before the fact step carry no fact fields', async () => {
    const s = validateScenario({
      ...tiny([
        { kind: 'work', botId: 'art', workstreamId: 'art', reply: 'MAX-5MB-UPLOAD here', ops: [] },
        { kind: 'work', botId: 'logic', workstreamId: 'logic', reply: 'ok', ops: [] },
      ]),
      facts: [{ id: 'conv-1', marker: 'MAX-5MB-UPLOAD', step: 0, audience: ['*'] }],
    });
    const policy: Policy = {
      group: 'A',
      async onStep(step: Step, index: number, ctx: RunContext) {
        if (step.kind === 'human') return;
        const segments = [{ text: 'MAX-5MB-UPLOAD', cacheable: false }];
        await ctx.call({ botId: ctx.actorOf(step), step: index, kind: 'scripted', segments });
        await ctx.call({ botId: 'art', step: index, kind: 'extra', segments });
      },
      async finish() { return { compactions: 0, pauses: 0, coreErrors: 0 }; },
    };
    const { records } = await runScenario(s, policy);
    expect(records.map(r => [r.kind, r.step, r.factsSeen])).toEqual([
      ['scripted', 0, undefined], ['extra', 0, undefined], ['scripted', 1, ['conv-1']], ['extra', 1, undefined],
    ]);
    expect('factsMissed' in records[0]!).toBe(false);
    expect('factsSeen' in records[1]!).toBe(false);
  });

  test('facts for other audiences are not opportunities', async () => {
    const { records } = await runScenario(factsScenario(['logic']), withCtx(false));
    expect(records.map(r => r.factsMissed)).toEqual([undefined, ['conv-1']]);
    expect('factsSeen' in records[0]!).toBe(false);
  });

  test('fields follow scenario fact order', async () => {
    const s = factsScenario(['*'], [{ id: 'fail-1', marker: 'ZZZ', step: 0, audience: ['*'] }]);
    const policy: Policy = {
      group: 'A',
      async onStep(step: Step, index: number, ctx: RunContext) {
        if (step.kind === 'human') return;
        await ctx.call({ botId: ctx.actorOf(step), step: index, kind: 'scripted', segments: [{ text: 'ZZZ', cacheable: false }, { text: 'MAX-5MB-UPLOAD', cacheable: false }] });
      },
      async finish() { return { compactions: 0, pauses: 0, coreErrors: 0 }; },
    };

    const { records } = await runScenario({ ...s, facts: s.facts }, policy);
    expect(records[0]!.factsSeen).toEqual(['conv-1', 'fail-1']);
  });

  test('audience is matched on the step actor, not the request botId', async () => {
    const policy: Policy = {
      group: 'A',
      async onStep(step: Step, index: number, ctx: RunContext) {
        if (step.kind === 'human') return;
        await ctx.call({ botId: 'solo', step: index, kind: 'scripted', segments: [{ text: 'MAX-5MB-UPLOAD', cacheable: false }] });
      },
      async finish() { return { compactions: 0, pauses: 0, coreErrors: 0 }; },
    };
    const { records } = await runScenario(factsScenario(['logic']), policy);
    expect(records.map(r => r.factsSeen)).toEqual([undefined, ['conv-1']]);
  });

  test('a marker does not match across a segment boundary', async () => {
    const policy: Policy = {
      group: 'A',
      async onStep(step: Step, index: number, ctx: RunContext) {
        if (step.kind === 'human') return;
        await ctx.call({ botId: ctx.actorOf(step), step: index, kind: 'scripted', segments: [{ text: 'MAX-5MB-', cacheable: false }, { text: 'UPLOAD', cacheable: false }] });
      },
      async finish() { return { compactions: 0, pauses: 0, coreErrors: 0 }; },
    };
    const { records } = await runScenario(factsScenario(), policy);
    expect(records[0]!.factsMissed).toEqual(['conv-1']);
  });
});
