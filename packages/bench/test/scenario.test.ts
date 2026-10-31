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
  });
});
