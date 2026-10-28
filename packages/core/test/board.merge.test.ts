import { describe, expect, test } from 'vitest';
import { classifyOp, type ClassifyContext } from '../src/board/classify.js';
import { Merger } from '../src/board/merge.js';
import type { Clock } from '../src/clock.js';
import { ContextError } from '../src/errors.js';
import { DEFAULT_OPTIONS } from '../src/options.js';
import { memoryStore } from '../src/store/memory.js';
import type { Store } from '../src/store/store.js';
import { defaultCountTokens } from '../src/tokens.js';
import type { BoardChange, BoardOp, Decision, Item, ProjectBoard, Proposal, Workstream } from '../src/types.js';

const src = (by = 'art') => ({ entryIds: ['e1'], by });

function ws(id: string, owner: string): Workstream {
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
  };
}

function item(id: string, authority: 'human' | 'bot' = 'bot'): Item {
  return { id, text: `text ${id}`, source: src(), authority };
}

function decision(id: string, authority: 'human' | 'bot' = 'bot'): Decision {
  return { ...item(id, authority), rationale: 'because', rejected: [], affects: ['w1'] };
}

function makeBoard(): ProjectBoard {
  return {
    projectId: 'p1',
    version: 0,
    updatedAt: 0,
    status: 'active',
    owner: 'alice',
    lead: 'lead',
    goal: 'ship the game',
    constraints: ['no network'],
    planStatus: 'approved',
    conventions: [item('cv-bot', 'bot'), item('cv-human', 'human')],
    workstreams: [ws('w1', 'art'), ws('w2', 'code')],
    contracts: [{ id: 'c1', from: 'w1', to: 'w2', spec: 'png sprites', version: 1 }],
    decisions: [decision('d-human', 'human'), decision('d-bot', 'bot')],
    facts: [],
    failures: [],
    openQuestions: [item('q1')],
  };
}

const addConvention = (text: string, by = 'art'): BoardOp => ({
  op: 'add',
  section: 'conventions',
  item: { text, source: src(by) },
});
const addDecision = (affects: string[], by = 'art'): BoardOp => ({
  op: 'addDecision',
  decision: { text: 'use 32x32', source: src(by), rationale: 'clearer', rejected: ['16x16'], affects },
});
const supersede = (section: 'conventions' | 'decisions', id: string, by = 'art'): BoardOp => ({
  op: 'supersede',
  section,
  id,
  item: { text: `replaces ${id}`, source: src(by) },
});

const SAMPLE_OPS: Record<string, BoardOp> = {
  addDeliverable: { op: 'addDeliverable', workstreamId: 'w1', summary: 'sprites', ref: 'del-1' },
  setWorkstreamStatus: { op: 'setWorkstreamStatus', id: 'w1', status: 'active' },
  closeQuestion: { op: 'closeQuestion', id: 'q1' },
  updateContract: { op: 'updateContract', id: 'c1', spec: 'webp sprites' },
  setGoal: { op: 'setGoal', goal: 'ship two games' },
  setConstraints: { op: 'setConstraints', constraints: [] },
};

function ctx(overrides: Partial<ClassifyContext> = {}): ClassifyContext {
  return {
    by: 'art',
    lead: 'lead',
    isExtractor: false,
    ownWorkstreams: ['w1'],
    board: makeBoard(),
    touchedByOthersSince: new Set(),
    ...overrides,
  };
}

describe('classifyOp', () => {
  test.each([
    ['addDeliverable', 'auto'],
    ['setWorkstreamStatus', 'auto'],
    ['closeQuestion', 'auto'],
    ['updateContract', 'lead'],
    ['setGoal', 'human'],
    ['setConstraints', 'human'],
  ])('%s classified as %s for a non-lead bot', (kind, expected) => {
    expect(classifyOp(SAMPLE_OPS[kind]!, ctx())).toBe(expected);
  });

  test('add, addFact and addFailure are auto', () => {
    expect(classifyOp(addConvention('x'), ctx())).toBe('auto');
    expect(
      classifyOp({ op: 'addFact', fact: { text: 'f', source: src(), affects: ['w2'] } }, ctx()),
    ).toBe('auto');
    expect(
      classifyOp({ op: 'addFailure', failure: { text: 'f', source: src(), reason: 'r', affects: ['w2'] } }, ctx()),
    ).toBe('auto');
  });

  test('addDecision affecting only own workstream is auto, otherwise lead', () => {
    expect(classifyOp(addDecision(['w1']), ctx())).toBe('auto');
    expect(classifyOp(addDecision(['w1', 'w2']), ctx())).toBe('lead');
    expect(classifyOp(addDecision(['w2']), ctx())).toBe('lead');
    expect(classifyOp(addDecision(['w1']), ctx({ ownWorkstreams: [] }))).toBe('lead');
  });

  test('bot superseding a human item goes to lead', () => {
    expect(classifyOp(supersede('decisions', 'd-human'), ctx())).toBe('lead');
    expect(classifyOp(supersede('conventions', 'cv-human'), ctx())).toBe('lead');
    expect(classifyOp(supersede('decisions', 'd-bot'), ctx())).toBe('auto');
    expect(classifyOp(supersede('conventions', 'cv-bot'), ctx())).toBe('auto');
  });

  test('op touching an item modified by someone else since baseVersion goes to lead', () => {
    const touched = new Set(['w1', 'd-bot', 'q1']);
    expect(classifyOp(SAMPLE_OPS.addDeliverable!, ctx({ touchedByOthersSince: touched }))).toBe('lead');
    expect(classifyOp(SAMPLE_OPS.setWorkstreamStatus!, ctx({ touchedByOthersSince: touched }))).toBe('lead');
    expect(classifyOp(SAMPLE_OPS.closeQuestion!, ctx({ touchedByOthersSince: touched }))).toBe('lead');
    expect(classifyOp(supersede('decisions', 'd-bot'), ctx({ touchedByOthersSince: touched }))).toBe('lead');
    // Untouched targets stay auto.
    expect(
      classifyOp({ op: 'setWorkstreamStatus', id: 'w2', status: 'active' }, ctx({ touchedByOthersSince: touched })),
    ).toBe('auto');
  });

  test('lead own ops skip the lead class but human class still applies', () => {
    const lead = ctx({ by: 'lead', ownWorkstreams: [], touchedByOthersSince: new Set(['w1']) });
    expect(classifyOp(SAMPLE_OPS.updateContract!, lead)).toBe('auto');
    expect(classifyOp(addDecision(['w1', 'w2'], 'lead'), lead)).toBe('auto');
    expect(classifyOp(supersede('decisions', 'd-human', 'lead'), lead)).toBe('auto');
    expect(classifyOp(SAMPLE_OPS.addDeliverable!, lead)).toBe('auto');
    expect(classifyOp(SAMPLE_OPS.setGoal!, lead)).toBe('human');
    expect(classifyOp(SAMPLE_OPS.setConstraints!, lead)).toBe('human');
  });

  test('extractor addDecision is auto with human authority', async () => {
    const extractor = ctx({ by: 'extractor', isExtractor: true, ownWorkstreams: [] });
    expect(classifyOp(addDecision(['w1', 'w2'], 'alice'), extractor)).toBe('auto');
    expect(classifyOp(supersede('decisions', 'd-human', 'alice'), extractor)).toBe('auto');
    expect(classifyOp(SAMPLE_OPS.setGoal!, extractor)).toBe('human');

    const { store, merger } = await setup();
    await store.enqueueProposal(prop('extractor', [addDecision(['w1', 'w2'], 'alice')]));
    const r = await merger.merge();
    expect(r.pending).toEqual([]);
    expect(r.change!.ops[0]).toMatchObject({ by: 'extractor', authority: 'human' });
    const board = await store.getBoard('p1');
    expect(board.decisions.at(-1)).toMatchObject({ text: 'use 32x32', authority: 'human' });
  });
});

// ---------------------------------------------------------------------------
// Merger
// ---------------------------------------------------------------------------

const clock: Clock = { now: () => 1_000, setTimeout: () => 0, clearTimeout: () => {} };
const renderPublic = (b: ProjectBoard) =>
  JSON.stringify({ goal: b.goal, constraints: b.constraints, conventions: b.conventions });

let propSeq = 0;
function prop(by: string, ops: unknown[], baseVersion = 0): Proposal {
  return { id: `prop-${++propSeq}`, projectId: 'p1', baseVersion, by, ops: ops as BoardOp[] };
}

async function setup(opts: { wrapStore?: (base: Store) => Store; boardMaxTokens?: number } = {}) {
  const store = memoryStore();
  await store.createBoard(makeBoard());
  const merger = new Merger({
    store: opts.wrapStore ? opts.wrapStore(store) : store,
    projectId: 'p1',
    clock,
    options: { ...DEFAULT_OPTIONS, boardMaxTokens: opts.boardMaxTokens ?? DEFAULT_OPTIONS.boardMaxTokens },
    count: defaultCountTokens,
    renderPublic,
    ownWorkstreams: async (botId) =>
      (await store.getBoard('p1')).workstreams.filter((w) => w.owner === botId).map((w) => w.id),
  });
  return { store, merger };
}

/** Wraps a store, letting a test intercept individual methods. */
function wrap(base: Store, overrides: Partial<Store>): Store {
  return new Proxy(base, {
    get(target, key, receiver) {
      const o = (overrides as Record<string | symbol, unknown>)[key];
      if (o !== undefined) return o;
      return Reflect.get(target, key, receiver);
    },
  });
}

async function events(store: Store) {
  return (await store.read('p1', 1)).flatMap((e) => (e.body.type === 'event' ? [{ ...e.body.event, author: e.author }] : []));
}

describe('Merger.merge', () => {
  test('merge applies auto ops in one change and bumps version once', async () => {
    const { store, merger } = await setup(); // board version 0
    await store.enqueueProposal(prop('art', [addConvention('a'), addConvention('b')]));
    const r = await merger.merge();
    expect(r.change!.version).toBe(1);
    expect(r.change!.ops).toHaveLength(2);
    expect(r.change!.mergedAt).toBe(1_000);
    expect(r.change!.ops[0]).toMatchObject({ by: 'art', authority: 'bot' });
    const board = await store.getBoard('p1');
    expect(board.version).toBe(1);
    expect(board.updatedAt).toBe(1_000);
    expect(board.conventions.map((c) => c.text)).toContain('b');
    expect(await store.getBoardChanges('p1', 0)).toHaveLength(1);
    expect(await events(store)).toEqual([
      { kind: 'boardMerged', version: 1, author: { kind: 'system', id: 'merger' } },
    ]);
  });

  test('ops from several proposals land in a single change', async () => {
    const { store, merger } = await setup();
    await store.enqueueProposal(prop('art', [addConvention('a')]));
    await store.enqueueProposal(prop('code', [addConvention('b', 'code')]));
    const r = await merger.merge();
    expect(r.change!.ops.map((o) => o.by)).toEqual(['art', 'code']);
    expect((await store.getBoard('p1')).version).toBe(1);
  });

  test('empty queue produces no change', async () => {
    const { store, merger } = await setup();
    expect(await merger.merge()).toEqual({ change: null, pending: [], rejected: [] });
    expect((await store.getBoard('p1')).version).toBe(0);
  });

  test('lead and human ops become pending and emit nothing to the board', async () => {
    const { store, merger } = await setup();
    const p = prop('art', [SAMPLE_OPS.updateContract, SAMPLE_OPS.setGoal, addDecision(['w2'])]);
    await store.enqueueProposal(p);
    const r = await merger.merge();
    expect(r.change).toBeNull();
    expect(r.rejected).toEqual([]);
    expect(r.pending.map((x) => x.needs).sort()).toEqual(['human', 'lead']);
    const lead = r.pending.find((x) => x.needs === 'lead')!;
    const human = r.pending.find((x) => x.needs === 'human')!;
    expect(lead).toMatchObject({ projectId: 'p1', proposalId: p.id, by: 'art', createdAt: 1_000 });
    expect(lead.ops).toEqual([SAMPLE_OPS.updateContract, addDecision(['w2'])]);
    expect(human.ops).toEqual([SAMPLE_OPS.setGoal]);
    expect(await store.listPending('p1')).toHaveLength(2);
    const board = await store.getBoard('p1');
    expect(board.version).toBe(0);
    expect(board.goal).toBe('ship the game');
    expect(await store.getBoardChanges('p1', 0)).toEqual([]);
    expect(await events(store)).toEqual([]);
  });

  test('mixed proposal: auto ops apply, the rest wait', async () => {
    const { store, merger } = await setup();
    await store.enqueueProposal(prop('art', [addConvention('a'), SAMPLE_OPS.updateContract]));
    const r = await merger.merge();
    expect(r.change!.ops).toHaveLength(1);
    expect(r.pending).toHaveLength(1);
    expect((await store.getBoard('p1')).contracts[0]!.spec).toBe('png sprites');
  });

  test('invalid ops are rejected individually', async () => {
    const { store, merger } = await setup();
    const p = prop('art', [
      { op: 'add', section: 'conventions', item: { text: '' } }, // schema failure
      addConvention('ok'),
      { op: 'closeQuestion', id: 'q-missing' }, // INVALID_OP from applyOp
    ]);
    await store.enqueueProposal(p);
    const r = await merger.merge();
    expect(r.change!.ops).toHaveLength(1);
    expect(r.change!.ops[0]!.op).toEqual(addConvention('ok'));
    expect(r.rejected.map((x) => [x.proposalId, x.index])).toEqual([
      [p.id, 0],
      [p.id, 2],
    ]);
    expect(r.rejected[1]!.reason).toMatch(/q-missing/);
  });

  test('fully rejected proposal produces no change', async () => {
    const { store, merger } = await setup();
    await store.enqueueProposal(prop('art', [{ op: 'nope' }]));
    const r = await merger.merge();
    expect(r.change).toBeNull();
    expect(r.rejected).toHaveLength(1);
    expect((await store.getBoard('p1')).version).toBe(0);
  });

  test('touchedByOthersSince is built from changes after baseVersion by other authors', async () => {
    const { store, merger } = await setup();
    await store.enqueueProposal(prop('code', [{ op: 'setWorkstreamStatus', id: 'w1', status: 'active' }]));
    await merger.merge(); // v1, touched w1 by code
    await store.enqueueProposal(prop('art', [{ op: 'setWorkstreamStatus', id: 'w1', status: 'blocked' }], 0));
    await store.enqueueProposal(prop('art', [{ op: 'setWorkstreamStatus', id: 'w1', status: 'delivered' }], 1));
    const r = await merger.merge();
    expect(r.pending).toHaveLength(1);
    expect(r.pending[0]!.ops[0]).toMatchObject({ status: 'blocked' });
    expect(r.change!.ops[0]!.op).toMatchObject({ status: 'delivered' });
  });

  test('own earlier changes do not count as conflicts', async () => {
    const { store, merger } = await setup();
    await store.enqueueProposal(prop('art', [{ op: 'setWorkstreamStatus', id: 'w1', status: 'active' }]));
    await merger.merge();
    await store.enqueueProposal(prop('art', [{ op: 'setWorkstreamStatus', id: 'w1', status: 'blocked' }], 0));
    const r = await merger.merge();
    expect(r.pending).toEqual([]);
    expect(r.change!.version).toBe(2);
  });

  test('concurrent merge calls are serialized: versions are consecutive, no op lost', async () => {
    let stale = 0;
    let active = 0;
    let maxActive = 0;
    const { store: base, merger } = await setup({ wrapStore: (base) => wrap(base, {
      async drainProposals(projectId) {
        active++;
        maxActive = Math.max(maxActive, active);
        await new Promise((r) => setTimeout(r, 2));
        const drained = await base.drainProposals(projectId);
        if (drained.length === 0) active--; // this merge ends here; otherwise it ends at saveBoard
        return drained;
      },
      async getBoard(projectId) {
        await new Promise((r) => setTimeout(r, 1));
        return base.getBoard(projectId);
      },
      async saveBoard(board, expected, change) {
        try {
          await base.saveBoard(board, expected, change);
        } catch (e) {
          if (e instanceof ContextError && e.code === 'STALE_VERSION') stale++;
          throw e;
        } finally {
          active--;
        }
      },
    }) });
    const runs: Promise<unknown>[] = [];
    for (let i = 0; i < 10; i++) {
      await base.enqueueProposal(prop('art', [addConvention(`c${i}`)]));
      if (i % 2 === 1) runs.push(merger.merge());
    }
    const results = (await Promise.all(runs)) as { change: BoardChange | null }[];
    const versions = results.flatMap((r) => (r.change ? [r.change.version] : []));
    expect(versions).toEqual(versions.map((_, i) => i + 1));
    const total = results.reduce((n, r) => n + (r.change?.ops.length ?? 0), 0);
    expect(total).toBe(10);
    const board = await base.getBoard('p1');
    expect(board.version).toBe(versions.length);
    expect(board.conventions.filter((c) => c.text.startsWith('c'))).toHaveLength(10);
    expect(stale).toBe(0);
    expect(maxActive).toBe(1);
  });

  test('a failed merge does not wedge later merges', async () => {
    let fail = true;
    const { store: base, merger } = await setup({ wrapStore: (base) => wrap(base, {
      async getBoard(projectId) {
        if (fail) {
          fail = false;
          throw new Error('disk on fire');
        }
        return base.getBoard(projectId);
      },
    }) });
    await base.enqueueProposal(prop('art', [addConvention('a')]));
    const first = merger.merge();
    const second = merger.merge();
    await expect(first).rejects.toThrow('disk on fire');
    // The failed merge put its proposals back, so the next merge applies them.
    const r = await second;
    expect(r.change!.ops).toHaveLength(1);
    expect((await base.getBoard('p1')).version).toBe(1);
  });

  test('stale version on save is retried against the fresh board', async () => {
    let raced = false;
    let saves = 0;
    const { store: base, merger } = await setup({ wrapStore: (base) => wrap(base, {
      async saveBoard(board, expected, change) {
        saves++;
        if (!raced) {
          raced = true;
          // Someone else writes first.
          const fresh = await base.getBoard('p1');
          const other = {
            ...fresh,
            version: fresh.version + 1,
            conventions: [...fresh.conventions, { ...item('cv-other'), text: 'from elsewhere' }],
          };
          await base.saveBoard(other, fresh.version, {
            version: other.version,
            mergedAt: 0,
            ops: [{ op: addConvention('from elsewhere', 'code'), by: 'code', authority: 'bot', touched: ['cv-other'] }],
          });
        }
        return base.saveBoard(board, expected, change);
      },
    }) });
    await base.enqueueProposal(prop('art', [addConvention('mine')]));
    const r = await merger.merge();
    expect(saves).toBe(2);
    expect(r.change!.version).toBe(2);
    const board = await base.getBoard('p1');
    expect(board.version).toBe(2);
    expect(board.conventions.map((c) => c.text)).toEqual(expect.arrayContaining(['from elsewhere', 'mine']));
    expect((await events(base)).filter((e) => e.kind === 'boardMerged')).toHaveLength(1);
  });

  test('retry recomputes classification against the fresh board', async () => {
    let raced = false;
    const { store: base, merger } = await setup({ wrapStore: (base) => wrap(base, {
      async saveBoard(board, expected, change) {
        if (!raced) {
          raced = true;
          const fresh = await base.getBoard('p1');
          const other = { ...fresh, version: fresh.version + 1 };
          other.workstreams = other.workstreams.map((w) => (w.id === 'w1' ? { ...w, status: 'blocked' } : w));
          await base.saveBoard(other, fresh.version, {
            version: other.version,
            mergedAt: 0,
            ops: [
              {
                op: { op: 'setWorkstreamStatus', id: 'w1', status: 'blocked' },
                by: 'code',
                authority: 'bot',
                touched: ['w1'],
              },
            ],
          });
        }
        return base.saveBoard(board, expected, change);
      },
    }) });
    await base.enqueueProposal(prop('art', [addConvention('a'), { op: 'setWorkstreamStatus', id: 'w1', status: 'active' }]));
    const r = await merger.merge();
    expect(r.change!.ops).toHaveLength(1);
    expect(r.pending).toHaveLength(1);
    expect(r.pending[0]!.needs).toBe('lead');
    expect(await base.listPending('p1')).toHaveLength(1);
  });

  test('gives up after 3 retries and rethrows STALE_VERSION', async () => {
    let saves = 0;
    const { store: base, merger } = await setup({ wrapStore: (base) => wrap(base, {
      async saveBoard() {
        saves++;
        throw new ContextError('STALE_VERSION', 'stale');
      },
    }) });
    await base.enqueueProposal(prop('art', [addConvention('a'), SAMPLE_OPS.setGoal]));
    await expect(merger.merge()).rejects.toMatchObject({ code: 'STALE_VERSION' });
    expect(saves).toBe(4);
    expect(await base.listPending('p1')).toEqual([]);
    expect(await events(base)).toEqual([]);
  });

  test('archived items are written to the ledger as archived events', async () => {
    const { store, merger } = await setup();
    const before = await store.getBoard('p1');
    const old = before.decisions.find((d) => d.id === 'd-bot')!;
    await store.enqueueProposal(prop('art', [supersede('decisions', 'd-bot'), { op: 'closeQuestion', id: 'q1' }]));
    const r = await merger.merge();
    expect(r.change!.ops).toHaveLength(2);
    const ev = await events(store);
    expect(ev).toEqual([
      { kind: 'archived', what: 'decisions', ref: JSON.stringify(old), author: { kind: 'system', id: 'merger' } },
      {
        kind: 'archived',
        what: 'openQuestions',
        ref: JSON.stringify(before.openQuestions[0]),
        author: { kind: 'system', id: 'merger' },
      },
      { kind: 'boardMerged', version: 1, author: { kind: 'system', id: 'merger' } },
    ]);
  });

  test('board size enforcement evicts and archives old bot conventions', async () => {
    const { store, merger } = await setup({ boardMaxTokens: 60 });
    await store.enqueueProposal(prop('art', [addConvention('x'.repeat(80))]));
    await merger.merge();
    const board = await store.getBoard('p1');
    expect(defaultCountTokens(renderPublic(board))).toBeLessThanOrEqual(60);
    const archived = (await events(store)).filter((e) => e.kind === 'archived');
    expect(archived.length).toBeGreaterThan(0);
    expect(archived.every((e) => e.kind === 'archived' && e.what === 'conventions')).toBe(true);
  });
});

describe('Merger.resolve', () => {
  async function withPending() {
    const env = await setup();
    await env.store.enqueueProposal(prop('art', [SAMPLE_OPS.updateContract, SAMPLE_OPS.setGoal]));
    const r = await env.merger.merge();
    const lead = r.pending.find((x) => x.needs === 'lead')!;
    const human = r.pending.find((x) => x.needs === 'human')!;
    return { ...env, lead, human };
  }

  test('resolve: lead accept applies ops; human pending requires owner', async () => {
    const { store, merger, lead, human } = await withPending();

    await expect(merger.resolve(lead.id, { by: 'art', accept: true })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(merger.resolve(lead.id, { by: 'alice', accept: true })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(merger.resolve(human.id, { by: 'lead', accept: true })).rejects.toMatchObject({ code: 'FORBIDDEN' });

    const r = await merger.resolve(lead.id, { by: 'lead', accept: true });
    expect(r.change!.version).toBe(1);
    expect(r.change!.ops[0]).toMatchObject({ op: SAMPLE_OPS.updateContract, by: 'art', authority: 'bot' });
    let board = await store.getBoard('p1');
    expect(board.contracts[0]).toMatchObject({ spec: 'webp sprites', version: 2 });
    expect((await store.listPending('p1')).map((x) => x.id)).toEqual([human.id]);

    const rej = await merger.resolve(human.id, { by: 'alice', accept: false });
    expect(rej).toEqual({ change: null, pending: [], rejected: [] });
    board = await store.getBoard('p1');
    expect(board.version).toBe(1);
    expect(board.goal).toBe('ship the game');
    expect(await store.listPending('p1')).toEqual([]);
  });

  test('owner accepting a human pending applies it', async () => {
    const { store, merger, human } = await withPending();
    const r = await merger.resolve(human.id, { by: 'alice', accept: true });
    expect(r.change!.version).toBe(1);
    expect((await store.getBoard('p1')).goal).toBe('ship two games');
    const ev = await events(store);
    expect(ev.at(-1)).toMatchObject({ kind: 'boardMerged', version: 1 });
  });

  test('resolve with edits applies the edited ops instead', async () => {
    const { store, merger, lead } = await withPending();
    const edits: BoardOp[] = [{ op: 'updateContract', id: 'c1', spec: 'svg sprites' }];
    const r = await merger.resolve(lead.id, { by: 'lead', accept: true, edits });
    expect(r.change!.ops.map((o) => o.op)).toEqual(edits);
    expect((await store.getBoard('p1')).contracts[0]!.spec).toBe('svg sprites');
  });

  test('resolve rejects invalid edits individually', async () => {
    const { store, merger, lead } = await withPending();
    const edits = [{ op: 'updateContract', id: 'c1' }, addConvention('fine')] as unknown as BoardOp[];
    const r = await merger.resolve(lead.id, { by: 'lead', accept: true, edits });
    expect(r.change!.ops).toHaveLength(1);
    expect(r.rejected).toEqual([{ proposalId: lead.proposalId, index: 0, reason: expect.any(String) }]);
    expect((await store.listPending('p1')).map((x) => x.id)).not.toContain(lead.id);
  });

  test('resolve of an unknown pending id is NOT_FOUND', async () => {
    const { merger } = await setup();
    await expect(merger.resolve('pend-nope', { by: 'lead', accept: true })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });
});
