import { describe, expect, test } from 'vitest';
import { createPolicy } from '../src/policies/index.js';
import { runScenario } from '../src/runner.js';
import { ScriptedModel, type ModelRequest } from '../src/model.js';
import { validateScenario } from '../src/scenario.js';
import type { Group } from '../src/types.js';

// R-L4: tool-call arguments are rendered in the acting bot's own history; sendMessage text is also a posted message.

const ws = (id: string, owner: string) => ({ id, title: id, brief: `do ${id}`, owner, dependsOn: [] as string[] });
const defaults = { window: 128000, compactRatio: 0.8, summaryTokens: 1500 };

const scenario = (steps: unknown[]) =>
  validateScenario({
    id: 't', goal: 'g', constraints: [], owner: 'human', lead: 'pm',
    employees: [
      { botId: 'pm', persona: 'p', skills: [] },
      { botId: 'art', persona: 'p', skills: [] },
      { botId: 'logic', persona: 'p', skills: [] },
    ],
    plan: { workstreams: [ws('art', 'art'), ws('logic', 'logic')], contracts: [] },
    steps,
  });

async function run(group: Group, steps: unknown[]) {
  const seen: ModelRequest[] = [];
  const inner = new ScriptedModel('Noted.');
  const model = { complete: async (r: ModelRequest) => (seen.push(r), inner.complete(r)) };
  await runScenario(scenario(steps), createPolicy(group, defaults), { model });
  return seen;
}
const text = (r: ModelRequest) => r.segments.map(s => s.text).join('\n');
const last = (xs: ModelRequest[]) => xs[xs.length - 1]!;

const failureStep = { kind: 'work', botId: 'art', workstreamId: 'art', reply: 'x',
  ops: [{ name: 'recordFailure', args: { text: 'TRIED-THING', reason: 'WHY-SLOW', affects: ['art'] } }] };
const reviewStep = { kind: 'review', deliverableOf: 'art', passed: false, notes: 'No.', conventions: ['CONV-RULE-ONE'] };
const next = { kind: 'work', botId: 'art', workstreamId: 'art', reply: 'again' };
const msgStep = { kind: 'work', botId: 'art', workstreamId: 'art', reply: 'asking',
  ops: [{ name: 'sendMessage', args: { text: 'MSG-TEXT-XYZ', act: 'inform', mentions: [] } }] };

describe('tool-call arguments in histories (R-L4)', () => {
  test('A: the request after a review contains its conventions; after a recordFailure its tried/why text', async () => {
    const seen = await run('A', [failureStep, reviewStep, next]);
    expect(text(seen[1]!)).toContain('TRIED-THING');
    expect(text(seen[1]!)).toContain('why it failed: WHY-SLOW');
    expect(text(seen[2]!)).toContain('conventions: CONV-RULE-ONE');
  });

  test('F: the bot\'s own next request contains its op args', async () => {
    const seen = await run('F', [failureStep, next]);
    expect(seen[1]!.segments.some(s => s.text.startsWith('[tool art] recordFailure: ok') && s.text.includes('why it failed: WHY-SLOW'))).toBe(true);
  });

  test.each(['B', 'D', 'E'] as Group[])('%s: another bot\'s request after a sendMessage contains the message text', async group => {
    const seen = await run(group, [msgStep, { kind: 'work', botId: 'logic', workstreamId: 'logic', reply: 'ok' }]);
    const logicReq = last(seen.filter(r => r.botId === 'logic'));
    expect(text(logicReq)).toContain('MSG-TEXT-XYZ');
  });

  test.each(['B', 'D'] as Group[])('%s: other calls\' args stay private to the author', async group => {
    const seen = await run(group, [failureStep, { kind: 'work', botId: 'logic', workstreamId: 'logic', reply: 'ok' }, next]);
    expect(text(last(seen.filter(r => r.botId === 'logic')))).not.toContain('TRIED-THING');
    expect(text(last(seen.filter(r => r.botId === 'art')))).toContain('TRIED-THING');
  });

  test('E: other calls\' args stay out of the room', async () => {
    const seen = await run('E', [failureStep, { kind: 'work', botId: 'logic', workstreamId: 'logic', reply: 'ok' }]);
    expect(text(last(seen.filter(r => r.botId === 'logic')))).not.toContain('TRIED-THING');
  });
});
