import { describe, expect, test } from 'vitest';
import { applyOp } from '../src/board/apply.js';
import { enforceBoardSize } from '../src/board/archive.js';
import { boardOpSchema, parseOps } from '../src/board/schema.js';
import type { BoardOp, Decision, Item, ProjectBoard, Workstream } from '../src/types.js';

const src = () => ({ entryIds: ['e1'], by: 'art' });
const bot = (by: string) => ({ by, authority: 'bot' as const });
const human = (by: string) => ({ by, authority: 'human' as const });

function empty(): ProjectBoard {
  return {
    projectId: 'p1',
    version: 1,
    updatedAt: 0,
    status: 'active',
    owner: 'alice',
    lead: 'lead',
    goal: 'ship the game',
    constraints: ['no network'],
    planStatus: 'approved',
    conventions: [],
    workstreams: [],
    contracts: [],
    decisions: [],
    facts: [],
    failures: [],
    openQuestions: [],
  };
}

function ws(id: string): Workstream {
  return {
    id,
    title: `ws ${id}`,
    brief: 'do it',
    owner: 'art',
    dependsOn: [],
    writeScopes: [],
    status: 'pending',
    reviewRounds: 0,
    deliverables: [],
  };
}

function item(id: string, authority: 'human' | 'bot' = 'bot', text = `text ${id}`): Item {
  return { id, text, source: src(), authority };
}

function withDecision(id: string): ProjectBoard {
  const d: Decision = {
    ...item(id),
    rationale: 'because',
    rejected: ['16x16'],
    affects: ['w1'],
  };
  return { ...empty(), decisions: [d] };
}

describe('applyOp', () => {
  test('add assigns id and authority from meta', () => {
    const { board, touched } = applyOp(
      empty(),
      { op: 'add', section: 'conventions', item: { text: '16x16 pixel art', source: src() } },
      bot('art'),
    );
    expect(board.conventions[0]).toMatchObject({ text: '16x16 pixel art', authority: 'bot' });
    expect(board.conventions[0]!.id).toMatch(/^cv-/);
    expect(touched).toEqual([board.conventions[0]!.id]);
  });

  test('add to openQuestions creates an item with a q- id', () => {
    const { board } = applyOp(
      empty(),
      { op: 'add', section: 'openQuestions', item: { text: 'which engine?', source: src() } },
      human('alice'),
    );
    expect(board.openQuestions[0]).toMatchObject({ text: 'which engine?', authority: 'human' });
    expect(board.openQuestions[0]!.id).toMatch(/^q-/);
  });

  test('addFact, addDecision and addFailure add typed items', () => {
    let b = empty();
    b = applyOp(b, { op: 'addFact', fact: { text: 'f', affects: ['w1'], source: src() } }, bot('a')).board;
    b = applyOp(
      b,
      { op: 'addDecision', decision: { text: 'd', rationale: 'r', rejected: [], affects: ['w1'], source: src() } },
      human('alice'),
    ).board;
    b = applyOp(
      b,
      { op: 'addFailure', failure: { text: 'x', reason: 'why', affects: ['w1'], source: src() } },
      bot('a'),
    ).board;
    expect(b.facts[0]!.id).toMatch(/^f-/);
    expect(b.decisions[0]).toMatchObject({ authority: 'human', rationale: 'r' });
    expect(b.decisions[0]!.id).toMatch(/^d-/);
    expect(b.failures[0]).toMatchObject({ reason: 'why', authority: 'bot' });
    expect(b.failures[0]!.id).toMatch(/^x-/);
  });

  test('supersede removes the old item and links the new one', () => {
    const b1 = withDecision('d1');
    const { board, archived, touched } = applyOp(
      b1,
      { op: 'supersede', section: 'decisions', id: 'd1', item: { text: 'use 32x32', source: src() } },
      bot('art'),
    );
    expect(board.decisions.map((d) => d.id)).not.toContain('d1');
    expect(board.decisions[0]!.supersedes).toBe('d1');
    expect(board.decisions[0]).toMatchObject({ text: 'use 32x32', rationale: 'because', affects: ['w1'], authority: 'bot' });
    expect(archived[0]).toMatchObject({ section: 'decisions', item: { id: 'd1' } });
    expect(touched).toEqual([board.decisions[0]!.id, 'd1']);
  });

  test('supersede keeps the position of the old item', () => {
    const b: ProjectBoard = { ...empty(), conventions: [item('a'), item('b'), item('c')] };
    const { board } = applyOp(
      b,
      { op: 'supersede', section: 'conventions', id: 'b', item: { text: 'new', source: src() } },
      human('alice'),
    );
    expect(board.conventions.map((c) => c.text)).toEqual(['text a', 'new', 'text c']);
    expect(board.conventions[1]).toMatchObject({ authority: 'human', supersedes: 'b' });
  });

  test('updateContract bumps version', () => {
    const b: ProjectBoard = { ...empty(), contracts: [{ id: 'c1', from: 'w1', to: 'w2', spec: 'png', version: 1 }] };
    const { board, touched } = applyOp(b, { op: 'updateContract', id: 'c1', spec: 'webp' }, bot('art'));
    expect(board.contracts[0]).toMatchObject({ spec: 'webp', version: 2 });
    expect(touched).toEqual(['c1']);
  });

  test('closeQuestion archives the question', () => {
    const b: ProjectBoard = { ...empty(), openQuestions: [item('q1'), item('q2')] };
    const { board, archived } = applyOp(b, { op: 'closeQuestion', id: 'q1' }, bot('x'));
    expect(board.openQuestions.map((q) => q.id)).toEqual(['q2']);
    expect(archived).toHaveLength(1);
    expect(archived[0]).toMatchObject({ section: 'openQuestions', item: { id: 'q1' } });
  });

  test('closeQuestion with an unknown id throws and leaves the questions untouched', () => {
    const b: ProjectBoard = { ...empty(), openQuestions: [item('q1'), item('q2')] };
    const snapshot = structuredClone(b);
    expect(() => applyOp(b, { op: 'closeQuestion', id: 'nope' }, bot('x'))).toThrow(
      expect.objectContaining({ code: 'INVALID_OP' }),
    );
    expect(b).toEqual(snapshot);
  });

  test('addDeliverable appends with incrementing version', () => {
    const b: ProjectBoard = { ...empty(), workstreams: [ws('w1')] };
    const r1 = applyOp(b, { op: 'addDeliverable', workstreamId: 'w1', summary: 's1', ref: 'r1' }, bot('art'));
    const r2 = applyOp(r1.board, { op: 'addDeliverable', workstreamId: 'w1', summary: 's2', ref: 'r2' }, bot('art'));
    const ds = r2.board.workstreams[0]!.deliverables;
    expect(ds.map((d) => d.version)).toEqual([1, 2]);
    expect(ds[1]).toMatchObject({ summary: 's2', ref: 'r2' });
    expect(ds[0]!.id).toMatch(/^dlv-/);
    expect(r2.touched).toEqual(['w1']);
  });

  test('setWorkstreamStatus changes status and touches the workstream', () => {
    const b: ProjectBoard = { ...empty(), workstreams: [ws('w1')] };
    const { board, touched } = applyOp(b, { op: 'setWorkstreamStatus', id: 'w1', status: 'active' }, bot('lead'));
    expect(board.workstreams[0]!.status).toBe('active');
    expect(touched).toEqual(['w1']);
  });

  test('setGoal and setConstraints replace fields', () => {
    let r = applyOp(empty(), { op: 'setGoal', goal: 'new goal' }, human('alice'));
    expect(r.board.goal).toBe('new goal');
    r = applyOp(r.board, { op: 'setConstraints', constraints: ['a', 'b'] }, human('alice'));
    expect(r.board.constraints).toEqual(['a', 'b']);
    expect(r.archived).toEqual([]);
  });

  test('does not change version or updatedAt', () => {
    const { board } = applyOp(empty(), { op: 'setGoal', goal: 'g' }, human('alice'));
    expect(board.version).toBe(1);
    expect(board.updatedAt).toBe(0);
  });

  test.each<[string, BoardOp]>([
    ['closeQuestion', { op: 'closeQuestion', id: 'nope' }],
    ['supersede', { op: 'supersede', section: 'facts', id: 'nope', item: { text: 't', source: src() } }],
    ['setWorkstreamStatus', { op: 'setWorkstreamStatus', id: 'nope', status: 'active' }],
    ['addDeliverable', { op: 'addDeliverable', workstreamId: 'nope', summary: 's', ref: 'r' }],
    ['updateContract', { op: 'updateContract', id: 'nope', spec: 's' }],
  ])('unknown target id throws INVALID_OP (%s)', (_name, op) => {
    expect(() => applyOp(empty(), op, bot('x'))).toThrow(expect.objectContaining({ code: 'INVALID_OP' }));
  });

  test('applyOp does not mutate its input', () => {
    const b: ProjectBoard = {
      ...withDecision('d1'),
      workstreams: [ws('w1')],
      openQuestions: [item('q1')],
      contracts: [{ id: 'c1', from: 'w1', to: 'w2', spec: 'png', version: 1 }],
    };
    const snapshot = structuredClone(b);
    const ops: BoardOp[] = [
      { op: 'supersede', section: 'decisions', id: 'd1', item: { text: 'n', source: src() } },
      { op: 'closeQuestion', id: 'q1' },
      { op: 'addDeliverable', workstreamId: 'w1', summary: 's', ref: 'r' },
      { op: 'setWorkstreamStatus', id: 'w1', status: 'blocked' },
      { op: 'updateContract', id: 'c1', spec: 'x' },
      { op: 'setConstraints', constraints: ['z'] },
      { op: 'add', section: 'conventions', item: { text: 't', source: src() } },
    ];
    for (const op of ops) applyOp(b, op, bot('x'));
    expect(b).toEqual(snapshot);
  });
});

describe('parseOps', () => {
  test('rejects empty affects but keeps valid ops', () => {
    const r = parseOps([
      { op: 'addFact', fact: { text: 'x', affects: [], source: src() } },
      { op: 'setGoal', goal: 'g' },
    ]);
    expect(r.ok).toHaveLength(1);
    expect(r.ok[0]).toEqual({ op: 'setGoal', goal: 'g' });
    expect(r.rejected).toHaveLength(1);
    expect(r.rejected[0]!.index).toBe(0);
    expect(r.rejected[0]!.reason.length).toBeGreaterThan(0);
  });

  test('rejects empty strings, unknown ops and non-objects', () => {
    const r = parseOps([
      { op: 'setGoal', goal: '' },
      { op: 'nope' },
      'str',
      null,
      { op: 'add', section: 'facts', item: { text: 't', source: src() } },
      { op: 'addDecision', decision: { text: 't', rationale: '', rejected: [], affects: ['w'], source: src() } },
    ]);
    expect(r.ok).toEqual([]);
    expect(r.rejected.map((x) => x.index)).toEqual([0, 1, 2, 3, 4, 5]);
  });

  test('supersede via parseOps: supplied type-specific fields override, omitted ones are inherited', () => {
    const base = { op: 'supersede', section: 'decisions', id: 'd1' };
    const r = parseOps([
      { ...base, item: { text: 'new', source: src(), rationale: 'new reason', rejected: ['x'], affects: ['w2'] } },
      { ...base, item: { text: 'new', source: src() } },
    ]);
    expect(r.rejected).toEqual([]);
    const b1 = withDecision('d1');
    const withNew = applyOp(b1, r.ok[0]!, bot('art')).board.decisions[0]!;
    expect(withNew).toMatchObject({ rationale: 'new reason', rejected: ['x'], affects: ['w2'], supersedes: 'd1' });
    const inherited = applyOp(b1, r.ok[1]!, bot('art')).board.decisions[0]!;
    expect(inherited).toMatchObject({ rationale: 'because', rejected: ['16x16'], affects: ['w1'] });
  });

  test('supersede via parseOps: facts and failures fields, empty affects and wrong-section fields rejected', () => {
    const r = parseOps([
      { op: 'supersede', section: 'facts', id: 'f1', item: { text: 't', source: src(), affects: ['w1'] } },
      { op: 'supersede', section: 'failures', id: 'x1', item: { text: 't', source: src(), reason: 'r', affects: ['w1'] } },
      { op: 'supersede', section: 'facts', id: 'f1', item: { text: 't', source: src(), affects: [] } },
      { op: 'supersede', section: 'facts', id: 'f1', item: { text: 't', source: src(), rationale: 'no' } },
      { op: 'supersede', section: 'conventions', id: 'c1', item: { text: 't', source: src(), affects: ['w1'] } },
      { op: 'supersede', section: 'decisions', id: 'd1', item: { text: 't', source: src(), rationale: '' } },
    ]);
    expect(r.ok).toHaveLength(2);
    expect(r.rejected.map((x) => x.index)).toEqual([2, 3, 4, 5]);
  });

  test('accepts every valid op shape', () => {
    const ops: BoardOp[] = [
      { op: 'add', section: 'openQuestions', item: { text: 't', source: src() } },
      { op: 'addFact', fact: { text: 't', affects: ['w'], source: src() } },
      { op: 'addDecision', decision: { text: 't', rationale: 'r', rejected: [], affects: ['w'], source: src() } },
      { op: 'addFailure', failure: { text: 't', reason: 'r', affects: ['w'], source: src() } },
      { op: 'supersede', section: 'failures', id: 'x1', item: { text: 't', source: src() } },
      { op: 'closeQuestion', id: 'q1' },
      { op: 'setWorkstreamStatus', id: 'w1', status: 'delivered' },
      { op: 'addDeliverable', workstreamId: 'w1', summary: 's', ref: 'r' },
      { op: 'updateContract', id: 'c1', spec: 's' },
      { op: 'setGoal', goal: 'g' },
      { op: 'setConstraints', constraints: [] },
    ];
    const r = parseOps(ops);
    expect(r.rejected).toEqual([]);
    expect(r.ok).toEqual(ops);
    expect(boardOpSchema.safeParse(ops[0]).success).toBe(true);
  });
});

describe('enforceBoardSize', () => {
  const count = (s: string) => s.length;
  const render = (b: ProjectBoard) =>
    [b.goal, ...b.constraints, ...b.conventions.map((c) => c.text), ...b.openQuestions.map((q) => q.text), ...b.workstreams.map((w) => w.title)].join('\n');

  function big(): ProjectBoard {
    return {
      ...empty(),
      conventions: [item('c1', 'bot', 'a'.repeat(50)), item('c2', 'human', 'b'.repeat(50)), item('c3', 'bot', 'c'.repeat(50))],
      openQuestions: [item('q1', 'bot', 'd'.repeat(50)), item('q2', 'bot', 'e'.repeat(50))],
      workstreams: [ws('w1')],
    };
  }

  test('returns the board unchanged when within the limit', () => {
    const b = big();
    const r = enforceBoardSize(b, 10_000, count, render);
    expect(r.board).toEqual(b);
    expect(r.archived).toEqual([]);
  });

  test('evicts oldest bot conventions first, then oldest open questions', () => {
    const b = big();
    const full = count(render(b));
    // Just enough to drop c1 only.
    let r = enforceBoardSize(b, full - 40, count, render);
    expect(r.board.conventions.map((c) => c.id)).toEqual(['c2', 'c3']);
    expect(r.archived).toMatchObject([{ section: 'conventions', item: { id: 'c1' } }]);
    // Need to drop both bot conventions, human convention stays.
    r = enforceBoardSize(b, full - 100, count, render);
    expect(r.board.conventions.map((c) => c.id)).toEqual(['c2']);
    expect(r.archived).toHaveLength(2);
    // Then questions, oldest first.
    r = enforceBoardSize(b, full - 140, count, render);
    expect(r.board.openQuestions.map((q) => q.id)).toEqual(['q2']);
    expect(r.archived.map((a) => a.section)).toEqual(['conventions', 'conventions', 'openQuestions']);
  });

  test('never drops goal, constraints, workstreams or human conventions', () => {
    const b = big();
    const r = enforceBoardSize(b, 1, count, render);
    expect(r.board.goal).toBe(b.goal);
    expect(r.board.constraints).toEqual(b.constraints);
    expect(r.board.workstreams).toEqual(b.workstreams);
    expect(r.board.conventions.map((c) => c.id)).toEqual(['c2']);
    expect(r.board.openQuestions).toEqual([]);
    expect(r.archived).toHaveLength(4);
  });

  test('does not mutate its input', () => {
    const b = big();
    const snapshot = structuredClone(b);
    enforceBoardSize(b, 1, count, render);
    expect(b).toEqual(snapshot);
  });
});
