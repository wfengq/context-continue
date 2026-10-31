import { describe, expect, test } from 'vitest';
import { defaultCountTokens } from '@context-continue/core';
import { createPolicy } from '../src/policies/index.js';
import { BASE_TEMPLATE, runScenario } from '../src/runner.js';
import { ScriptedModel, type ModelRequest } from '../src/model.js';
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

const deliver = (id: string, content: string) => [{ name: 'submitDeliverable', args: { workstreamId: id, summary: 's', content } }];

/** Runs group F and also captures the segments of every request. */
async function runCapturing(steps: unknown[]) {
  const seen: ModelRequest[] = [];
  const inner = new ScriptedModel('Noted.');
  const model = { complete: async (r: ModelRequest) => (seen.push(r), inner.complete(r)) };
  const { records } = await runScenario(scenario(steps), createPolicy('F', defaults), { model });
  return { records, seen };
}
const textOf = (r: ModelRequest) => r.segments.map(s => s.text).join('\n');

describe('group F (Dots + Space-style shared pages)', () => {
  test('F: pages = one project page plus one page per workstream with its latest deliverable', async () => {
    const { seen } = await runCapturing([
      { kind: 'work', botId: 'art', workstreamId: 'art', reply: 'v1', ops: deliver('art', 'FIRST sprites') },
      { kind: 'work', botId: 'art', workstreamId: 'art', reply: 'v2', ops: deliver('art', 'LATEST sprites') },
      { kind: 'work', botId: 'logic', workstreamId: 'logic', reply: 'x' },
    ]);
    const text = textOf(seen[2]!);
    expect(text).toContain('LATEST sprites');
    expect(text).not.toContain('FIRST sprites');
    expect(text.match(/\[page project\]/g)).toHaveLength(1);
    expect(text).not.toContain('[page workstream logic]'); // no deliverable, no page
    // the deliverable is not duplicated into the history
    expect(text.match(/LATEST sprites/g)).toHaveLength(1);
    expect(text).not.toContain('[deliverable');
  });

  test('F: decisions, failures and conventions are appended to the project page in order', async () => {
    const { seen } = await runCapturing([
      { kind: 'work', botId: 'art', workstreamId: 'art', reply: 'a', ops: [{ name: 'proposeDecision', args: { t: 'D1' } }] },
      { kind: 'work', botId: 'art', workstreamId: 'art', reply: 'b', ops: [{ name: 'recordFailure', args: { t: 'F1' } }] },
      { kind: 'review', deliverableOf: 'art', passed: true, notes: 'ok', conventions: ['C1', 'C2'] },
      { kind: 'work', botId: 'art', workstreamId: 'art', reply: 'c', ops: [{ name: 'promote', args: { t: 'P1' } }] },
      { kind: 'work', botId: 'logic', workstreamId: 'logic', reply: 'd' },
    ]);
    const project = seen[4]!.segments.find(s => s.text.startsWith('[page project]'))!.text;
    const at = ['"D1"', '"F1"', 'convention: C1', 'convention: C2', '"P1"'].map(k => project.indexOf(k));
    expect(at.every(i => i > 0)).toBe(true);
    expect([...at].sort((x, y) => x - y)).toEqual(at);
    expect(project.startsWith('[page project] goal: g | constraints: none')).toBe(true);
  });

  test('F: unchanged pages → template + pages + old history cacheable; changed pages → only template cacheable', async () => {
    const { records } = await runCapturing([
      { kind: 'human', text: 'Build a game.', mentions: ['art'] },
      { kind: 'work', botId: 'art', workstreamId: 'art', reply: 'Drew sprites.', ops: deliver('art', 'sprite sheet') },
      { kind: 'work', botId: 'art', workstreamId: 'art', reply: 'Checked.' },
      { kind: 'work', botId: 'art', workstreamId: 'art', reply: 'Again.' },
    ]);
    const T = defaultCountTokens(BASE_TEMPLATE);
    // Hand counts (ASCII → ceil(chars / 4)):
    const P0 = 11;     // "[page project] goal: g | constraints: none" = 42
    const H = 7;       // "[human human] Build a game." = 27
    const task = 9;    // "[task art] work on workstream art" = 33
    const reply1 = 6;  // "[bot art] Drew sprites." = 23
    const tool = 8;    // "[tool art] submitDeliverable: ok" = 32
    const pageArt = 9; // "[page workstream art] sprite sheet" = 34
    const reply2 = 5;  // "[bot art] Checked." = 18
    expect(records.map(r => [r.step, r.kind])).toEqual([[1, 'scripted'], [2, 'scripted'], [3, 'scripted']]); // step 0 merged
    // step 1: first request → only template cacheable
    expect(records[0]).toMatchObject({ inputTokens: T + P0 + H + task, cacheableTokens: T });
    // step 2: the deliverable changed the pages → only template cacheable
    expect(records[1]).toMatchObject({ inputTokens: T + P0 + pageArt + (H + task + reply1 + tool) + task, cacheableTokens: T });
    // step 3: pages identical to step 2's → template + pages + step 2's whole history cacheable
    const prev = T + P0 + pageArt + (H + task + reply1 + tool + task);
    expect(records[1]!.inputTokens).toBe(prev);
    expect(records[2]).toMatchObject({ inputTokens: prev + reply2 + task, cacheableTokens: prev });
  });

  test('F: only @mentioned bots are woken by human messages; unaddressed human wakes nobody; bots never wake each other', async () => {
    const { records } = await runCapturing([
      { kind: 'human', text: 'Anyone?' }, // wakes nobody
      { kind: 'human', text: 'Hi.', mentions: ['logic', 'pm'] },
      { kind: 'work', botId: 'art', workstreamId: 'art', reply: 'Drew.', ops: deliver('art', 'sprites') }, // wakes nobody
      { kind: 'human', text: 'Go.', mentions: ['art'] }, // art merged into step 4
      { kind: 'work', botId: 'art', workstreamId: 'art', reply: 'More.' },
    ]);
    expect(records.map(r => [r.botId, r.kind, r.step])).toEqual([
      ['pm', 'extra', 1], ['logic', 'extra', 1], // roster order, mentioned only
      ['art', 'scripted', 2],
      ['art', 'scripted', 4],
    ]);
  });

  test('F: a mention-only wake costs the pages but is a pass: the idle reply is not added to history', async () => {
    const { seen } = await runCapturing([
      { kind: 'human', text: 'Hi.', mentions: ['logic'] },
      { kind: 'work', botId: 'art', workstreamId: 'art', reply: 'x' },
      { kind: 'human', text: 'Again.', mentions: ['logic'] },
    ]);
    const second = textOf(seen[2]!);
    expect(second).toContain('[human human] Hi.');
    expect(second).not.toContain('Noted.');
    expect(second).not.toContain('[bot art]'); // other bots' replies are not in logic's history
  });
});
