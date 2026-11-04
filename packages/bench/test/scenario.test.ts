import { describe, expect, test } from 'vitest';
import { checkCoverage, stepText, validateScenario } from '../src/scenario.js';

const ws = (id: string, owner: string) => ({ id, title: id, brief: `do ${id}`, owner, dependsOn: [] as string[] });

function minimal(): Record<string, any> {
  return {
    id: 's1', goal: 'g', constraints: ['c'], owner: 'human', lead: 'lead',
    employees: [
      { botId: 'lead', persona: 'p', skills: [] },
      { botId: 'art', persona: 'p', skills: ['draw'] },
      { botId: 'dev', persona: 'p', skills: [] },
    ],
    plan: { workstreams: [ws('audio', 'dev'), ws('art', 'art')], contracts: [] },
    steps: [],
  };
}
const withStep = (...steps: unknown[]) => ({ ...minimal(), steps });
const errorOf = (fn: () => unknown): Error => {
  try { fn(); } catch (e) { return e as Error; }
  throw new Error('did not throw');
};

describe('validateScenario', () => {
  test('valid minimal scenario loads with idleReply default', () => {
    expect(validateScenario(minimal()).idleReply).toBe('Noted.');
  });
  test('explicit idleReply is kept', () => {
    expect(validateScenario({ ...minimal(), idleReply: 'Ok.' }).idleReply).toBe('Ok.');
  });
  test('work step referencing unknown workstream fails with step index', () => {
    expect(() => validateScenario(withStep({ kind: 'work', botId: 'art', workstreamId: 'nope', reply: 'x' })))
      .toThrow(/step 0: .*nope/);
  });
  test('workstream removed by replan cannot be used afterwards', () => {
    const raw = withStep(
      { kind: 'work', botId: 'dev', workstreamId: 'audio', reply: 'x' },
      { kind: 'replan', plan: { workstreams: [ws('art', 'art')], contracts: [] } },
      { kind: 'work', botId: 'dev', workstreamId: 'audio', reply: 'y' },
    );
    expect(() => validateScenario(raw)).toThrow(/step 2: .*audio/);
  });
  test('workstream added by replan can be used afterwards', () => {
    const raw = withStep(
      { kind: 'replan', plan: { workstreams: [ws('music', 'dev')], contracts: [] } },
      { kind: 'work', botId: 'dev', workstreamId: 'music', reply: 'y' },
    );
    expect(() => validateScenario(raw)).not.toThrow();
  });
  test('human mention of a non-employee fails', () => {
    expect(() => validateScenario(withStep({ kind: 'human', text: 'hi', mentions: ['ghost'] }))).toThrow(/ghost/);
  });
  test('human mention of an employee passes', () => {
    expect(() => validateScenario(withStep({ kind: 'human', text: 'hi', mentions: ['art'] }))).not.toThrow();
  });
  test('unknown tool name fails; all problems are listed together', () => {
    const e = errorOf(() => validateScenario(withStep(
      { kind: 'work', botId: 'art', workstreamId: 'art', reply: 'x', ops: [{ name: 'bogusTool', args: {} }] },
      { kind: 'work', botId: 'art', workstreamId: 'nope', reply: 'x' },
    )));
    const lines = e.message.split('\n').filter(l => l.startsWith('step'));
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/step 0: .*bogusTool/);
    expect(lines[1]).toMatch(/step 1: .*nope/);
  });
  test('known tool name passes', () => {
    expect(() => validateScenario(withStep(
      { kind: 'work', botId: 'art', workstreamId: 'art', reply: 'x', ops: [{ name: 'proposeDecision', args: {} }] },
    ))).not.toThrow();
  });
  test('work botId must own the workstream it works on in the current plan', () => {
    expect(() => validateScenario(withStep({ kind: 'work', botId: 'dev', workstreamId: 'art', reply: 'x' })))
      .toThrow(/step 0: .*dev.*art/);
  });
  test('work botId must be an employee', () => {
    expect(() => validateScenario(withStep({ kind: 'work', botId: 'zed', workstreamId: 'art', reply: 'x' })))
      .toThrow(/step 0: .*zed/);
  });
  test('structural problems are reported with a field path', () => {
    const raw = { ...minimal(), goal: 5 };
    expect(() => validateScenario(raw)).toThrow(/goal/);
  });
  test('lead must be an employee', () => {
    expect(() => validateScenario({ ...minimal(), lead: 'nobody' })).toThrow(/lead/);
  });
  test('initial plan owners must be employees', () => {
    const raw = { ...minimal(), plan: { workstreams: [ws('audio', 'ghost'), ws('art', 'art')], contracts: [] } };
    expect(() => validateScenario(raw)).toThrow(/plan\.workstreams\[0\]\.owner: .*ghost/);
  });
  test('replan owners must be employees', () => {
    const raw = withStep(
      { kind: 'human', text: 'hi' },
      { kind: 'replan', plan: { workstreams: [ws('art', 'art'), ws('music', 'phantom')], contracts: [] } },
    );
    expect(() => validateScenario(raw)).toThrow(/step 1: .*phantom/);
  });
  test('duplicate employee botIds fail', () => {
    const raw = { ...minimal(), employees: [...minimal().employees, { botId: 'art', persona: 'q', skills: [] }] };
    expect(() => validateScenario(raw)).toThrow(/employees: duplicate botId "art"/);
  });
  test('duplicate workstream ids in the initial plan fail', () => {
    const raw = { ...minimal(), plan: { workstreams: [ws('art', 'art'), ws('art', 'dev')], contracts: [] } };
    expect(() => validateScenario(raw)).toThrow(/plan\.workstreams: duplicate .*"art"/);
  });
  test('duplicate workstream ids in a replan fail with the step index', () => {
    const raw = withStep(
      { kind: 'replan', plan: { workstreams: [ws('art', 'art'), ws('art', 'art')], contracts: [] } },
    );
    expect(() => validateScenario(raw)).toThrow(/step 0: .*duplicate .*"art"/);
  });
  test('submitDeliverable args must have string workstreamId, summary and content', () => {
    const op = (args: unknown) => ({ kind: 'work', botId: 'art', workstreamId: 'art', reply: 'x', ops: [{ name: 'submitDeliverable', args }] });
    const e = errorOf(() => validateScenario(withStep(
      op({ workstreamId: 'art', summary: 's', content: 'c' }),
      op({ workstreamId: 'art', content: 'c' }),
      op('nope'),
    )));
    const lines = e.message.split('\n').filter(l => l.startsWith('step'));
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/^step 1: submitDeliverable args/);
    expect(lines[1]).toMatch(/^step 2: submitDeliverable args/);
  });
});

describe('facts and tier', () => {
  const base = () => withStep(
    { kind: 'human', text: 'x' }, { kind: 'human', text: 'y' }, { kind: 'human', text: 'z' },
    { kind: 'human', text: 'Uploads are capped: MAX-5MB.' },
  );
  const withFact = (...facts: unknown[]) => ({ ...base(), facts });
  const fact = (o: Record<string, unknown> = {}) => ({ id: 'conv-x', marker: 'MAX-5MB', step: 3, audience: ['*'], ...o });

  test('valid fact loads; tier is optional', () => {
    const s = validateScenario(withFact(fact()));
    expect(s.facts).toHaveLength(1);
    expect(s.tier).toBeUndefined();
    expect(() => validateScenario({ ...withFact(fact()), tier: 'long' })).not.toThrow();
    expect(() => validateScenario({ ...base(), tier: 'huge' })).toThrow(/tier/);
  });
  test('fact marker must appear in its step text', () => {
    expect(() => validateScenario(withFact(fact({ step: 2 })))).toThrow(/fact conv-x.*step 2.*MAX-5MB/);
    expect(() => validateScenario(withFact(fact({ marker: 'max-5mb' })))).toThrow(/fact conv-x.*step 3.*max-5mb/);
  });
  test('fact audience must be employees or "*"', () => {
    expect(() => validateScenario(withFact(fact({ audience: ['dev', 'ghost'] })))).toThrow(/fact conv-x.*ghost/);
    expect(() => validateScenario(withFact(fact({ audience: ['dev', 'art'] })))).not.toThrow();
  });
  test('fact step out of range is rejected', () => {
    expect(() => validateScenario(withFact(fact({ step: 999 })))).toThrow(/fact conv-x.*step 999/);
    expect(() => validateScenario(withFact(fact({ step: -1 })))).toThrow(/fact conv-x.*step -1/);
  });
  test('duplicate fact ids are rejected', () => {
    expect(() => validateScenario(withFact(fact(), fact()))).toThrow(/duplicate fact id "conv-x"/);
  });
  test('all fact problems are listed together', () => {
    const e = errorOf(() => validateScenario(withFact(fact({ id: 'a', step: 0 }), fact({ id: 'b', audience: ['ghost'] }))));
    expect(e.message).toMatch(/fact a/);
    expect(e.message).toMatch(/fact b/);
  });
  test('stepText covers every step kind', () => {
    expect(stepText({ kind: 'human', text: 'HUMAN-T' })).toBe('HUMAN-T');
    const work = stepText({
      kind: 'work', botId: 'dev', workstreamId: 'audio', reply: 'REPLY-T',
      ops: [{ name: 'sendMessage', args: { text: 'ARG-T' } }, { name: 'proposeDecision', args: { q: 1 } }],
    });
    expect(work).toBe(`REPLY-T\n${JSON.stringify({ text: 'ARG-T' })}\n${JSON.stringify({ q: 1 })}`);
    expect(stepText({ kind: 'review', deliverableOf: 'audio', passed: true, notes: 'NOTES-T', conventions: ['C1', 'C2'] }))
      .toBe('NOTES-T\nC1\nC2');
    const plan = { workstreams: [ws('audio', 'dev')], contracts: [] };
    expect(stepText({ kind: 'replan', plan })).toBe(JSON.stringify(plan));
  });
  test('checkCoverage enforces step counts by tier', () => {
    const long = { ...minimal(), tier: 'long', steps: Array.from({ length: 120 }, () => ({ kind: 'human', text: 'hi' })) };
    expect(checkCoverage(validateScenario(long))).toContain('long scenario needs 150–300 steps');
    const std = validateScenario({ ...withFact(fact()) });
    expect(checkCoverage(std)).toContain('standard scenario needs 20–40 steps');
    const xl = { ...minimal(), tier: 'xlong', steps: Array.from({ length: 900 }, () => ({ kind: 'human', text: 'hi' })) };
    expect(checkCoverage(validateScenario(xl))).toContain('xlong scenario needs 1000–1500 steps');
    expect(checkCoverage(validateScenario({ ...xl, steps: Array.from({ length: 1501 }, () => ({ kind: 'human', text: 'hi' })) })))
      .toContain('xlong scenario needs 1000–1500 steps');
    expect(checkCoverage(validateScenario({ ...xl, steps: Array.from({ length: 1000 }, () => ({ kind: 'human', text: 'hi' })) })))
      .not.toContain('xlong scenario needs 1000–1500 steps');
  });

  describe('xlong minimums', () => {
    const LONG_LIVED = 'xlong scenario needs at least 10 facts needed 300+ steps after they are introduced';
    const CATS = ['change', 'conv', 'contract', 'fail'];
    /** An xlong scenario: `n` facts (m0, m1, ...) told at step i*5 by human steps; the dev work steps after that are fillers. */
    function xlong(opts: { facts?: number; lastWork?: number; audience?: string[]; workBot?: string } = {}) {
      const n = opts.facts ?? 40;
      const steps: Record<string, unknown>[] = Array.from({ length: 1000 }, () => ({ kind: 'human', text: 'filler' }));
      const facts = Array.from({ length: n }, (_, i) => {
        steps[i * 5] = { kind: 'human', text: `fact m${i}` };
        return { id: `${CATS[i % 4]}-${i}`, marker: `m${i}`, step: i * 5, audience: opts.audience ?? ['dev'] };
      });
      // one work step by `workBot` at index lastWork (default 999)
      steps[opts.lastWork ?? 999] = { kind: 'work', botId: opts.workBot ?? 'dev', workstreamId: opts.workBot === 'art' ? 'art' : 'audio', reply: 'r' };
      return validateScenario({ ...minimal(), tier: 'xlong', steps, facts });
    }
    const msgs = (s: ReturnType<typeof xlong>) => checkCoverage(s).filter(m => m.startsWith('xlong'));

    test('the other xlong minimums are reported when missing', () => {
      const m = checkCoverage(xlong());
      for (const t of [
        'xlong scenario needs at least 6 replans', 'xlong scenario needs at least 8 requirement changes',
        'xlong scenario needs at least 15 failed reviews', 'xlong scenario needs at least 20 new conventions',
        'xlong scenario needs at least 30 bot-to-bot queries',
      ]) expect(m).toContain(t);
      expect(checkCoverage(xlong({ facts: 39 }))).toContain('xlong scenario needs at least 40 facts');
      expect(checkCoverage(xlong())).not.toContain('xlong scenario needs at least 40 facts');
    });

    test('long-lived facts: counted from later scripted requests of the audience, not from annotations', () => {
      // facts at steps 0..195; a dev work step at 999 is > fact.step + 300 for every fact
      expect(msgs(xlong())).not.toContain(LONG_LIVED);
      // the only later request is by a bot outside every audience
      expect(msgs(xlong({ workBot: 'art' }))).toContain(LONG_LIVED);
    });

    test('exactly 10 qualifying facts suffice, 9 do not; the request must be strictly after fact.step + 300', () => {
      // facts at 0,5,...,195; a request at index r qualifies facts with step + 300 < r
      expect(msgs(xlong({ lastWork: 346 }))).not.toContain(LONG_LIVED); // steps 0..45 -> 10 facts
      expect(msgs(xlong({ lastWork: 345 }))).toContain(LONG_LIVED); // steps 0..40 -> 9 facts
    });

    test('audience "*" means every employee; a lead review counts as the lead\'s request', () => {
      expect(msgs(xlong({ audience: ['*'], workBot: 'art' }))).not.toContain(LONG_LIVED);
      const steps: Record<string, unknown>[] = Array.from({ length: 1000 }, () => ({ kind: 'human', text: 'filler' }));
      const facts = Array.from({ length: 40 }, (_, i) => {
        steps[i] = { kind: 'human', text: `fact m${i}` };
        return { id: `${CATS[i % 4]}-${i}`, marker: `m${i}`, step: i, audience: ['lead'] };
      });
      steps[900] = { kind: 'review', deliverableOf: 'audio', passed: true, notes: 'ok' };
      expect(msgs(validateScenario({ ...minimal(), tier: 'xlong', steps, facts }))).not.toContain(LONG_LIVED);
      steps[900] = { kind: 'human', text: 'a human step is no bot request' };
      expect(msgs(validateScenario({ ...minimal(), tier: 'xlong', steps, facts }))).toContain(LONG_LIVED);
    });

    test('checkCoverage enforces xlong minimums including long-lived facts (all met gives no xlong item)', () => {
      // a scenario that meets everything: 40 facts, 6 replans, 8 changes, 15 failed reviews, 20 conventions, 30 queries
      const steps: Record<string, unknown>[] = Array.from({ length: 1000 }, () => ({ kind: 'human', text: 'filler' }));
      const plan = minimal().plan;
      let at = 0;
      const put = (st: Record<string, unknown>) => { steps[at++] = st; };
      put({ kind: 'work', botId: 'dev', workstreamId: 'audio', reply: 'first' });
      for (let i = 0; i < 8; i++) { put({ kind: 'human', text: `change the goal ${i}` }); put({ kind: 'replan', plan }); }
      for (let i = 0; i < 15; i++) put({ kind: 'review', deliverableOf: 'audio', passed: false, notes: 'no', conventions: i < 20 ? [`c${i}a`, `c${i}b`] : [] });
      for (let i = 0; i < 30; i++) put({ kind: 'work', botId: 'dev', workstreamId: 'audio', reply: 'q', ops: [{ name: 'sendMessage', args: { text: 'q?', act: 'query', mentions: ['art'] } }] });
      const facts = Array.from({ length: 40 }, (_, i) => {
        steps[100 + i] = { kind: 'human', text: `fact m${i}` };
        return { id: `${CATS[i % 4]}-${i}`, marker: `m${i}`, step: 100 + i, audience: ['dev'] };
      });
      steps[999] = { kind: 'work', botId: 'dev', workstreamId: 'audio', reply: 'last' };
      expect(checkCoverage(validateScenario({ ...minimal(), tier: 'xlong', steps, facts }))).toEqual([]);
    });
  });
});
