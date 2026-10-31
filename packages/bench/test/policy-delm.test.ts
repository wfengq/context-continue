import { describe, expect, test } from 'vitest';
import { defaultCountTokens } from '@context-continue/core';
import { ScriptedModel, type Model, type ModelRequest } from '../src/model.js';
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

const deliverableContent = 'sprite sheet with a very distinctive payload';
const artOps = [{ name: 'submitDeliverable', args: { workstreamId: 'art', summary: 's', content: deliverableContent } }];
// human → work(art) → work(logic) → human(@pm)
const fourSteps = () => scenario([
  { kind: 'human', text: 'Build a game.' },
  { kind: 'work', botId: 'art', workstreamId: 'art', reply: 'Drew sprites.', ops: artOps },
  { kind: 'work', botId: 'logic', workstreamId: 'logic', reply: 'Wrote rules.' },
  { kind: 'human', text: 'Ping pm.', mentions: ['pm'] },
]);

class SpyModel implements Model {
  requests: ModelRequest[] = [];
  private readonly inner = new ScriptedModel('Noted.');
  async complete(r: ModelRequest) {
    this.requests.push(r);
    return this.inner.complete(r);
  }
}

describe('group D (DeLM-style shared log)', () => {
  test('D: no lead routing — unaddressed human message wakes everyone (except the merged next actor)', async () => {
    const { records } = await runScenario(fourSteps(), createPolicy('D', defaults));
    const extras0 = records.filter(r => r.kind === 'extra' && r.step === 0).map(r => r.botId);
    expect(extras0).toEqual(['pm', 'logic']); // art merged into step 1; lead gets no special role
  });

  test('D: bot messages wake nobody; a mention wakes only the mentioned bot', async () => {
    const { records } = await runScenario(fourSteps(), createPolicy('D', defaults));
    expect(records.map(r => [r.botId, r.kind, r.step])).toEqual([
      ['pm', 'extra', 0], ['logic', 'extra', 0],
      ['art', 'scripted', 1],
      ['logic', 'scripted', 2],
      ['pm', 'extra', 3],
    ]);
  });

  test('D: deliverables appear as references, not content', async () => {
    const spy = new SpyModel();
    await runScenario(fourSteps(), createPolicy('D', defaults), { model: spy });
    const last = spy.requests[spy.requests.length - 1]!;
    const text = last.segments.map(s => s.text).join('\n');
    expect(text).toContain('[deliverable art v1 ref]');
    expect(text).not.toContain(deliverableContent);
  });

  test('D: each bot sees all log entries since its last read (no relevance filter), never twice', async () => {
    const spy = new SpyModel();
    await runScenario(fourSteps(), createPolicy('D', defaults), { model: spy });
    const pmLast = spy.requests[4]!.segments.map(s => s.text);
    expect(pmLast).toEqual([
      BASE_TEMPLATE,
      '[human human] Build a game.', // read at its first request
      '[bot pm] Noted.',
      '[bot logic] Noted.',
      '[bot art] Drew sprites.',
      '[tool art] submitDeliverable: ok',
      '[deliverable art v1 ref]',
      '[bot logic] Wrote rules.',
      '[human human] Ping pm.',
    ]);
    const logicLast = spy.requests[3]!.segments.map(s => s.text);
    expect(logicLast.filter(t => t === '[human human] Build a game.')).toHaveLength(1);
  });

  test('D: own history append-only; cacheable = previous request', async () => {
    const { records } = await runScenario(fourSteps(), createPolicy('D', defaults));
    const T = defaultCountTokens(BASE_TEMPLATE);
    // Hand counts (ASCII → ceil(chars / 4)):
    const H = 7;        // "[human human] Build a game." = 27
    const pmN = 4;      // "[bot pm] Noted." = 15
    const logN = 5;     // "[bot logic] Noted." = 18
    const taskArt = 9;  // "[task art] work on workstream art" = 33 (private)
    const artReply = 6; // "[bot art] Drew sprites." = 23
    const tool = 8;     // "[tool art] submitDeliverable: ok" = 32
    const ref = 6;      // "[deliverable art v1 ref]" = 24
    const taskLogic = 10; // "[task logic] work on workstream logic" = 37
    const logReply = 6; // "[bot logic] Wrote rules." = 24
    const ping = 6;     // "[human human] Ping pm." = 22

    expect(records[0]).toMatchObject({ inputTokens: T + H, cacheableTokens: T });
    expect(records[1]).toMatchObject({ inputTokens: T + H + pmN, cacheableTokens: T });
    expect(records[2]).toMatchObject({ inputTokens: T + H + pmN + logN + taskArt, cacheableTokens: T });
    // logic scripted: previous request was T + H + pmN; new = its own Noted., art reply/tool/ref, task
    expect(records[3]).toMatchObject({
      inputTokens: T + H + pmN + logN + artReply + tool + ref + taskLogic,
      cacheableTokens: T + H + pmN,
    });
    // pm extra at step 3: previous request was T + H; everything else is new
    expect(records[4]).toMatchObject({
      inputTokens: T + H + pmN + logN + artReply + tool + ref + logReply + ping,
      cacheableTokens: T + H,
    });
  });
});
