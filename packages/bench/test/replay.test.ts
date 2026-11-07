import { describe, expect, test } from 'vitest';
import { ProbeModelError, type Model, type ModelRequest } from '../src/model.js';
import { ProbeStop } from '../src/probe.js';
import { REPLAY_MAX_TOKENS, runScenario, type Policy, type RunContext } from '../src/runner.js';
import { validateScenario } from '../src/scenario.js';
import type { ReplayRecord, Scenario, Step } from '../src/types.js';

const ws = (id: string, owner: string) => ({ id, title: id, brief: `do ${id}`, owner, dependsOn: [] as string[] });

function scenario(): Scenario {
  const steps: unknown[] = [{ kind: 'human', text: 'Board is 12×12 now (CHANGE-BOARD), was 10x10.' }];
  for (let i = 0; i < 6; i++) steps.push({ kind: 'work', botId: i % 2 === 0 ? 'art' : 'logic', workstreamId: i % 2 === 0 ? 'art' : 'logic', reply: `r${i}` });
  return validateScenario({
    id: 'r', goal: 'g', constraints: [], owner: 'human', lead: 'pm',
    employees: ['pm', 'art', 'logic'].map(botId => ({ botId, persona: 'p', skills: [] })),
    plan: { workstreams: [ws('art', 'art'), ws('logic', 'logic')], contracts: [] },
    steps,
    facts: [{
      id: 'change-board', marker: 'CHANGE-BOARD', step: 0, audience: ['art'],
      probe: { question: 'What is the board size?', expect: ['12x12'], reject: ['10x10'] },
    }],
  });
}

/** One scripted request per non-human step, plus an extra request after steps 2 and 3. */
function policy(): Policy {
  return {
    group: 'A',
    async onStep(step: Step, index: number, ctx: RunContext) {
      if (step.kind === 'human') return;
      const segments = [{ text: 'base', cacheable: true, kind: 'template' }, { text: `step ${index}`, cacheable: false }];
      await ctx.call({ botId: ctx.actorOf(step), step: index, kind: 'scripted', segments });
      if (index === 2 || index === 3) await ctx.call({ botId: 'pm', step: index, kind: 'extra', segments });
    },
    async finish() { return { compactions: 0, pauses: 0, coreErrors: 0 }; },
  };
}

const usage = { inputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 1 };

class Recorder implements Model {
  requests: ModelRequest[] = [];
  constructor(private readonly onRequest?: (r: ModelRequest, n: number) => void) {}
  async complete(r: ModelRequest) {
    this.requests.push(r);
    this.onRequest?.(r, this.requests.length);
    return { reply: 'whatever answer', ops: [], usage };
  }
}


describe('runScenario replay', () => {
  test('replays every request once, in order, with the same segments, cap and purpose', async () => {
    const s = scenario();
    const main = new Recorder();
    const rp = new Recorder();
    const out = await runScenario(s, policy(), { model: main, replay: { model: rp } });
    expect(out.records).toHaveLength(8);
    expect(rp.requests).toHaveLength(out.records.length);
    rp.requests.forEach((r, i) => {
      expect(r.segments).toEqual(main.requests[i]!.segments);
      expect(r.botId).toBe(main.requests[i]!.botId);
      expect(r.maxTokens).toBe(REPLAY_MAX_TOKENS);
      expect(REPLAY_MAX_TOKENS).toBe(16);
      expect(r.purpose).toBe('replay');
      expect(r.scripted).toBeNull();
    });
    expect(out.replay!.map(r => [r.step, r.botId, r.kind])).toEqual(out.records.map(r => [r.step, r.botId, r.kind]));
    expect(out.replay![0]!.usage).toEqual(usage);
    expect(out.realStopped).toBeUndefined();
  });

  test('records and return keys match a run without replay', async () => {
    const plain = await runScenario(scenario(), policy());
    const withReplay = await runScenario(scenario(), policy(), { replay: { model: new Recorder() } });
    expect(withReplay.records).toEqual(plain.records);
    expect(Object.keys(plain).sort()).toEqual(['records', 'stats']);
    expect(Object.keys(withReplay).sort()).toEqual(['records', 'replay', 'stats']);
  });

  test('a replay call precedes the probe of the same step', async () => {
    const s = scenario();
    const log: string[] = [];
    const rp = new Recorder(r => log.push(`replay:${r.segments[1]!.text}`));
    const pr = new Recorder(() => log.push('probe'));
    const out = await runScenario(s, policy(), {
      replay: { model: rp },
      probe: { model: pr },
    });
    expect(out.probes!.length).toBeGreaterThan(0);
    const at = log.indexOf('probe');
    expect(log[at - 1]).toMatch(/^replay:step /);
    expect(log.filter(l => l === 'probe')).toHaveLength(out.probes!.length);
    expect(log.slice(0, at).length).toBeGreaterThan(0);
  });

  test('a plain replay error is recorded (masked, with usage) and the run continues', async () => {
    const rp: Model = {
      async complete(r) {
        if (r.segments[1]!.text === 'step 2') throw new ProbeModelError('bad request sk-abcdefghijklmnopqrstuvwxyz0123', usage);
        if (r.segments[1]!.text === 'step 4') throw new Error('boom');
        return { reply: 'x', ops: [] };
      },
    };
    const out = await runScenario(scenario(), policy(), { replay: { model: rp } });
    expect(out.replay).toHaveLength(out.records.length);
    const errs = out.replay!.filter(r => r.error !== undefined);
    expect(errs.map(r => r.step)).toEqual([2, 2, 4]);
    expect(errs[0]!.usage).toEqual(usage);
    expect(errs[0]!.error).not.toContain('sk-abcdefghijklmnopqrstuvwxyz0123');
    expect(errs[2]!.usage).toBeUndefined();
    expect(out.realStopped).toBeUndefined();
  });

  test('ProbeStop from the replay model stops replay and probes; the run finishes', async () => {
    const pr = new Recorder();
    let n = 0;
    const rp: Model = {
      async complete() {
        if (++n === 2) throw new ProbeStop('cost cap');
        return { reply: 'x', ops: [] };
      },
    };
    const plain = await runScenario(scenario(), policy());
    const out = await runScenario(scenario(), policy(), { replay: { model: rp }, probe: { model: pr } });
    expect(out.records).toEqual(plain.records);
    expect(n).toBe(2);
    expect(out.realStopped).toBe('cost cap');
    expect(out.probeStopped).toBe('cost cap');
    expect(out.replay).toHaveLength(1);
    // The step-1 probe fired before the stop; none after it.
    expect(pr.requests).toHaveLength(1);
    expect(out.probes!.every(p => p.verdict === 'error' && p.error === 'not fired')).toBe(false);
  });

  test('onReplay is called once per request; ProbeStop from it stops, other errors propagate', async () => {
    const seen: ReplayRecord[] = [];
    const rp = new Recorder();
    const out = await runScenario(scenario(), policy(), { replay: { model: rp, onReplay: r => { seen.push(r); } } });
    expect(seen).toEqual(out.replay);
    expect(seen).toHaveLength(8);

    const rp2 = new Recorder();
    let calls = 0;
    const stopped = await runScenario(scenario(), policy(), {
      replay: { model: rp2, onReplay: () => { if (++calls === 2) throw new ProbeStop('sink stop'); } },
    });
    expect(rp2.requests).toHaveLength(2);
    expect(stopped.realStopped).toBe('sink stop');
    expect(stopped.records).toHaveLength(8);

    await expect(runScenario(scenario(), policy(), {
      replay: { model: new Recorder(), onReplay: () => { throw new Error('disk full'); } },
    })).rejects.toThrow('disk full');
  });
});
