import { describe, expect, test } from 'vitest';
import { defaultCountTokens } from '@context-continue/core';
import { createPolicy } from '../src/policies/index.js';
import { BASE_TEMPLATE, runScenario } from '../src/runner.js';
import { validateScenario } from '../src/scenario.js';
import type { CallRecord } from '../src/types.js';

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

const artOps = [{ name: 'submitDeliverable', args: { workstreamId: 'art', summary: 's', content: 'sprite sheet' } }];
// human → work(art) → work(logic)
const threeSteps = () => scenario([
  { kind: 'human', text: 'Build a game.' },
  { kind: 'work', botId: 'art', workstreamId: 'art', reply: 'Drew sprites.', ops: artOps },
  { kind: 'work', botId: 'logic', workstreamId: 'logic', reply: 'Wrote rules.' },
]);

const extraBotsAfterStep = (records: CallRecord[], step: number) =>
  records.filter(r => r.kind === 'extra' && r.step === step).map(r => r.botId);

describe('group B (Grok Bot-style broadcast)', () => {
  test('B: a human message without mentions makes every bot read it, except the one that acts next (merged)', async () => {
    const { records } = await runScenario(threeSteps(), createPolicy('B', defaults));
    expect(extraBotsAfterStep(records, 0).sort()).toEqual(['logic', 'pm']); // art merged into step 1
  });

  test('B: a mention wakes only the mentioned bot', async () => {
    const { records } = await runScenario(scenario([
      { kind: 'human', text: 'Hi.', mentions: ['logic'] },
      { kind: 'work', botId: 'art', workstreamId: 'art', reply: 'x' },
    ]), createPolicy('B', defaults));
    expect(extraBotsAfterStep(records, 0)).toEqual(['logic']);
  });

  test('B: every bot message makes all other bots read it; the next actor is merged', async () => {
    const { records } = await runScenario(threeSteps(), createPolicy('B', defaults));
    expect(extraBotsAfterStep(records, 1).sort()).toEqual(['pm']); // logic merged; art is the author
    expect(extraBotsAfterStep(records, 2).sort()).toEqual(['art', 'pm']);
    // Idle replies do not trigger further reads: 2 + (1 scripted + 1) + (1 scripted + 2) records.
    expect(records.map(r => [r.botId, r.kind, r.step])).toEqual([
      ['pm', 'extra', 0], ['logic', 'extra', 0],
      ['art', 'scripted', 1], ['pm', 'extra', 1],
      ['logic', 'scripted', 2], ['pm', 'extra', 2], ['art', 'extra', 2],
    ]);
  });

  test('B: each request carries the whole group transcript; cacheable = that bot previous request', async () => {
    const { records } = await runScenario(threeSteps(), createPolicy('B', defaults));
    const T = defaultCountTokens(BASE_TEMPLATE);
    // Hand counts (ASCII → ceil(chars / 4)):
    const H = 7;      // "[human human] Build a game." = 27
    const pmN = 4;    // "[bot pm] Noted." = 15
    const logN = 5;   // "[bot logic] Noted." = 18
    const taskArt = 9;   // "[task art] work on workstream art" = 33 (private to art, not in the group transcript)
    const artReply = 6;  // "[bot art] Drew sprites." = 23
    const tool = 8;      // "[tool art] submitDeliverable: ok" = 32
    const deliv = 9;     // "[deliverable art v1] sprite sheet" = 33
    const taskLogic = 10; // "[task logic] work on workstream logic" = 37
    const logReply = 6;  // "[bot logic] Wrote rules." = 24

    // step 0 extras: pm reads [H]; logic reads [H, pm's Noted.]
    expect(records[0]).toMatchObject({ inputTokens: T + H, cacheableTokens: T });
    expect(records[1]).toMatchObject({ inputTokens: T + H + pmN, cacheableTokens: T });
    // art scripted (first request): [H, pmN, logN, task]
    expect(records[2]).toMatchObject({ inputTokens: T + H + pmN + logN + taskArt, cacheableTokens: T });
    // pm extra after step 1: its previous request (T + H) is cached; art's reply, tool, deliverable and the Noted. lines are new
    expect(records[3]).toMatchObject({ inputTokens: T + H + pmN + logN + artReply + tool + deliv, cacheableTokens: T + H });
    // logic scripted: previous request was T + H + pmN
    expect(records[4]).toMatchObject({
      inputTokens: T + H + pmN + logN + artReply + tool + deliv + pmN + taskLogic,
      cacheableTokens: T + H + pmN,
    });
    // pm extra after step 2: previous request (records[3]) cached; new = pm's Noted. + logic's reply
    expect(records[5]).toMatchObject({ inputTokens: records[3]!.inputTokens + pmN + logReply, cacheableTokens: records[3]!.inputTokens });
    // art extra after step 2: previous request (records[2]) cached; new = art reply/tool/deliv, pm Noted., logic reply, pm Noted.
    expect(records[6]).toMatchObject({
      inputTokens: records[2]!.inputTokens + artReply + tool + deliv + pmN + logReply + pmN,
      cacheableTokens: records[2]!.inputTokens,
    });
  });
});
