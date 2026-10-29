import { describe, expect, test } from 'vitest';
import { newlyReady, structuralWakes, writeScopeOverlaps } from '../src/board/diff.js';
import type {
  AppliedOp,
  BoardChange,
  BoardOp,
  Contract,
  Decision,
  Failure,
  Fact,
  ProjectBoard,
  Workstream,
} from '../src/types.js';

const src = { entryIds: ['e1'], by: 'someone' };

function ws(id: string, owner: string, over: Partial<Workstream> = {}): Workstream {
  return {
    id,
    title: `ws ${id}`,
    brief: 'do it',
    owner,
    dependsOn: [],
    writeScopes: [],
    status: 'pending',
    reviewRounds: 0,
    deliverables: [],
    ...over,
  };
}

const act = (id: string, scopes: string[], status: Workstream['status'] = 'active') =>
  ws(id, `${id}-bot`, { writeScopes: scopes, status });

const decision = (id: string, affects: string[]): Decision => ({
  id,
  text: `decide ${id}`,
  source: src,
  authority: 'bot',
  rationale: 'because',
  rejected: [],
  affects,
});
const fact = (id: string, affects: string[]): Fact => ({ id, text: `fact ${id}`, source: src, authority: 'bot', affects });
const failure = (id: string, affects: string[]): Failure => ({
  id,
  text: `tried ${id}`,
  source: src,
  authority: 'bot',
  reason: 'nope',
  affects,
});

const wsList = (): Workstream[] => [
  ws('logic', 'logic-bot', { status: 'active' }),
  ws('ui', 'ui-bot', { status: 'active' }),
  ws('art', 'art-bot', { status: 'blocked' }),
];

function makeBoard(over: Partial<ProjectBoard> = {}): ProjectBoard {
  return {
    projectId: 'p1',
    version: 3,
    updatedAt: 0,
    status: 'active',
    owner: 'alice',
    lead: 'lead',
    goal: 'g',
    constraints: [],
    planStatus: 'approved',
    conventions: [],
    workstreams: wsList(),
    contracts: [],
    decisions: [],
    facts: [],
    failures: [],
    openQuestions: [],
    ...over,
  };
}

const applied = (op: BoardOp, touched: string[]): AppliedOp => ({ op, by: 'bot', authority: 'bot', touched });
const change = (...ops: AppliedOp[]): BoardChange => ({ version: 3, mergedAt: 0, ops });

const addDecisionOp = (d: Decision): AppliedOp => {
  const { id: _id, authority: _a, ...rest } = d;
  return applied({ op: 'addDecision', decision: rest }, [d.id]);
};
const addFactOp = (f: Fact): AppliedOp => {
  const { id: _id, authority: _a, ...rest } = f;
  return applied({ op: 'addFact', fact: rest }, [f.id]);
};
const addFailureOp = (f: Failure): AppliedOp => {
  const { id: _id, authority: _a, ...rest } = f;
  return applied({ op: 'addFailure', failure: rest }, [f.id]);
};

describe('structuralWakes', () => {
  test('decision affecting a workstream wakes its owner with decisionChanged', () => {
    const d = decision('d-1a2b', ['logic']);
    const board = makeBoard({ decisions: [d] });
    const w = structuralWakes(change(addDecisionOp(d)), wsList(), wsList(), board);
    expect(w).toEqual([{ botId: 'logic-bot', reason: 'decisionChanged', detail: 'decision d-1a2b affects logic' }]);
  });

  test('facts and failures also trigger decisionChanged', () => {
    const f = fact('f-1', ['logic']);
    const x = failure('x-1', ['ui']);
    const board = makeBoard({ facts: [f], failures: [x] });
    const w = structuralWakes(change(addFactOp(f), addFailureOp(x)), wsList(), wsList(), board);
    expect(w).toEqual([
      { botId: 'logic-bot', reason: 'decisionChanged', detail: 'fact f-1 affects logic' },
      { botId: 'ui-bot', reason: 'decisionChanged', detail: 'failure x-1 affects ui' },
    ]);
  });

  test('supersede of a decision wakes owners affected by the new item', () => {
    const d = decision('d-new', ['ui']);
    const board = makeBoard({ decisions: [d] });
    const op = applied(
      { op: 'supersede', section: 'decisions', id: 'd-old', item: { text: 't', source: src } },
      ['d-new', 'd-old'],
    );
    const w = structuralWakes(change(op), wsList(), wsList(), board);
    expect(w).toEqual([{ botId: 'ui-bot', reason: 'decisionChanged', detail: 'decision d-new affects ui' }]);
  });

  test('supersede of a convention wakes nobody', () => {
    const op = applied(
      { op: 'supersede', section: 'conventions', id: 'cv-old', item: { text: 't', source: src } },
      ['cv-new', 'cv-old'],
    );
    expect(structuralWakes(change(op), wsList(), wsList(), makeBoard())).toEqual([]);
  });

  test('blocked workstream owner still receives decisionChanged', () => {
    const d = decision('d-1', ['art']);
    const w = structuralWakes(change(addDecisionOp(d)), wsList(), wsList(), makeBoard({ decisions: [d] }));
    expect(w).toEqual([{ botId: 'art-bot', reason: 'decisionChanged', detail: 'decision d-1 affects art' }]);
  });

  test('contract update wakes both from and to owners', () => {
    const c: Contract = { id: 'c1', from: 'logic', to: 'ui', spec: 's', version: 2 };
    const op = applied({ op: 'updateContract', id: 'c1', spec: 's' }, ['c1']);
    const w = structuralWakes(change(op), wsList(), wsList(), makeBoard({ contracts: [c] }));
    expect(w).toEqual([
      { botId: 'logic-bot', reason: 'contractChanged', detail: 'contract c1 changed for logic' },
      { botId: 'ui-bot', reason: 'contractChanged', detail: 'contract c1 changed for ui' },
    ]);
  });

  test('contract between workstreams with the same owner wakes once', () => {
    const list = [ws('a', 'bot', { status: 'active' }), ws('b', 'bot', { status: 'active' })];
    const c: Contract = { id: 'c1', from: 'a', to: 'b', spec: 's', version: 2 };
    const op = applied({ op: 'updateContract', id: 'c1', spec: 's' }, ['c1']);
    const w = structuralWakes(change(op), list, list, makeBoard({ workstreams: list, contracts: [c] }));
    expect(w).toEqual([
      { botId: 'bot', reason: 'contractChanged', detail: 'contract c1 changed for a; contract c1 changed for b' },
    ]);
  });

  test('delivery of the last dependency wakes the dependent with upstreamDelivered', () => {
    const before = [ws('a', 'a-bot', { status: 'active' }), ws('b', 'b-bot', { dependsOn: ['a'] })];
    const after = [ws('a', 'a-bot', { status: 'delivered' }), ws('b', 'b-bot', { dependsOn: ['a'] })];
    const op = applied({ op: 'setWorkstreamStatus', id: 'a', status: 'delivered' }, ['a']);
    const w = structuralWakes(change(op), before, after, makeBoard({ workstreams: after }));
    expect(w).toEqual([{ botId: 'b-bot', reason: 'upstreamDelivered', detail: 'dependencies of b delivered' }]);
  });

  test('blocked workstream owner is not woken by upstreamDelivered', () => {
    const before = [ws('a', 'a-bot', { status: 'active' }), ws('b', 'b-bot', { dependsOn: ['a'], status: 'blocked' })];
    const after = [ws('a', 'a-bot', { status: 'delivered' }), ws('b', 'b-bot', { dependsOn: ['a'], status: 'blocked' })];
    const op = applied({ op: 'setWorkstreamStatus', id: 'a', status: 'delivered' }, ['a']);
    expect(structuralWakes(change(op), before, after, makeBoard({ workstreams: after }))).toEqual([]);
  });

  test('one wake per bot per reason even if several ops hit it', () => {
    const d1 = decision('d-1', ['logic', 'ui']);
    const d2 = decision('d-2', ['logic']);
    const f = fact('f-1', ['logic']);
    const board = makeBoard({ decisions: [d1, d2], facts: [f] });
    const w = structuralWakes(
      change(addDecisionOp(d1), addDecisionOp(d2), addFactOp(f)),
      wsList(),
      wsList(),
      board,
    );
    expect(w).toEqual([
      {
        botId: 'logic-bot',
        reason: 'decisionChanged',
        detail: 'decision d-1 affects logic; decision d-2 affects logic; fact f-1 affects logic',
      },
      { botId: 'ui-bot', reason: 'decisionChanged', detail: 'decision d-1 affects ui' },
    ]);
  });

  test('a bot woken for different reasons gets one wake per reason, ordered by reason then botId', () => {
    const before = [
      ws('a', 'a-bot', { status: 'active' }),
      ws('b', 'b-bot', { dependsOn: ['a'] }),
      ws('c', 'c-bot', { status: 'active' }),
    ];
    const after = [
      ws('a', 'a-bot', { status: 'delivered' }),
      ws('b', 'b-bot', { dependsOn: ['a'] }),
      ws('c', 'c-bot', { status: 'active' }),
    ];
    const d = decision('d-1', ['b', 'c', 'a']);
    const c: Contract = { id: 'c1', from: 'c', to: 'b', spec: 's', version: 2 };
    const board = makeBoard({ workstreams: after, decisions: [d], contracts: [c] });
    const w = structuralWakes(
      change(
        applied({ op: 'updateContract', id: 'c1', spec: 's' }, ['c1']),
        addDecisionOp(d),
        applied({ op: 'setWorkstreamStatus', id: 'a', status: 'delivered' }, ['a']),
      ),
      before,
      after,
      board,
    );
    expect(w.map((x) => `${x.reason}:${x.botId}`)).toEqual([
      'upstreamDelivered:b-bot',
      'decisionChanged:a-bot',
      'decisionChanged:b-bot',
      'decisionChanged:c-bot',
      'contractChanged:b-bot',
      'contractChanged:c-bot',
    ]);
  });

  test('skips unknown workstream ids and empty owners', () => {
    const list = [ws('logic', '', { status: 'active' }), ws('ui', 'ui-bot', { status: 'active' })];
    const d = decision('d-1', ['ghost', 'logic', 'ui']);
    const w = structuralWakes(change(addDecisionOp(d)), list, list, makeBoard({ workstreams: list, decisions: [d] }));
    expect(w).toEqual([{ botId: 'ui-bot', reason: 'decisionChanged', detail: 'decision d-1 affects ui' }]);
  });

  test('ignores touched ids missing from the board and unrelated ops', () => {
    const op = applied({ op: 'setGoal', goal: 'x' }, []);
    const ghost = applied({ op: 'updateContract', id: 'nope', spec: 's' }, ['nope']);
    expect(structuralWakes(change(op, ghost), wsList(), wsList(), makeBoard())).toEqual([]);
  });
});

describe('newlyReady', () => {
  test('returns pending workstreams whose dependencies just became all delivered', () => {
    const before = [
      ws('a', 'x', { status: 'active' }),
      ws('b', 'x', { status: 'delivered' }),
      ws('c', 'x', { dependsOn: ['a', 'b'] }),
      ws('d', 'x', { dependsOn: ['b'] }),
    ];
    const after = [
      ws('a', 'x', { status: 'delivered' }),
      ws('b', 'x', { status: 'delivered' }),
      ws('c', 'x', { dependsOn: ['a', 'b'] }),
      ws('d', 'x', { dependsOn: ['b'] }),
    ];
    expect(newlyReady(before, after)).toEqual(['c']);
  });

  test('not ready while another dependency is outstanding; no-dependency workstreams never qualify', () => {
    const before = [ws('a', 'x', { status: 'active' }), ws('b', 'x', { status: 'active' }), ws('c', 'x', { dependsOn: ['a', 'b'] }), ws('e', 'x')];
    const after = [ws('a', 'x', { status: 'delivered' }), ws('b', 'x', { status: 'active' }), ws('c', 'x', { dependsOn: ['a', 'b'] }), ws('e', 'x')];
    expect(newlyReady(before, after)).toEqual([]);
  });

  test('requires pending status after the change', () => {
    const before = [ws('a', 'x', { status: 'active' }), ws('b', 'x', { dependsOn: ['a'], status: 'blocked' })];
    const after = [ws('a', 'x', { status: 'delivered' }), ws('b', 'x', { dependsOn: ['a'], status: 'blocked' })];
    expect(newlyReady(before, after)).toEqual([]);
  });
});

describe('writeScopeOverlaps', () => {
  test('R38: a root scope overlaps every other active scope, reported as /', () => {
    for (const root of ['', '/', '.']) {
      expect(writeScopeOverlaps([act('a', [root]), act('b', ['src/ui']), act('c', ['/'])])).toEqual([
        { a: 'a', b: 'b', prefix: '/' },
        { a: 'a', b: 'c', prefix: '/' },
        { a: 'b', b: 'c', prefix: '/' },
      ]);
    }
    // a workstream without scopes overlaps nothing
    expect(writeScopeOverlaps([act('a', []), act('b', ['/'])])).toEqual([]);
  });

  test('compares path segments', () => {
    expect(writeScopeOverlaps([act('a', ['src/ui']), act('b', ['src/ui/button'])])).toEqual([
      { a: 'a', b: 'b', prefix: 'src/ui' },
    ]);
    expect(writeScopeOverlaps([act('a', ['src/ui']), act('b', ['src/uix'])])).toEqual([]);
  });

  test('prefix is the shorter scope regardless of order', () => {
    expect(writeScopeOverlaps([act('a', ['src/ui/button']), act('b', ['src/ui'])])).toEqual([
      { a: 'a', b: 'b', prefix: 'src/ui' },
    ]);
  });

  test('only active workstreams are compared', () => {
    expect(
      writeScopeOverlaps([act('a', ['src']), act('b', ['src'], 'pending'), act('c', ['src'], 'blocked'), act('d', ['src'], 'delivered')]),
    ).toEqual([]);
  });

  test('normalizes trailing slashes and reports one entry per pair', () => {
    expect(writeScopeOverlaps([act('a', ['src/ui/', 'lib']), act('b', ['lib/x', 'src/ui'])])).toEqual([
      { a: 'a', b: 'b', prefix: 'src/ui' },
    ]);
  });

  test('each pair once, in input order', () => {
    expect(writeScopeOverlaps([act('a', ['x']), act('b', ['x/y']), act('c', ['x/z'])])).toEqual([
      { a: 'a', b: 'b', prefix: 'x' },
      { a: 'a', b: 'c', prefix: 'x' },
    ]);
  });
});
