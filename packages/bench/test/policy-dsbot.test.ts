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
  human('Continue.', ['pm']),    // 7: resets the counter; parked logic, audio resume (+2 → 2)
  work('art', storm),            // 8: +3 → 5
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
    const taskArt = 9;  // "[task art] work on workstream art" = 33
    const artReply = 6; // "[bot art] Drew sprites." = 23
    const taskLogic = 10; // "[task logic] work on workstream logic" = 37
    // Idle replies are passes (R-B10): not in the room, not in the member's own history.
    // First request: only the template is cacheable; the frozen memory counts from the second (R-B19).
    expect(records[0]).toMatchObject({ inputTokens: T + M + H, cacheableTokens: T });
    expect(records[1]).toMatchObject({ inputTokens: T + M + H, cacheableTokens: T });
    expect(records[2]).toMatchObject({ inputTokens: T + M + H + taskArt, cacheableTokens: T });
    // logic: previous request T+M+H; then art's reply (unseen), task.
    expect(records[3]).toMatchObject({
      inputTokens: T + M + H + artReply + taskLogic,
      cacheableTokens: T + M + H,
    });
    expect(texts(spy.requests[3]!)).toEqual([
      BASE_TEMPLATE, MEMORY_EMPTY,
      '[human human] Build a game.', '[bot art] Drew sprites.', '[task logic] work on workstream logic',
    ]);
    // art's tool line and deliverable never reach logic
    expect(texts(spy.requests[3]!).some(t => t.startsWith('[tool') || t.startsWith('[deliverable'))).toBe(false);
  });

  test('E: first wake shows the last 12 room lines, later wakes at most 24 unseen lines from others', async () => {
    const spy = new SpyModel();
    const steps: unknown[] = [];
    for (let k = 1; k <= 15; k++) steps.push(human(`m${k}`, ['art']), work('art', `r${k}`)); // lines 1..30 (art merged)
    steps.push(human('q1', ['logic']));                                 // 31 (logic merged into the next step)
    steps.push(work('logic', 'L1'));                                    // 32: logic's own line
    for (let k = 16; k <= 20; k++) steps.push(work('art', `r${k}`));    // 33..37
    steps.push(human('q2', ['logic']));                                 // 38
    for (let k = 21; k <= 30; k++) steps.push(work('art', `r${k}`));    // 39..48
    steps.push(human('q3', ['logic']));                                 // 49
    steps.push(human('p1', ['art']));                                   // 50 (art merged)
    for (let k = 31; k <= 54; k++) steps.push(work('art', `r${k}`));    // 51..74
    steps.push(work('art', 'r55 @logic look'));                         // 75 → wakes logic
    await run('E', team(['pm', 'art', 'logic'], steps), {}, spy);
    const logic = spy.requests.filter(r => r.botId === 'logic');
    expect(logic.map(r => r.scripted === null)).toEqual([false, true, true, true]);
    const h = (t: string) => `[human human] ${t}`;
    const a = (k: number) => `[bot art] r${k}`;
    const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => a(from + i));
    // First wake (scripted): room lines 20..31 = r10, m11, r11, ..., m15, r15, q1 — then the task.
    const first = [a(10), h('m11'), a(11), h('m12'), a(12), h('m13'), a(13), h('m14'), a(14), h('m15'), a(15), h('q1')];
    const s0 = [...first, '[task logic] work on workstream logic', '[bot logic] L1'];
    expect(texts(logic[0]!)).toEqual([BASE_TEMPLATE, MEMORY_EMPTY, ...s0.slice(0, -1)]);
    // Second wake: line 32 is logic's own (already in its session) → 33..38 = 6 lines (7 if it were not excluded)
    const s1 = [...range(16, 20), h('q2')];
    expect(texts(logic[1]!)).toEqual([BASE_TEMPLATE, MEMORY_EMPTY, ...s0, ...s1]);
    // Third wake: 39..48 are 10 lines before the latest human message → newest 8 (r23..r30), then q3
    const s2 = [...range(23, 30), h('q3')];
    expect(texts(logic[2]!)).toEqual([BASE_TEMPLATE, MEMORY_EMPTY, ...s0, ...s1, ...s2]);
    // Fourth wake: 50..75 = 26 lines, all from the latest human message on → newest 24 = 52..75
    const s3 = [...range(32, 54), '[bot art] r55 @logic look'];
    expect(s3).toHaveLength(24);
    expect(texts(logic[3]!)).toEqual([BASE_TEMPLATE, MEMORY_EMPTY, ...s0, ...s1, ...s2, ...s3]);
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
    // exact: step 0 pm; steps 1–4 three each (12 = 4 × 3); none at 5–6 (parked pm, logic, audio once);
    // step 7: pm (human @) then parked logic, audio (pm already woken); three at 8
    expect([0, 1, 2, 3, 4, 5, 6, 7, 8].map(i => extras(records, i).length)).toEqual([1, 3, 3, 3, 3, 0, 0, 3, 3]);
    expect(extras(records, 7)).toEqual(['pm', 'logic', 'audio']);
    expect(extras(records, 8)).toEqual(['pm', 'logic', 'audio']);
  });

  test('E: a second storm after a human message is a second pause', async () => {
    const steps = relayStorm().steps.map(s => s as unknown);
    // after step 8 relays = 5; steps 9, 10 → 8, 11; step 11: pm → 12, logic and audio dropped (pause #2)
    for (let k = 0; k < 4; k++) steps.push(work('art', storm)); // steps 9–12
    const { records, stats } = await run('E', team(['pm', 'art', 'logic', 'audio'], steps));
    expect(stats.pauses).toBe(2);
    expect(extras(records, 10)).toHaveLength(3);
    expect(extras(records, 11)).toEqual(['pm']);
    expect(extras(records, 12)).toHaveLength(0);
  });

  test('E: parked bot @ wakes resume after the next human message, merged when due, counted in the new window', async () => {
    const { records, stats } = await run('E', team(['pm', 'art', 'logic', 'audio'], [
      human('Go.', ['pm']),         // 0
      work('art', storm),           // 1: 3
      work('art', storm),           // 2: 6
      work('art', storm),           // 3: 9
      work('art', storm),           // 4: 12
      work('art', storm),           // 5: dropped → parked [pm, logic, audio], pause #1
      human('More.', ['art']),      // 6: art (human @), then pm (1), logic merged (2), audio (3)
      work('logic', 'ok'),          // 7
      work('art', storm),           // 8: 6
      work('art', storm),           // 9: 9
      work('art', storm),           // 10: 12
      work('art', storm),           // 11: dropped → pause #2 (would be 3 + 9 = 12 → not dropped if the resumed wakes did not count)
    ]));
    expect(extras(records, 6)).toEqual(['art', 'pm', 'audio']);
    expect(records.filter(r => r.step === 7).map(r => [r.botId, r.kind])).toEqual([['logic', 'scripted']]);
    expect(extras(records, 10)).toHaveLength(3);
    expect(extras(records, 11)).toHaveLength(0);
    expect(stats.pauses).toBe(2);
  });

  test('E: group memory segment is frozen per member session; cacheable from the member\'s second request (R-B19)', async () => {
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
      ['art', before, false], ['pm', before, false], ['logic', after, false], ['art', before, true],
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
      [T + M + 9, T],
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

  test('E: the summary is exactly summaryTokens for a non-ASCII bot id', async () => {
    const spy = new SpyModel();
    const id = '美术';
    const ops = [{ name: 'submitDeliverable', args: { workstreamId: id, summary: 's', content: big } }];
    const { records, stats } = await run('E', team([id], [0, 1, 2, 3].map(() => work(id, 'Done.', ops)), { lead: id }),
      { window: 2000, compactRatio: 0.8, summaryTokens: 150 }, spy);
    expect(stats.compactions).toBe(1);
    const k = records.findIndex(r => r.cacheableTokens === 0);
    expect(k).toBe(3);
    expect(defaultCountTokens(spy.requests[k]!.segments[2]!.text)).toBe(150);
  });

  test('E keeps markers seen before a compaction in the summary', async () => {
    const spy = new SpyModel();
    const ops = [{ name: 'submitDeliverable', args: { workstreamId: 'art', summary: 's', content: big } }];
    const s = validateScenario({
      id: 'e', goal: 'g', constraints: [], owner: 'human', lead: 'art',
      employees: [{ botId: 'art', persona: 'p', skills: [] }],
      plan: { workstreams: [ws('art', 'art')], contracts: [] },
      steps: [work('art', 'Rule KEEP-ME-1 and KEEP-ME-2.', ops), work('art', 'Done.', ops), work('art', 'Done.', ops),
        work('art', 'Done.', ops), work('art', 'Done.', ops)],
      facts: [
        { id: 'conv-1', marker: 'KEEP-ME-1', step: 0, audience: ['*'] },
        { id: 'conv-2', marker: 'KEEP-ME-2', step: 0, audience: ['*'] },
      ],
    } as unknown);
    const { records } = await run('E', s, { window: 2000, compactRatio: 0.8, summaryTokens: 150 }, spy);
    const k = records.findIndex(r => r.cacheableTokens === 0);
    expect(k).toBeGreaterThan(0);
    const summary = spy.requests[k]!.segments[2]!.text;
    expect(summary.startsWith('KEEP-ME-1 KEEP-ME-2 ')).toBe(true);
    expect(defaultCountTokens(summary)).toBe(150);
    expect(records[k]!.factsSeen).toEqual(['conv-1', 'conv-2']);
    // Later requests still see them (the summary stays in history).
    expect(records[records.length - 1]!.factsSeen).toEqual(['conv-1', 'conv-2']);
  });

  test('E: a marker only in the uncompacted fresh content is not put into the summary', async () => {
    const spy = new SpyModel();
    const ops = [{ name: 'submitDeliverable', args: { workstreamId: 'art', summary: 's', content: big } }];
    const s = validateScenario({
      id: 'e', goal: 'g', constraints: [], owner: 'human', lead: 'art',
      employees: [{ botId: 'art', persona: 'p', skills: [] }],
      plan: { workstreams: [ws('art', 'art')], contracts: [] },
      steps: [work('art', 'Done.', ops), work('art', 'Done.', ops), work('art', 'Done.', ops), work('art', 'Done LATE-MARK.', ops)],
      facts: [{ id: 'conv-1', marker: 'LATE-MARK', step: 3, audience: ['*'] }],
    } as unknown);
    const { records } = await run('E', s, { window: 2000, compactRatio: 0.8, summaryTokens: 150 }, spy);
    const k = records.findIndex(r => r.cacheableTokens === 0);
    expect(k).toBe(3);
    expect(spy.requests[k]!.segments[2]!.text.includes('LATE-MARK')).toBe(false);
  });

  test('E: markers longer than the summary budget are cut in scenario order, without error', async () => {
    const spy = new SpyModel();
    const ops = [{ name: 'submitDeliverable', args: { workstreamId: 'art', summary: 's', content: big } }];
    const m1 = 'A'.repeat(300), m2 = 'B'.repeat(300);
    const s = validateScenario({
      id: 'e', goal: 'g', constraints: [], owner: 'human', lead: 'art',
      employees: [{ botId: 'art', persona: 'p', skills: [] }],
      plan: { workstreams: [ws('art', 'art')], contracts: [] },
      steps: [work('art', `${m1} ${m2}`, ops), work('art', 'Done.', ops), work('art', 'Done.', ops), work('art', 'Done.', ops)],
      facts: [
        { id: 'conv-1', marker: m1, step: 0, audience: ['*'] },
        { id: 'conv-2', marker: m2, step: 0, audience: ['*'] },
      ],
    } as unknown);
    const { records } = await run('E', s, { window: 2000, compactRatio: 0.8, summaryTokens: 100 }, spy);
    const k = records.findIndex(r => r.cacheableTokens === 0);
    const summary = spy.requests[k]!.segments[2]!.text;
    expect(defaultCountTokens(summary)).toBe(100);
    expect(summary.startsWith(m1)).toBe(true);
    expect(summary.includes(m2)).toBe(false);
  });

  test('E: summaryTokens must be below window × compactRatio', () => {
    expect(() => createPolicy('E', { window: 1000, compactRatio: 0.5, summaryTokens: 500 })).toThrow(/summaryTokens/);
    expect(() => createPolicy('E', { window: 1000, compactRatio: 0.5, summaryTokens: 499 })).not.toThrow();
  });

  test('E: deterministic across runs', async () => {
    const a = await run('E', relayStorm());
    const b = await run('E', relayStorm());
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});
