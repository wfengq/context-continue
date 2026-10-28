import { describe, expect, test } from 'vitest';
import { memoryStore } from '../src/store/memory.js';
import type { Store } from '../src/store/store.js';
import type { ProjectBoard, Workstream } from '../src/types.js';
import { localWorkstreamSource, resolveWorkstreams, type WorkstreamSource } from '../src/workstreams/source.js';
import { runWorkstreamContract } from './workstreams.contract.js';

function board(projectId: string, workstreams: Workstream[] = []): ProjectBoard {
  return {
    projectId,
    version: 0,
    updatedAt: 0,
    status: 'active',
    owner: 'alice',
    lead: 'lead',
    goal: 'ship it',
    constraints: [],
    planStatus: 'approved',
    conventions: [],
    workstreams,
    contracts: [],
    decisions: [],
    facts: [],
    failures: [],
    openQuestions: [],
  };
}

const ws = (id: string, over: Partial<Workstream> = {}): Workstream => ({
  id,
  title: `ws ${id}`,
  brief: `brief ${id}`,
  owner: 'art',
  dependsOn: [],
  writeScopes: [],
  status: 'pending',
  reviewRounds: 0,
  deliverables: [],
  ...over,
});

runWorkstreamContract('local', async () => {
  const store = memoryStore();
  await store.createBoard(board('p1'));
  return { source: localWorkstreamSource(store), projectId: 'p1' };
});

describe('localWorkstreamSource writes', () => {
  test('bumps version, sets updatedAt and records one setWorkstreamStatus op per workstream', async () => {
    const store = memoryStore();
    await store.createBoard(board('p1'));
    const source = localWorkstreamSource(store, { now: () => 777 });
    await source.create('p1', [
      { id: 'w1', title: 't', brief: 'b', owner: 'art', dependsOn: [], writeScopes: [] },
      { id: 'w2', title: 't', brief: 'b', owner: 'art', dependsOn: [], writeScopes: [] },
    ]);
    await source.setStatus('p1', 'w1', 'active');
    const b = await store.getBoard('p1');
    expect(b.version).toBe(2);
    expect(b.updatedAt).toBe(777);
    expect(b.workstreams[0]).toMatchObject({ reviewRounds: 0, deliverables: [], status: 'active' });
    const changes = await store.getBoardChanges('p1', 0);
    expect(changes.map(c => c.version)).toEqual([1, 2]);
    expect(changes[0]!.mergedAt).toBe(777);
    expect(changes[0]!.ops).toEqual([
      { op: { op: 'setWorkstreamStatus', id: 'w1', status: 'pending' }, by: 'system', authority: 'bot', touched: ['w1'] },
      { op: { op: 'setWorkstreamStatus', id: 'w2', status: 'pending' }, by: 'system', authority: 'bot', touched: ['w2'] },
    ]);
    expect(changes[1]!.ops).toEqual([
      { op: { op: 'setWorkstreamStatus', id: 'w1', status: 'active' }, by: 'system', authority: 'bot', touched: ['w1'] },
    ]);
  });

  test('retries on STALE_VERSION by re-reading the board', async () => {
    const real = memoryStore();
    await real.createBoard(board('p1', [ws('w1')]));
    let calls = 0;
    const flaky: Store = {
      ...real,
      async saveBoard(b, expected, change) {
        if (calls++ < 2) {
          // a concurrent writer gets in first
          const cur = await real.getBoard('p1');
          await real.saveBoard({ ...cur, version: cur.version + 1 }, cur.version, { version: cur.version + 1, mergedAt: 1, ops: [] });
        }
        return real.saveBoard(b, expected, change);
      },
    };
    await localWorkstreamSource(flaky).setStatus('p1', 'w1', 'active');
    expect(calls).toBe(3);
    const b = await real.getBoard('p1');
    expect(b.version).toBe(3);
    expect(b.workstreams[0]!.status).toBe('active');
  });

  test('gives up after 3 STALE_VERSION attempts and rethrows', async () => {
    const real = memoryStore();
    await real.createBoard(board('p1', [ws('w1')]));
    let calls = 0;
    const alwaysStale: Store = {
      ...real,
      async saveBoard(b, expected, change) {
        calls++;
        const cur = await real.getBoard('p1');
        await real.saveBoard({ ...cur, version: cur.version + 1 }, cur.version, { version: cur.version + 1, mergedAt: 1, ops: [] });
        return real.saveBoard(b, expected, change);
      },
    };
    await expect(localWorkstreamSource(alwaysStale).setStatus('p1', 'w1', 'active')).rejects.toMatchObject({
      code: 'STALE_VERSION',
    });
    expect(calls).toBe(3);
  });
});

describe('resolveWorkstreams', () => {
  test('takes host fields from the source and keeps brief/deliverables/reviewRounds from the board', async () => {
    const deliverable = { id: 'd1', summary: 'sprites', ref: 'ref1', version: 1 };
    const b = board('p1', [
      ws('w1', { brief: 'saved brief', reviewRounds: 2, deliverables: [deliverable], title: 'old', owner: 'old', status: 'pending' }),
      ws('gone', { brief: 'not in source' }),
    ]);
    const source: WorkstreamSource = {
      async list() {
        return [
          { id: 'w1', title: 'New title', owner: 'new-owner', dependsOn: ['w0'], writeScopes: ['src/'], status: 'active' },
          { id: 'w9', title: 'host only', owner: 'x', dependsOn: [], writeScopes: [], status: 'blocked' },
        ];
      },
      async create() {},
      async setStatus() {},
      onChange: () => () => {},
    };
    expect(await resolveWorkstreams(b, source)).toEqual([
      {
        id: 'w1',
        title: 'New title',
        brief: 'saved brief',
        owner: 'new-owner',
        dependsOn: ['w0'],
        writeScopes: ['src/'],
        status: 'active',
        reviewRounds: 2,
        deliverables: [deliverable],
      },
      {
        id: 'w9',
        title: 'host only',
        brief: '',
        owner: 'x',
        dependsOn: [],
        writeScopes: [],
        status: 'blocked',
        reviewRounds: 0,
        deliverables: [],
      },
    ]);
  });
});
