import { describe, expect, test } from 'vitest';
import { defaultCountTokens } from '@context-continue/core';
import { ScriptedModel, type Model, type ModelRequest } from '../src/model.js';
import { createPolicy, type PolicyOptions } from '../src/policies/index.js';
import { BASE_TEMPLATE, runScenario } from '../src/runner.js';
import { validateScenario } from '../src/scenario.js';
import type { CallRecord, Group, Scenario } from '../src/types.js';

const ws = (id: string, owner: string) => ({ id, title: id, brief: `do ${id}`, owner, dependsOn: [] as string[] });
const defaults: PolicyOptions = { window: 128000, compactRatio: 0.8, summaryTokens: 1500 };
const T = defaultCountTokens(BASE_TEMPLATE);
// "[group memory] goal: g | constraints: none | conventions: none" = 62 chars → 16
const M = 16;
const MEMORY_EMPTY = '[group memory] goal: g | constraints: none | conventions: none';

class SpyModel implements Model {
  requests: ModelRequest[] = [];
  private readonly inner = new ScriptedModel('Noted.');
  async complete(r: ModelRequest) {
    this.requests.push(r);
    return this.inner.complete(r);
  }
}

function team(botIds: string[], steps: unknown[], extra: { constraints?: string[]; goal?: string; lead?: string } = {}) {
  return validateScenario({
    id: 'e', goal: extra.goal ?? 'g', constraints: extra.constraints ?? [], owner: 'human', lead: extra.lead ?? 'pm',
    employees: botIds.map(botId => ({ botId, persona: 'p', skills: [] })),
    plan: { workstreams: botIds.map(b => ws(b, b)), contracts: [] },
    steps,
  });
}

const run = (group: Group, s: Scenario, opts: Partial<PolicyOptions> = {}, model?: Model) =>
  runScenario(s, createPolicy(group, { ...defaults, ...opts }), model ? { model } : {});

const human = (text: string, mentions?: string[]) => (mentions ? { kind: 'human', text, mentions } : { kind: 'human', text });
const work = (botId: string, reply: string, ops?: unknown[]) => ({ kind: 'work', botId, workstreamId: botId, reply, ...(ops ? { ops } : {}) });
const texts = (r: ModelRequest) => r.segments.map(s => s.text);
const extras = (records: CallRecord[], step: number) => records.filter(r => r.kind === 'extra' && r.step === step).map(r => r.botId);

// Roster: lead pm listed last in the scenario on purpose — it still goes first.
const humanOnly = () => team(['art', 'logic', 'audio', 'pm'], [human('Hi all.')]);
const extraWakeOrder = (records: CallRecord[]) => records.filter(r => r.kind === 'extra').map(r => r.botId);

const storm = 'Done. @pm @logic @audio please sync.';
// 4 members → relay limit 12. Steps 1–4 make 12 bot wakes; step 5 and 6 are past the limit.
const relayStorm = () => team(['pm', 'art', 'logic', 'audio'], [
  human('Go.', ['pm']),          // 0
  work('art', storm),            // 1: +3 → 3
  work('art', storm),            // 2: +3 → 6
  work('art', storm),            // 3: +3 → 9
  work('art', storm),            // 4: +3 → 12
  work('art', storm),            // 5: dropped, pause #1
  work('art', storm),            // 6: dropped, same pause
  human('Continue.', ['pm']),    // 7: resets the counter
  work('art', storm),            // 8: +3 → 3
]);
const extraAfterPause = (records: CallRecord[]) => records.filter(r => r.kind === 'extra' && (r.step === 5 || r.step === 6)).length;
const extraAfterNextHuman = (records: CallRecord[]) => records.filter(r => r.kind === 'extra' && r.step === 8).length;

const big = 'x'.repeat(2400);
const submit = [{ name: 'submitDeliverable', args: { workstreamId: 'art', summary: 's', content: big } }];
const longScenario = () => team(['art'], [0, 1, 2, 3, 4].map(() => work('art', 'Done.', submit)), { lead: 'art' });
const compactedRecord = (records: CallRecord[]) => records.find(r => r.cacheableTokens === 0)!;

describe('group E (DS Bot-style group chat)', () => {
  test('E: hand-counted tokens; tool lines stay private; own lines are not unseen', async () => {
    const spy = new SpyModel();
    const { records, stats } = await run('E', team(['pm', 'art', 'logic'], [
      human('Build a game.'),
      work('art', 'Drew sprites.', [{ name: 'submitDeliverable', args: { workstreamId: 'art', summary: 's', content: 'sprite sheet' } }]),
      work('logic', 'Wrote rules.'),
    ]), {}, spy);
    expect(stats).toEqual({ compactions: 0, pauses: 0, coreErrors: 0 });
    // art is merged into step 1; pm (lead) then logic get extra requests.
    expect(records.map(r => [r.botId, r.kind, r.step])).toEqual([
      ['pm', 'extra', 0], ['logic', 'extra', 0], ['art', 'scripted', 1], ['logic', 'scripted', 2],
    ]);
    const H = 7;        // "[human human] Build a game." = 27
    const pmN = 4;      // "[bot pm] Noted." = 15
    const logN = 5;     // "[bot logic] Noted." = 18
    const taskArt = 9;  // "[task art] work on workstream art" = 33
    const artReply = 6; // "[bot art] Drew sprites." = 23
    const taskLogic = 10; // "[task logic] work on workstream logic" = 37
    // Memory is cacheable from the first request (frozen system-prompt-like segment).
    expect(records[0]).toMatchObject({ inputTokens: T + M + H, cacheableTokens: T + M });
    expect(records[1]).toMatchObject({ inputTokens: T + M + H + pmN, cacheableTokens: T + M });
    expect(records[2]).toMatchObject({ inputTokens: T + M + H + pmN + logN + taskArt, cacheableTokens: T + M });
    // logic: previous request T+M+H+pmN; then its own reply (session), art's reply (unseen), task.
    expect(records[3]).toMatchObject({
      inputTokens: T + M + H + pmN + logN + artReply + taskLogic,
      cacheableTokens: T + M + H + pmN,
    });
    expect(texts(spy.requests[3]!)).toEqual([
      BASE_TEMPLATE, MEMORY_EMPTY,
      '[human human] Build a game.', '[bot pm] Noted.', '[bot logic] Noted.',
      '[bot art] Drew sprites.', '[task logic] work on workstream logic',
    ]);
    // art's tool line and deliverable never reach logic
    expect(texts(spy.requests[3]!).some(t => t.startsWith('[tool') || t.startsWith('[deliverable'))).toBe(false);
  });

  test('E: first wake shows the last 12 room lines, later wakes at most 24 unseen lines from others', async () => {
    const spy = new SpyModel();
    const steps: unknown[] = [];
    for (let k = 1; k <= 15; k++) steps.push(human(`m${k}`, ['art']));   // room lines 1..30
    steps.push(human('q1', ['logic']));                                  // 31; logic replies → 32
    for (let k = 1; k <= 5; k++) steps.push(human(`n${k}`, ['art']));    // 33..42
    steps.push(human('q2', ['logic']));                                  // 43; logic replies → 44
    for (let k = 1; k <= 15; k++) steps.push(human(`p${k}`, ['art']));   // 45..74
    steps.push(human('q3', ['logic']));                                  // 75
    await run('E', team(['pm', 'art', 'logic'], steps), {}, spy);
    const logic = spy.requests.filter(r => r.botId === 'logic');
    expect(logic).toHaveLength(3);
    const A = '[bot art] Noted.';
    const L = '[bot logic] Noted.';
    const h = (t: string) => `[human human] ${t}`;
    // First wake: lines 20..31 = A, m11, A, m12, A, m13, A, m14, A, m15, A, q1
    const first = [A, h('m11'), A, h('m12'), A, h('m13'), A, h('m14'), A, h('m15'), A, h('q1')];
    expect(texts(logic[0]!)).toEqual([BASE_TEMPLATE, MEMORY_EMPTY, ...first]);
    // Second wake: line 32 is logic's own (already in its session), so 33..43 = 11 lines
    const second = [h('n1'), A, h('n2'), A, h('n3'), A, h('n4'), A, h('n5'), A, h('q2')];
    expect(texts(logic[1]!)).toEqual([BASE_TEMPLATE, MEMORY_EMPTY, ...first, L, ...second]);
    // Third wake: 45..75 = 31 lines from others → only the newest 24 (52..75): p4's reply onward
    const all = [];
    for (let k = 1; k <= 15; k++) all.push(h(`p${k}`), A);
    all.push(h('q3'));
    const third = all.slice(-24);
    expect(third[0]).toBe(A); // reply to p4 (line 52)
    expect(third[1]).toBe(h('p5'));
    expect(texts(logic[2]!)).toEqual([BASE_TEMPLATE, MEMORY_EMPTY, ...first, L, ...second, L, ...third]);
  });

  test('E: unaddressed human wakes all members in roster order, lead first', async () => {
    expect(extraWakeOrder((await run('E', humanOnly())).records)).toEqual(['pm', 'art', 'logic', 'audio']);
  });

  test('E: a human message with mentions wakes only the mentioned members', async () => {
    const { records } = await run('E', team(['pm', 'art', 'logic', 'audio'], [human('Hey.', ['audio', 'art'])]));
    expect(extraWakeOrder(records)).toEqual(['art', 'audio']); // roster order
  });

  test('E: "@logic" in a bot reply wakes logic', async () => {
    const { records, stats } = await run('E', team(['pm', 'art', 'logic'], [
      work('art', 'Sprites ready, @logic please wire them. Not @logical or @pmx.'),
      work('pm', 'OK.'),
      work('pm', 'Ask @logic next.'), // logic is not the next actor of step 3 → extra
      work('art', 'Again @pm'),       // pm is the next actor → merged, no extra
      work('pm', 'Fine.'),
    ]));
    expect(records.map(r => [r.botId, r.kind, r.step])).toEqual([
      ['art', 'scripted', 0], ['logic', 'extra', 0],
      ['pm', 'scripted', 1],
      ['pm', 'scripted', 2], ['logic', 'extra', 2],
      ['art', 'scripted', 3],
      ['pm', 'scripted', 4],
    ]);
    expect(stats.pauses).toBe(0);
  });

  test('E: relay limit members×3 pauses bot @ wakes until the next human message', async () => {
    const { records, stats } = await run('E', relayStorm());
    expect(stats.pauses).toBe(1);
    expect(extraAfterPause(records)).toBe(0);
    expect(extraAfterNextHuman(records)).toBeGreaterThan(0);
    // exact: step 0 pm; steps 1–4 three each (12 = 4 × 3); none at 5–6; pm at 7; three at 8
    expect([0, 1, 2, 3, 4, 5, 6, 7, 8].map(i => extras(records, i).length)).toEqual([1, 3, 3, 3, 3, 0, 0, 1, 3]);
    expect(extras(records, 8)).toEqual(['pm', 'logic', 'audio']);
  });

  test('E: a second storm after a human message is a second pause', async () => {
    const steps = relayStorm().steps.map(s => s as unknown);
    for (let k = 0; k < 4; k++) steps.push(work('art', storm)); // steps 9–12: +3,+3,+3 → 12, then dropped
    const { records, stats } = await run('E', team(['pm', 'art', 'logic', 'audio'], steps));
    expect(stats.pauses).toBe(2);
    expect(extras(records, 11)).toHaveLength(3);
    expect(extras(records, 12)).toHaveLength(0);
  });

  test('E: group memory segment is frozen per member session and cacheable', async () => {
    const spy = new SpyModel();
    const { records } = await run('E', team(['pm', 'art', 'logic'], [
      work('art', 'A.'),                                                                    // 0: art first wake
      { kind: 'review', deliverableOf: 'art', passed: true, notes: 'ok', conventions: ['use 16px grid'] }, // 1: pm first wake
      work('logic', 'L.'),                                                                  // 2: logic sees the convention
      work('art', 'A2.'),                                                                   // 3: art's memory unchanged
    ], { constraints: ['c1'] }), {}, spy);
    const before = '[group memory] goal: g | constraints: c1 | conventions: none';
    const after = '[group memory] goal: g | constraints: c1 | conventions: use 16px grid';
    expect(spy.requests.map(r => [r.botId, r.segments[1]!.text, r.segments[1]!.cacheable])).toEqual([
      ['art', before, true], ['pm', before, true], ['logic', after, true], ['art', before, true],
    ]);
    // art at step 3: previous request = T + memory(60 chars → 15) + task(9); new: own reply, tool-less,
    // others' replies "[bot pm] ok"(11 → 3), "[bot logic] L."(14 → 4), task 9
    const mem = 15; // before = 60 chars
    expect(records[3]).toMatchObject({ botId: 'art', cacheableTokens: T + mem + 9 });
    // own reply "[bot art] A." = 12 → 3; tool line for submitReview stays with pm
    expect(records[3]!.inputTokens).toBe(T + mem + 9 + 3 + 3 + 4 + 9);
  });

  test('E: group memory is cut to 8000 characters', async () => {
    const spy = new SpyModel();
    await run('E', team(['pm'], [work('pm', 'x')], { goal: 'y'.repeat(9000) }), {}, spy);
    const mem = spy.requests[0]!.segments[1]!.text;
    expect(mem).toHaveLength(8000);
    expect(mem.startsWith('[group memory] goal: yyy')).toBe(true);
  });

  test('E: history over window×ratio is replaced by a summaryTokens summary and that request has cacheable 0', async () => {
    const spy = new SpyModel();
    const { records, stats } = await run('E', longScenario(), { window: 2000, compactRatio: 0.8, summaryTokens: 150 }, spy);
    expect(stats.compactions).toBeGreaterThan(0);
    expect(compactedRecord(records).cacheableTokens).toBe(0);
    // Hand counts: task "[task art] work on workstream art" 33 → 9; reply "[bot art] Done." 15 → 4;
    // tool "[tool art] submitDeliverable: ok" 32 → 8; deliverable "[deliverable art vN] " + 2400 x = 2421 → 606.
    // One step adds 4 + 8 + 606 = 618. Threshold 2000 × 0.8 = 1600.
    // r0 history 9; r1 627+9 = 636; r2 1254+9 = 1263; r3 1881+9 = 1890 > 1600 → compact.
    expect(records.map(r => [r.inputTokens, r.cacheableTokens])).toEqual([
      [T + M + 9, T + M],
      [T + M + 636, T + M + 9],
      [T + M + 1263, T + M + 636],
      [T + M + 150 + 9, 0],
      [T + M + 150 + 9 + 618 + 9, T + M + 150 + 9],
    ]);
    expect(stats.compactions).toBe(1);
    expect(compactedRecord(records).step).toBe(3);
    const r3 = texts(spy.requests[3]!);
    expect(r3).toHaveLength(4);
    expect(r3[0]).toBe(BASE_TEMPLATE);
    expect(defaultCountTokens(r3[2]!)).toBe(150);
    expect(r3[3]).toBe('[task art] work on workstream art');
  });

  test('E: deterministic across runs', async () => {
    const a = await run('E', relayStorm());
    const b = await run('E', relayStorm());
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});
