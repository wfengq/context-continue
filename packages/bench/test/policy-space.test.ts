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
      { kind: 'work', botId: 'art', workstreamId: 'art', reply: 'a', ops: [{ name: 'proposeDecision', args: { text: 'D1', rationale: 'R1', rejected: ['x', 'y'], affects: ['art', 'logic'], sourceEntryIds: ['e1'] } }] },
      { kind: 'work', botId: 'art', workstreamId: 'art', reply: 'b', ops: [{ name: 'recordFailure', args: { text: 'F1', reason: 'because', affects: ['art'] } }] },
      { kind: 'review', deliverableOf: 'art', passed: true, notes: 'ok', conventions: ['C1', 'C2'] },
      { kind: 'work', botId: 'art', workstreamId: 'art', reply: 'c', ops: [{ name: 'promote', args: { kind: 'fact', text: 'P1', affects: ['logic'], sourceEntryIds: ['e2'] } }] },
      { kind: 'work', botId: 'logic', workstreamId: 'logic', reply: 'd' },
    ]);
    const project = seen[4]!.segments.find(s => s.text.startsWith('[page project]'))!.text;
    const at = ['decision: D1', 'tried: F1', 'convention: C1', 'convention: C2', '\nP1'].map(k => project.indexOf(k));
    expect(at.every(i => i > 0)).toBe(true);
    expect([...at].sort((x, y) => x - y)).toEqual(at);
    expect(project).toContain('decision: D1\n  why: R1\n  rejected: x; y\n  affects: art, logic\ntried: F1\n  why it failed: because\n  affects: art\nconvention');
    expect(project).toContain('\nP1\n  affects: logic');
    expect(project).not.toMatch(/sourceEntryIds|e1|e2|\{/);
    expect(project.startsWith('[page project] goal: g | constraints: none')).toBe(true);
  });

  test('F: cacheable = identical leading run (R-B19): unchanged pages → template + pages + old history; a changed page un-caches itself and all after it', async () => {
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
    // step 2: the deliverable added the art page after the unchanged project page → the identical
    // leading run is template + project page (R-B19); the new page and all history after it are not cacheable
    expect(records[1]).toMatchObject({ inputTokens: T + P0 + pageArt + (H + task + reply1 + tool) + task, cacheableTokens: T + P0 });
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

  test('F: promote renders by kind in the core layout, without kind or sourceEntryIds; token count by hand', async () => {
    const { seen, records } = await runCapturing([
      { kind: 'work', botId: 'art', workstreamId: 'art', reply: 'p', ops: [
        { name: 'promote', args: { kind: 'decision', text: 'Use grid', rationale: 'simple', affects: ['art'], sourceEntryIds: ['e9'] } },
        { name: 'promote', args: { kind: 'failure', text: 'Tried A', reason: 'slow', affects: ['logic'], sourceEntryIds: ['e8'] } },
      ] },
      { kind: 'work', botId: 'art', workstreamId: 'art', reply: 'q' },
    ]);
    const project = seen[1]!.segments[1]!.text;
    expect(project).toBe(
      '[page project] goal: g | constraints: none\n' +
      'decision: Use grid\n  why: simple\n  affects: art\n' +
      'tried: Tried A\n  why it failed: slow\n  affects: logic');
    expect(project).not.toMatch(/kind|e9|e8|sourceEntryIds/);
    const T = defaultCountTokens(BASE_TEMPLATE);
    // Hand counts (ASCII, ceil(chars / 4)). Project page chars: 42 (header) + 18 ("decision: Use grid") + 13 ("  why: simple")
    // + 14 ("  affects: art") + 14 ("tried: Tried A") + 21 ("  why it failed: slow") + 16 ("  affects: logic") + 6 newlines = 144 -> 36.
    const page = 36;
    // Step 1 history: task (33 chars -> 9) + reply "[bot art] p" (11 -> 3) + two promote tool lines that now carry their
    // string fields (R-L4: kind/text/rationale or reason); step 2 adds its task (9).
    const tool = (rest: string) => defaultCountTokens(`[tool art] promote: ok\n${rest}`);
    const t1 = tool('  kind: decision\n  text: Use grid\n  rationale: simple');
    const t2 = tool('  kind: failure\n  text: Tried A\n  reason: slow');
    expect(records[1]!.inputTokens).toBe(T + page + 9 + 3 + t1 + t2 + 9);
    expect(records[1]!.cacheableTokens).toBe(T); // the pages changed
  });

  test('F: pages follow the current plan — a replan adds a workstream whose page reaches the reviewer and invalidates the cache (R-B20)', async () => {
    const replanned = { workstreams: [ws('art', 'art'), ws('logic', 'logic'), ws('sound', 'logic')], contracts: [] };
    const { seen } = await runCapturing([
      { kind: 'work', botId: 'art', workstreamId: 'art', reply: 'Drew.', ops: deliver('art', 'sprites') },
      { kind: 'replan', plan: replanned },
      { kind: 'work', botId: 'logic', workstreamId: 'sound', reply: 'Beeps.', ops: deliver('sound', 'BEEP-BOOP sound pack') },
      { kind: 'review', deliverableOf: 'sound', passed: true, notes: 'ok' },
    ]);
    const review = seen[3]!;
    expect(review.botId).toBe('pm');
    const idx = review.segments.findIndex(g => g.text === '[page workstream sound] BEEP-BOOP sound pack');
    expect(idx).toBeGreaterThan(0);
    // pm's previous request (the replan) had template, project page, art page: those stay cacheable;
    // the new sound page and everything after it are not.
    expect(review.segments.map(g => g.cacheable)).toEqual(review.segments.map((_, i) => i < idx));
  });

  test('F: a replan that removes a workstream drops its page (R-B20)', async () => {
    const { seen } = await runCapturing([
      { kind: 'work', botId: 'logic', workstreamId: 'logic', reply: 'Coded.', ops: deliver('logic', 'OLD-LOGIC rules') },
      { kind: 'replan', plan: { workstreams: [ws('art', 'art')], contracts: [] } },
      { kind: 'work', botId: 'art', workstreamId: 'art', reply: 'Drew.' },
    ]);
    expect(textOf(seen[1]!)).toContain('OLD-LOGIC rules');
    expect(textOf(seen[2]!)).not.toContain('OLD-LOGIC rules');
  });

  test('F: an unmentioned human message wakes nobody but is appended to the project page (R-B20)', async () => {
    const { records, seen } = await runCapturing([
      { kind: 'work', botId: 'art', workstreamId: 'art', reply: 'Drew.' },
      { kind: 'human', text: 'Change of plan: use 8px tiles.' },
      { kind: 'work', botId: 'art', workstreamId: 'art', reply: 'Redrew.' },
    ]);
    expect(records.map(r => [r.botId, r.step])).toEqual([['art', 0], ['art', 2]]);
    const project = seen[1]!.segments[1]!;
    expect(project.text).toBe('[page project] goal: g | constraints: none\n[human human] Change of plan: use 8px tiles.');
    // the project page changed, so only the template is cacheable
    expect(seen[1]!.segments.map(g => g.cacheable)).toEqual(seen[1]!.segments.map((_, i) => i === 0));
  });
});
