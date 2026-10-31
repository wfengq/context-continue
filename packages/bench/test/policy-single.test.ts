import { describe, expect, test } from 'vitest';
import { defaultCountTokens } from '@context-continue/core';
import { createPolicy } from '../src/policies/index.js';
import { BASE_TEMPLATE, runScenario } from '../src/runner.js';
import { validateScenario } from '../src/scenario.js';

const ws = (id: string, owner: string) => ({ id, title: id, brief: `do ${id}`, owner, dependsOn: [] as string[] });
const defaults = { window: 128000, compactRatio: 0.8, summaryTokens: 1500 };

function scenario(steps: unknown[]) {
  return validateScenario({
    id: 'three', goal: 'g', constraints: [], owner: 'human', lead: 'pm',
    employees: [
      { botId: 'pm', persona: 'p', skills: [] },
      { botId: 'art', persona: 'p', skills: [] },
      { botId: 'logic', persona: 'p', skills: [] },
    ],
    plan: { workstreams: [ws('art', 'art'), ws('logic', 'logic')], contracts: [] },
    steps,
  });
}

// human → work(art) → work(logic)
const threeSteps = () => scenario([
  { kind: 'human', text: 'Build a game.' },
  { kind: 'work', botId: 'art', workstreamId: 'art', reply: 'Drew sprites.',
    ops: [{ name: 'submitDeliverable', args: { workstreamId: 'art', summary: 's', content: 'sprite sheet' } }] },
  { kind: 'work', botId: 'logic', workstreamId: 'logic', reply: 'Wrote rules.' },
]);

describe('group A (single agent)', () => {
  test('A: one solo agent, requests = scripted steps, full history each time', async () => {
    const { records, stats } = await runScenario(threeSteps(), createPolicy('A', defaults));
    expect(stats).toEqual({ compactions: 0, pauses: 0, coreErrors: 0 });
    expect(records.map(r => [r.botId, r.kind, r.step])).toEqual([['solo', 'scripted', 1], ['solo', 'scripted', 2]]);

    // Hand counts (ASCII → ceil(chars / 4)):
    const T = defaultCountTokens(BASE_TEMPLATE);
    const human = 7;   // "[human human] Build a game." = 27 chars
    const task0 = 9;   // "[task solo] work on workstream art" = 34 chars
    const reply0 = 6;  // "[bot solo] Drew sprites." = 24 chars
    const tool0 = 9;   // "[tool solo] submitDeliverable: ok" = 33 chars
    const deliv0 = 9;  // "[deliverable art v1] sprite sheet" = 33 chars
    const task1 = 9;   // "[task solo] work on workstream logic" = 36 chars

    expect(records[0]).toMatchObject({ inputTokens: T + human + task0, cacheableTokens: T });
    expect(records[1]!.inputTokens).toBe(T + human + task0 + reply0 + tool0 + deliv0 + task1);
    expect(records[1]!.cacheableTokens).toBe(records[0]!.inputTokens + reply0 + tool0 + deliv0);
    expect(records.every(r => r.group === 'A' && r.scenario === 'three' && r.segments === undefined)).toBe(true);
  });

  test('A: human messages between requests are new (not cacheable) content; review and replan are solo requests', async () => {
    const plan = { workstreams: [ws('art', 'art')], contracts: [] };
    const { records } = await runScenario(scenario([
      { kind: 'work', botId: 'art', workstreamId: 'art', reply: 'Drew.' },
      { kind: 'human', text: 'Darker please.' },
      { kind: 'review', deliverableOf: 'art', passed: false, notes: 'Too light.' },
      { kind: 'replan', plan },
    ]), createPolicy('A', defaults));
    expect(records.map(r => [r.botId, r.step])).toEqual([['solo', 0], ['solo', 2], ['solo', 3]]);

    const T = defaultCountTokens(BASE_TEMPLATE);
    const task0 = 9;    // "[task solo] work on workstream art" = 34
    const reply0 = 4;   // "[bot solo] Drew." = 16
    const human = 7;    // "[human human] Darker please." = 28
    const task2 = 11;   // "[task solo] review the deliverable of art" = 41
    const reply2 = 6;   // "[bot solo] Too light." = 21
    const tool2 = 7;    // "[tool solo] submitReview: ok" = 28
    const task3 = 5;    // "[task solo] replan" = 18

    expect(records[0]).toMatchObject({ inputTokens: T + task0, cacheableTokens: T });
    expect(records[1]).toMatchObject({ inputTokens: T + task0 + reply0 + human + task2, cacheableTokens: T + task0 + reply0 });
    expect(records[2]).toMatchObject({
      inputTokens: T + task0 + reply0 + human + task2 + reply2 + tool2 + task3,
      cacheableTokens: T + task0 + reply0 + human + task2 + reply2 + tool2,
    });
  });

  test('A: repeated deliverables carry increasing versions', async () => {
    const op = (content: string) => ({ name: 'submitDeliverable', args: { workstreamId: 'art', summary: 's', content } });
    const { records } = await runScenario(scenario([
      { kind: 'work', botId: 'art', workstreamId: 'art', reply: 'v1', ops: [op('aaaa')] },
      { kind: 'work', botId: 'art', workstreamId: 'art', reply: 'v2', ops: [op('bbbb')] },
      { kind: 'work', botId: 'logic', workstreamId: 'logic', reply: 'x' },
    ]), createPolicy('A', defaults));
    // "[deliverable art v1] aaaa" and "[deliverable art v2] bbbb" are both 25 chars = 7 tokens each.
    // Request 2 cacheable = request 1 input + "[bot solo] v2" (13 → 4) + "[tool solo] submitDeliverable: ok" (33 → 9) + deliverable v2 (7).
    expect(records[2]!.cacheableTokens).toBe(records[1]!.inputTokens + 4 + 9 + 7);
  });

  test('createPolicy rejects groups not implemented yet', () => {
    expect(() => createPolicy('B', defaults)).toThrow(/B/);
  });
});
