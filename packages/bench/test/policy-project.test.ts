import { describe, expect, test } from 'vitest';
import { createPolicy } from '../src/policies/index.js';
import { projectPolicy } from '../src/policies/project.js';
import { runScenario } from '../src/runner.js';
import { ScriptedModel, type ModelRequest } from '../src/model.js';
import { validateScenario } from '../src/scenario.js';
import type { CallRecord } from '../src/types.js';

const ws = (id: string, owner: string, dependsOn: string[] = []) => ({ id, title: id, brief: `do ${id}`, owner, dependsOn });
const defaults = { window: 128000, compactRatio: 0.8, summaryTokens: 1500 };

function scenario(steps: unknown[], plan = { workstreams: [ws('art', 'art'), ws('logic', 'logic')], contracts: [] }) {
  return validateScenario({
    id: 'three', goal: 'Build a tiny game', constraints: ['Runs in the browser'], owner: 'human', lead: 'pm',
    employees: [
      { botId: 'pm', persona: 'Project lead', skills: [] },
      { botId: 'art', persona: 'Pixel artist', skills: ['sprites'] },
      { botId: 'logic', persona: 'Game programmer', skills: ['rules'] },
    ],
    plan,
    steps,
  });
}

// Core tool argument shapes (R-B13).
const deliver = (id: string, content: string) => ({ name: 'submitDeliverable', args: { workstreamId: id, summary: `${id} summary`, content } });

/** Runs group C with a fresh policy, capturing every request the model sees. */
async function runC(steps: unknown[], plan?: Parameters<typeof scenario>[1]) {
  const seen: ModelRequest[] = [];
  const inner = new ScriptedModel('Noted.');
  const model = { complete: async (r: ModelRequest) => (seen.push(r), inner.complete(r)) };
  const policy = projectPolicy();
  const { records, stats } = await runScenario(scenario(steps, plan), policy, { model });
  return { records, stats, seen, project: policy.project! };
}
const shape = (records: CallRecord[]) => records.map(r => [r.botId, r.kind, r.step]);
const triggerOf = (r: ModelRequest) => r.segments[6]!.text;
const sum = (segs: { tokens: number }[]) => segs.reduce((n, s) => n + s.tokens, 0);

// human → work(art, delivers) → work(logic)
const threeSteps = () => [
  { kind: 'human', text: 'Build a game.' },
  { kind: 'work', botId: 'art', workstreamId: 'art', reply: 'Drew sprites.', ops: [deliver('art', 'sprite sheet')] },
  { kind: 'work', botId: 'logic', workstreamId: 'logic', reply: 'Wrote rules.' },
];

describe('group C (project board, real core library)', () => {
  test('C: setup runs start → proposePlan → approvePlan; approval wakes become extra requests unless merged', async () => {
    const { records, stats, seen, project } = await runC([
      { kind: 'work', botId: 'art', workstreamId: 'art', reply: 'Drew.' },
      { kind: 'work', botId: 'logic', workstreamId: 'logic', reply: 'Coded.' },
    ]);
    // start wakes pm (needsLead) → extra at step 0 (step 0 is art's). approvePlan wakes art and logic
    // (assigned): art performs step 0, so its wake merges; logic's is an extra request at step 0.
    expect(shape(records)).toEqual([
      ['pm', 'extra', 0],
      ['logic', 'extra', 0],
      ['art', 'scripted', 0],
      ['logic', 'scripted', 1],
    ]);
    expect(stats).toEqual({ compactions: 0, pauses: 0, coreErrors: 0, unfinished: true });
    expect(triggerOf(seen[0]!)).toContain('propose a plan');
    const board = await project.board();
    expect(board.planStatus).toBe('approved');
    expect(board.owner).toBe('human');
    expect(board.workstreams.map(w => [w.id, w.owner])).toEqual([['art', 'art'], ['logic', 'logic']]);
  });

  test('C: each request is the 7-segment brief; cacheable = segments 1–3', async () => {
    const { records } = await runScenario(scenario(threeSteps()), createPolicy('C', defaults));
    expect(records.length).toBeGreaterThan(0);
    for (const r of records) {
      expect(r.group).toBe('C');
      expect(r.segments!.map(s => s.kind)).toEqual(['common', 'board', 'memory', 'projection', 'workspace', 'delta', 'trigger']);
      expect(r.segments!.map(s => s.cacheable)).toEqual([true, true, true, false, false, false, false]);
      expect(r.cacheableTokens).toBe(sum(r.segments!.filter(s => s.cacheable)));
      expect(r.inputTokens).toBe(sum(r.segments!));
      expect(r.cacheableTokens).toBeLessThan(r.inputTokens);
    }
  });

  test('C: ops go through project.callTool and wakes come from the core', async () => {
    const { records, seen, project, stats } = await runC(threeSteps());
    // setup: pm (needsLead) and art, logic (assigned) are extra at step 0 — step 0 is a human step.
    // step 0: the message mentions nobody and the core has no route model → the lead is woken.
    // step 1: art's deliverable makes the core wake pm for review → extra (step 2 is logic's).
    expect(shape(records)).toEqual([
      ['pm', 'extra', 0],
      ['art', 'extra', 0],
      ['logic', 'extra', 0],
      ['pm', 'extra', 0],
      ['art', 'scripted', 1],
      ['pm', 'extra', 1],
      ['logic', 'scripted', 2],
    ]);
    expect(stats.coreErrors).toBe(0);
    const art = (await project.board()).workstreams.find(w => w.id === 'art')!;
    expect(art.deliverables.map(d => d.summary)).toEqual(['art summary']);
    expect(triggerOf(seen[5]!)).toContain(`deliverable ${art.deliverables[0]!.id} of art awaits review`);
    // the scripted request's trigger is the task line
    expect(triggerOf(seen[4]!)).toContain('[task art] work on workstream art');
  });

  test('C: invalid tool args are recorded as a tool error and counted, run continues', async () => {
    const { records, stats, seen } = await runC([
      // proposeDecision needs rationale and a non-empty affects list: the core rejects it.
      { kind: 'work', botId: 'art', workstreamId: 'art', reply: 'Decided.', ops: [{ name: 'proposeDecision', args: { text: 'Use 16px tiles' } }] },
      { kind: 'work', botId: 'art', workstreamId: 'art', reply: 'Drew.', ops: [deliver('art', 'tiles')] },
    ]);
    expect(stats.coreErrors).toBe(1);
    // setup: pm extra, art merged into step 0, logic extra; steps 0 and 1 are art's; the deliverable
    // at step 1 wakes pm (no next step → extra).
    expect(shape(records)).toEqual([
      ['pm', 'extra', 0],
      ['logic', 'extra', 0],
      ['art', 'scripted', 0],
      ['art', 'scripted', 1],
      ['pm', 'extra', 1],
    ]);
    // The error reaches art's next request as tool-result text, once.
    expect(triggerOf(seen[3]!)).toContain('tool error: Invalid arguments for proposeDecision');
    expect(triggerOf(seen[3]!)).toContain('[task art] work on workstream art');
    expect(triggerOf(seen[2]!)).not.toContain('tool error');
    expect(triggerOf(seen[4]!)).not.toContain('tool error');
  });

  test('C: review uses the latest deliverable id of deliverableOf; replan proposes and approves', async () => {
    const replanned = { workstreams: [ws('art', 'art'), ws('logic', 'logic'), ws('sound', 'logic')], contracts: [] };
    const { records, seen, project, stats } = await runC([
      { kind: 'work', botId: 'art', workstreamId: 'art', reply: 'v1', ops: [deliver('art', 'first')] },
      { kind: 'review', deliverableOf: 'art', passed: false, notes: 'Too light.' },
      { kind: 'work', botId: 'art', workstreamId: 'art', reply: 'v2', ops: [deliver('art', 'second')] },
      { kind: 'review', deliverableOf: 'art', passed: false, notes: 'Still light.' },
      { kind: 'work', botId: 'logic', workstreamId: 'logic', reply: 'Coded.' },
      { kind: 'replan', plan: replanned },
      { kind: 'work', botId: 'logic', workstreamId: 'sound', reply: 'Beeps.' },
    ]);
    expect(stats.coreErrors).toBe(0);
    const board = await project.board();
    const [v1, v2] = board.workstreams.find(w => w.id === 'art')!.deliverables;
    expect(v2!.version).toBe(v1!.version + 1);
    // setup: pm extra, art merged (step 0), logic extra. Review wakes (needsLead → pm reviews next;
    // reviewFailed → art works next) merge, except the second failure: step 4 is logic's → extra.
    // The replan's approval assigns sound to logic, who performs step 6 → merged.
    expect(shape(records)).toEqual([
      ['pm', 'extra', 0],
      ['logic', 'extra', 0],
      ['art', 'scripted', 0],
      ['pm', 'scripted', 1],
      ['art', 'scripted', 2],
      ['pm', 'scripted', 3],
      ['art', 'extra', 3],
      ['logic', 'scripted', 4],
      ['pm', 'scripted', 5],
      ['logic', 'scripted', 6],
    ]);
    // The second review was submitted for v2 (the latest), not v1.
    const failed = triggerOf(seen[6]!);
    expect(failed).toContain(`deliverable ${v2!.id} failed review: Still light.`);
    expect(failed).not.toContain(v1!.id);
    expect(board.workstreams.map(w => w.id)).toEqual(['art', 'logic', 'sound']);
    expect(board.planStatus).toBe('approved');
  });

  test('C: the full product-plan-sized mini scenario closes cleanly', async () => {
    const plan = { workstreams: [ws('art', 'art'), ws('logic', 'logic', ['art'])], contracts: [] };
    const { records, stats, project } = await runC([
      { kind: 'human', text: 'Build a game.' },
      { kind: 'work', botId: 'art', workstreamId: 'art', reply: 'Drew.', ops: [deliver('art', 'sprites')] },
      { kind: 'review', deliverableOf: 'art', passed: true, notes: 'Good.', conventions: ['Sprites are 16px'] },
      { kind: 'work', botId: 'logic', workstreamId: 'logic', reply: 'Coded.', ops: [
        { name: 'sendMessage', args: { text: 'Which sprite is the bird?', act: 'query', mentions: ['art'] } },
        deliver('logic', 'rules'),
      ] },
      { kind: 'review', deliverableOf: 'logic', passed: true, notes: 'Done.' },
    ], plan);
    expect(stats).toEqual({ compactions: 0, pauses: 0, coreErrors: 0, unfinished: false });
    // setup: pm (needsLead) and art (assigned; logic waits for art) are extra at step 0 (human step).
    // step 0: routed to the lead → extra. step 1: deliverable → pm reviews at step 2 → merged.
    // step 2: art passes → logic assigned, performs step 3 → merged.
    // step 3: the query @art wakes art → extra; the deliverable wakes pm, who reviews at step 4 → merged.
    expect(shape(records)).toEqual([
      ['pm', 'extra', 0],
      ['art', 'extra', 0],
      ['pm', 'extra', 0],
      ['art', 'scripted', 1],
      ['pm', 'scripted', 2],
      ['logic', 'scripted', 3],
      ['art', 'extra', 3],
      ['pm', 'scripted', 4],
    ]);
    const board = await project.board();
    expect(board.workstreams.map(w => w.status)).toEqual(['delivered', 'delivered']);
    expect(board.conventions.map(c => c.text)).toEqual(['Sprites are 16px']);
    await project.close({ by: 'human' });
    expect((await project.board()).status).toBe('closed');
  });

  test('C: two runs give identical records', async () => {
    const a = await runScenario(scenario(threeSteps()), createPolicy('C', defaults));
    const b = await runScenario(scenario(threeSteps()), createPolicy('C', defaults));
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
  });
});

describe('group C deterministic ids (R-B23)', () => {
  test('C: two runs send byte-identical request texts (seeded core ids)', async () => {
    const steps = [
      ...threeSteps(),
      { kind: 'review', deliverableOf: 'art', passed: true, notes: 'Good.' },
      { kind: 'work', botId: 'logic', workstreamId: 'logic', reply: 'Uses art.', ops: [deliver('logic', 'rules')] },
    ];
    const a = await runC(steps);
    const b = await runC(steps);
    const texts = (r: Awaited<ReturnType<typeof runC>>) => JSON.stringify(r.seen.map(q => q.segments.map(g => g.text)));
    expect(texts(b)).toBe(texts(a));
    // ids come from the bench's counter, e.g. "dlv-0000000a", not random hex
    const art = (await a.project.board()).workstreams.find(w => w.id === 'art')!;
    expect(art.deliverables[0]!.id).toMatch(/^dlv-[0-9a-f]{8}$/);
    expect(art.deliverables[0]!.id).toBe((await b.project.board()).workstreams.find(w => w.id === 'art')!.deliverables[0]!.id);
  });
});

describe('group C unfinished flag (R-B16)', () => {
  test('C: finish() reports unfinished when a workstream never delivers', async () => {
    const { stats } = await runC([{ kind: 'work', botId: 'art', workstreamId: 'art', reply: 'Drew.' }]);
    expect(stats.unfinished).toBe(true);
  });
});
