import { describe, expect, test } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Model, ModelRequest } from '../src/model.js';
import { createPolicy, type PolicyOptions } from '../src/policies/index.js';
import { containsTerm, gradeAnswer, normaliseAnswer, probeErrorMessage, probeQuestion, ProbeStop, runControl, scheduleProbes } from '../src/probe.js';
import { runScenario, type Policy, type RunContext } from '../src/runner.js';
import { validateScenario } from '../src/scenario.js';
import type { Group, ProbeRecord, Scenario, Step } from '../src/types.js';

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
  test('matches need boundaries at alphanumeric edges', () => {
    expect(gradeAnswer({ question: 'q', expect: ['12x12'] }, '112x120')).toBe('wrong');
    expect(gradeAnswer({ question: 'q', expect: ['12x12'] }, '12x120')).toBe('wrong');
    expect(gradeAnswer({ question: 'q', expect: ['eu-central-1'] }, 'eu-central-10')).toBe('wrong');
    expect(gradeAnswer({ question: 'q', expect: ['eu-central-1'] }, 'Region: eu-central-1.')).toBe('correct');
    expect(gradeAnswer({ question: 'q', expect: ['12'] }, '1 2')).toBe('wrong');
    expect(gradeAnswer({ question: 'q', expect: ['12'] }, '(12)')).toBe('correct');
    // a later boundary-respecting occurrence still counts
    expect(gradeAnswer({ question: 'q', expect: ['12x12'] }, '112x12 or 12x12')).toBe('correct');
    expect(gradeAnswer({ question: 'q', expect: ['12x12'], reject: ['10x10'] }, '12x12, not 210x100')).toBe('correct');
  });
  test('CJK neighbours do not break a boundary', () => {
    expect(gradeAnswer({ question: 'q', expect: ['北京'] }, '在北京市')).toBe('correct');
    expect(gradeAnswer({ question: 'q', expect: ['12x12'] }, '盘面是12x12格')).toBe('correct');
    expect(gradeAnswer({ question: 'q', expect: ['とうきょう'] }, 'とうきょうと')).toBe('correct');
    expect(gradeAnswer({ question: 'q', expect: ['서울'] }, '서울시')).toBe('correct');
    expect(gradeAnswer({ question: 'q', expect: ['12x12'] }, '盘面是112x12格')).toBe('wrong');
  });
  test('expect strings with × match answers with x', () => {
    expect(gradeAnswer({ question: 'q', expect: ['12×12'] }, '12x12')).toBe('correct');
  });
});

describe('normalisation of hyphens, underscores and slashes', () => {
  test('"-", "_" and "/" read as a space, in answer and expect alike', () => {
    expect(normaliseAnswer('Last-Writer_Wins/Delete')).toBe('last writer wins delete');
    expect(containsTerm('the last-writer-wins rule', 'last writer wins')).toBe(true);
    expect(containsTerm('last writer wins', 'last-writer-wins')).toBe(true);
    expect(containsTerm('billing state is past_due', 'past due')).toBe(true);
    expect(containsTerm('billing state is past due', 'past_due')).toBe(true);
    expect(containsTerm('Given / When / Then', 'Given/When/Then')).toBe(true);
    expect(containsTerm('uses a 24 hour clock', '24-hour')).toBe(true);
    expect(containsTerm('every region is eu central 1', 'eu-central-1')).toBe(true);
  });
  test('boundaries still hold, and the 12x12 rule is unchanged', () => {
    expect(containsTerm('last-writer-winsome', 'last writer wins')).toBe(false);
    expect(containsTerm('the eu-central-10 region', 'eu-central-1')).toBe(false);
    expect(containsTerm('a 12 x 12 board', '12x12')).toBe(true);
    expect(containsTerm('a 12-12 board', '12x12')).toBe(false);
    expect(containsTerm('-', '/')).toBe(false);
  });
  test('gradeAnswer uses it for reject too', () => {
    const probe = { question: 'q', expect: ['cursor'], reject: ['page-based'] };
    expect(gradeAnswer(probe, 'cursor, not page based')).toBe('stale');
    expect(gradeAnswer(probe, 'Cursor-based paging')).toBe('correct');
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
  test('rejects a reject string contained (as a term) in an expect string', () => {
    expect(withProbe({ question: 'q', expect: ['12x12 grid'], reject: ['grid'] })).toThrow(/reject "grid" is contained in expect "12x12 grid"/);
    expect(withProbe({ question: 'q', expect: ['12x12'], reject: ['12'] })).not.toThrow();
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
  test('options are validated up front, even without probes', () => {
    const none = scenario([{ id: 'change-board', marker: 'CHANGE-BOARD', step: 0, audience: ['art'] }]);
    expect(() => scheduleProbes(none, { samples: 0 })).toThrow(/samples/);
    expect(() => scheduleProbes(none, { samples: 1.5 })).toThrow(/samples/);
    expect(() => scheduleProbes(none, { samples: 'x' as 'all' })).toThrow(/samples/);
    expect(() => scheduleProbes(none, { maxPerScenario: -1 })).toThrow(/maxPerScenario/);
    expect(() => scheduleProbes(none, { maxPerScenario: 0.5 })).toThrow(/maxPerScenario/);
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

describe('probe failures, stop and streaming', () => {
  test('a failing probe model is recorded as error with a masked, truncated message, and probing goes on', async () => {
    const s = scenario();
    let n = 0;
    const probeModel: Model = {
      async complete() {
        if (n++ === 0) throw new Error(`HTTP 500 x-api-key: sk-ant-secret123 ${'y'.repeat(500)}`);
        return { reply: '12x12', ops: [] };
      },
    };
    const plain = await runScenario(s, fixedPolicy());
    const run = await runScenario(s, fixedPolicy(), { probe: { model: probeModel } });
    expect(run.records).toEqual(plain.records);
    expect(run.probes!.map(p => p.verdict)).toEqual(['error', 'correct', 'correct']);
    const err = run.probes![0]!.error!;
    expect(err.length).toBeLessThanOrEqual(200);
    expect(err).toMatch(/^Error: HTTP 500/);
    expect(err).not.toContain('secret123');
    expect(run.probes![0]!.answer).toBe('');
  });

  test('probeErrorMessage masks keys and never uses anything but the message', () => {
    const e = Object.assign(new Error('bad request authorization=Bearer-abc api_key: "k-123"'), { headers: { 'x-api-key': 'sk-zzz' } });
    const m = probeErrorMessage(e);
    expect(m).not.toMatch(/abc|k-123|sk-zzz/);
    expect(probeErrorMessage('plain')).toBe('plain');
  });

  test('probeErrorMessage masks auth schemes, JSON headers, bare bearer tokens and JWTs', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U';
    const cases: [string, string[]][] = [
      ['401 Authorization: Bearer abc123.def456', ['abc123', 'def456']],
      ['Authorization: Basic dXNlcjpwYXNz', ['dXNlcjpwYXNz']],
      ['request {"authorization":"Bearer zzz"} failed', ['zzz']],
      ['retry with bearer ghp_abcdefghijklmnop0123', ['ghp_abcdefghijklmnop0123', 'abcdefghijklmnop']],
      ['token ghp_abcdefghijklmnop0123 rejected', ['abcdefghijklmnop']],
      [`invalid jwt ${jwt}`, ['eyJhbGciOiJIUzI1NiJ9', 'dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U']],
      ['{"x-api-key": "sk-ant-api03-AAAA"}', ['AAAA']],
      ['Proxy-Authorization: Basic Zm9vOmJhcg==', ['Zm9vOmJhcg']],
    ];
    for (const [input, secrets] of cases) {
      const m = probeErrorMessage(new Error(input));
      for (const secret of secrets) expect(m, `${input} -> ${m}`).not.toContain(secret);
    }
    expect(probeErrorMessage(new Error('HTTP 529 overloaded from api.anthropic.com'))).toBe('Error: HTTP 529 overloaded from api.anthropic.com');
  });

  test('probeErrorMessage masks URL key query params and leaves dotted host names alone', () => {
    const m = probeErrorMessage(new Error('GET https://example.com/v1?key=AIzaSyA-secret123&x=1 and ?api_key=k999 failed'));
    expect(m).not.toMatch(/AIzaSyA-secret123|k999/);
    expect(m).toContain('key=***&x=1');
    const host = 'connect to my-bucket-name.s3-external.amazonaws.com failed';
    expect(probeErrorMessage(new Error(host))).toBe(`Error: ${host}`);
  });

  test('onProbe receives each record as it is made', async () => {
    const s = scenario();
    const streamed: ProbeRecord[] = [];
    const run = await runScenario(s, fixedPolicy(), { probe: { model: { async complete() { return { reply: '12x12', ops: [] }; } }, onProbe: r => { streamed.push(r); } } });
    expect(streamed).toEqual(run.probes);
    expect(streamed).toHaveLength(3);
  });

  test('ProbeStop from the model ends probing; the scripted run is unaffected', async () => {
    const s = scenario();
    let n = 0;
    const probeModel: Model = {
      async complete() {
        if (n++ === 1) throw new ProbeStop('budget reached');
        return { reply: '12x12', ops: [] };
      },
    };
    const plain = await runScenario(s, fixedPolicy());
    const run = await runScenario(s, fixedPolicy(), { probe: { model: probeModel } });
    expect(run.records).toEqual(plain.records);
    expect(run.stats).toEqual(plain.stats);
    expect(run.probes!.map(p => p.step)).toEqual([1]);
    expect(run.probeStopped).toBe('budget reached');
    expect(n).toBe(2);
  });

  test('ProbeStop from onProbe ends probing after that record', async () => {
    const s = scenario();
    const run = await runScenario(s, fixedPolicy(), {
      probe: { model: { async complete() { return { reply: '12x12', ops: [] }; } }, onProbe: () => { throw new ProbeStop('stop'); } },
    });
    expect(run.probes).toHaveLength(1);
    expect(run.probeStopped).toBe('stop');
  });

  test('other onProbe errors propagate', async () => {
    const s = scenario();
    await expect(runScenario(s, fixedPolicy(), {
      probe: { model: { async complete() { return { reply: '', ops: [] }; } }, onProbe: () => { throw new Error('sink'); } },
    })).rejects.toThrow('sink');
  });

  test('a scheduled probe whose step never gets a scripted request is recorded as not fired', async () => {
    const s = scenario();
    const skipping: Policy = {
      group: 'D',
      async onStep(step, index, ctx) {
        if (step.kind === 'human' || index === 5) return;
        await ctx.call({ botId: ctx.actorOf(step), step: index, kind: 'scripted', segments: [{ text: 't', cacheable: false }] });
      },
      async finish() { return { compactions: 0, pauses: 0, coreErrors: 0 }; },
    };
    const run = await runScenario(s, skipping, { probe: { model: { async complete() { return { reply: '12x12', ops: [] }; } } } });
    expect(run.probes!.map(p => [p.step, p.verdict, p.error])).toEqual([[1, 'correct', undefined], [9, 'correct', undefined], [5, 'error', 'not fired']]);
    expect(run.probes![2]!.botId).toBe('art');
    expect('probeStopped' in run).toBe(false);
  });

  test('ProbeStop from onProbe on a "not fired" record ends probing without escaping runScenario', async () => {
    const s = scenario();
    const skipping: Policy = {
      group: 'D',
      async onStep(step, index, ctx) {
        if (step.kind === 'human' || index === 5 || index === 9) return;
        await ctx.call({ botId: ctx.actorOf(step), step: index, kind: 'scripted', segments: [{ text: 't', cacheable: false }] });
      },
      async finish() { return { compactions: 0, pauses: 0, coreErrors: 0 }; },
    };
    const run = await runScenario(s, skipping, {
      probe: {
        model: { async complete() { return { reply: '12x12', ops: [] }; } },
        onProbe: r => { if (r.verdict === 'error') throw new ProbeStop('sink full'); },
      },
    });
    // step 1 fired; 5 is the first "not fired" record (kept, then stop); 9 is not recorded
    expect(run.probes!.map(p => [p.step, p.verdict])).toEqual([[1, 'correct'], [5, 'error']]);
    expect(run.probeStopped).toBe('sink full');
  });
});

describe('runControl (no-context control)', () => {
  /** Records the segments of each request and answers from a map keyed by question. */
  class Recording implements Model {
    requests: ModelRequest[] = [];
    constructor(private readonly reply = '12x12') {}
    async complete(r: ModelRequest) {
      this.requests.push(r);
      return { reply: this.reply, ops: [] };
    }
  }

  test('asks each scheduled fact once with only the question segment, group none, step -1', async () => {
    const s = scenario();
    const model = new Recording();
    const { records, stopped } = await runControl(s, { model });
    expect(stopped).toBeUndefined();
    expect(model.requests).toHaveLength(1);
    expect(model.requests[0]!.segments).toEqual([{ text: probeQuestion('What is the board size?'), cacheable: false }]);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ group: 'none', scenario: 'p', step: -1, botId: '', factId: 'change-board', verdict: 'correct', cacheableTokens: 0 });
    expect(records[0]!.inputTokens).toBeGreaterThan(0);
  });

  test('grades like a group probe: a reject hit is stale, a miss is wrong', async () => {
    const s = scenario();
    expect((await runControl(s, { model: new Recording('10x10 maybe') })).records[0]!.verdict).toBe('stale');
    expect((await runControl(s, { model: new Recording('no idea') })).records[0]!.verdict).toBe('wrong');
  });

  test('only facts the sampling would probe are asked: no probe, no opportunity, or beyond the cap', async () => {
    const mk = (id: string, audience: string[], probe?: unknown) => ({ id, marker: 'CHANGE-BOARD', step: 0, audience, ...(probe ? { probe } : {}) });
    const probe = (q: string) => ({ question: q, expect: ['12x12'] });
    const s = scenario([mk('a-one', ['art'], probe('q1')), mk('b-two', ['art'], probe('q2')), mk('c-none', ['art']), mk('d-nobody', ['pm'], probe('q4'))]);
    const model = new Recording();
    const all = await runControl(s, { model });
    expect(all.records.map(r => r.factId)).toEqual(['a-one', 'b-two']);
    const capped = await runControl(s, { model: new Recording(), maxPerScenario: 1 });
    expect(capped.records.map(r => r.factId)).toEqual(['a-one']);
  });

  test('ProbeStop from the model or from onProbe ends the control and is reported', async () => {
    const mk = (id: string) => ({ id, marker: 'CHANGE-BOARD', step: 0, audience: ['art'], probe: { question: id, expect: ['12x12'] } });
    const s = scenario([mk('a-one'), mk('b-two'), mk('c-three')]);
    let n = 0;
    const stopping: Model = { async complete() { if (++n === 2) throw new ProbeStop('budget'); return { reply: '12x12', ops: [] }; } };
    const r1 = await runControl(s, { model: stopping });
    expect(r1.records.map(r => r.factId)).toEqual(['a-one']);
    expect(r1.stopped).toBe('budget');
    const seen: string[] = [];
    const r2 = await runControl(s, { model: new Recording(), onProbe: rec => { seen.push(rec.factId); if (seen.length === 2) throw new ProbeStop('sink'); } });
    expect(r2.stopped).toBe('sink');
    expect(seen).toEqual(['a-one', 'b-two']);
  });

  test('a failing model is an error record and the control goes on', async () => {
    const mk = (id: string) => ({ id, marker: 'CHANGE-BOARD', step: 0, audience: ['art'], probe: { question: id, expect: ['12x12'] } });
    const s = scenario([mk('a-one'), mk('b-two')]);
    let n = 0;
    const flaky: Model = { async complete() { if (++n === 1) throw new Error('boom'); return { reply: '12x12', ops: [] }; } };
    const { records } = await runControl(s, { model: flaky });
    expect(records.map(r => r.verdict)).toEqual(['error', 'correct']);
    expect(records[0]!.error).toContain('boom');
  });
});
