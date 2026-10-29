import { describe, expect, test, vi } from 'vitest';
import { createEmployeeRegistry } from '../src/employees.js';
import { createProject } from '../src/project.js';
import type { BoardOp, LedgerEntry } from '../src/types.js';
import { makeProject, type FacadeProject } from './helpers.js';

const alice = { kind: 'human', id: 'alice' } as const;
const decision = (text = 'Use 16px tiles'): BoardOp => ({
  op: 'addDecision',
  decision: { text, rationale: 'the team said so', rejected: [], affects: ['art'], source: { entryIds: [], by: 'alice' } },
});

type ExtractFn = (e: LedgerEntry[], b: unknown) => Promise<BoardOp[]>;

async function setup(extract?: ExtractFn, options: { extractEvery?: number; idleMs?: number } = {}) {
  const fx = await makeProject({
    approved: true,
    options,
    models: extract ? { extract: extract as never } : undefined,
  });
  return fx;
}

const say = (fx: FacadeProject, n: number, from = 1) =>
  (async () => {
    const out: LedgerEntry[] = [];
    for (let i = 0; i < n; i++) out.push(await fx.p.ingest({ author: alice, text: `msg ${from + i}` }));
    return out;
  })();

const texts = (es: LedgerEntry[]) => es.map(e => (e.body.type === 'chat' ? e.body.text : '?'));

describe('extraction scheduling', () => {
  test('runs after extractEvery human messages with only those messages', async () => {
    const extract = vi.fn(async () => []);
    const fx = await setup(extract);
    await say(fx, 9);
    await fx.p.flushExtraction();
    expect(extract).not.toHaveBeenCalled();
    await say(fx, 1, 10);
    await fx.p.flushExtraction();
    expect(extract).toHaveBeenCalledTimes(1);
    const entries = (extract.mock.calls[0] as unknown as [LedgerEntry[]])[0];
    expect(texts(entries)).toEqual(Array.from({ length: 10 }, (_, i) => `msg ${i + 1}`));
  });

  test('runs after idleMs of silence with pending messages', async () => {
    const extract = vi.fn(async () => []);
    const fx = await setup(extract);
    await say(fx, 3);
    fx.clock.advance(59_999);
    await fx.p.flushExtraction();
    expect(extract).not.toHaveBeenCalled();
    fx.clock.advance(1);
    await fx.p.flushExtraction();
    expect(extract).toHaveBeenCalledTimes(1);
    expect((extract.mock.calls[0] as unknown as [LedgerEntry[]])[0]).toHaveLength(3);
    // nothing pending any more: no timer, no further runs
    expect(fx.clock.pendingTimers()).toBe(0);
  });

  test('a new human message resets the idle timer', async () => {
    const extract = vi.fn(async () => []);
    const fx = await setup(extract);
    await say(fx, 1);
    fx.clock.advance(40_000);
    await say(fx, 1, 2);
    await fx.p.flushExtraction();
    fx.clock.advance(40_000);
    await fx.p.flushExtraction();
    expect(extract).not.toHaveBeenCalled();
    fx.clock.advance(20_000);
    await fx.p.flushExtraction();
    expect(extract).toHaveBeenCalledTimes(1);
    expect((extract.mock.calls[0] as unknown as [LedgerEntry[]])[0]).toHaveLength(2);
  });

  test('bot messages do not count and are not passed to extract', async () => {
    const extract = vi.fn(async () => []);
    const fx = await setup(extract);
    await say(fx, 9);
    for (let i = 0; i < 5; i++) await fx.p.ingest({ author: { kind: 'bot', id: 'art' }, text: `bot ${i}`, act: 'inform' });
    await fx.p.flushExtraction();
    expect(extract).not.toHaveBeenCalled();
    await say(fx, 1, 10);
    await fx.p.flushExtraction();
    expect(extract).toHaveBeenCalledTimes(1);
    const entries = (extract.mock.calls[0] as unknown as [LedgerEntry[]])[0];
    expect(entries).toHaveLength(10);
    expect(entries.every(e => e.author.kind === 'human' && e.body.type === 'chat')).toBe(true);
  });

  test('extracted ops enter the queue as extractor with human authority', async () => {
    const fx = await setup(async () => [decision()], { extractEvery: 2 });
    const version0 = (await fx.p.board()).version;
    await say(fx, 2);
    await fx.p.flushExtraction();
    const board = await fx.p.board();
    expect(board.version).toBe(version0 + 1);
    expect(board.decisions.map(d => [d.text, d.authority])).toEqual([['Use 16px tiles', 'human']]);
    expect(fx.eventsOf('boardChanged').at(-1)).toEqual({ version: version0 + 1 });
    const changes = await fx.store.getBoardChanges(fx.projectId, version0);
    expect(changes.at(-1)!.ops[0]!.by).toBe('extractor');
  });

  test('the merge wakes are emitted', async () => {
    const fx = await setup(async () => [decision()], { extractEvery: 1 });
    const before = fx.eventsOf('wake').length;
    await say(fx, 1);
    await fx.p.flushExtraction();
    const wakes = fx.eventsOf('wake').slice(before).flatMap(e => e.wakes);
    expect(wakes.some(w => w.botId === 'art')).toBe(true);
  });

  test('extract receives the board and the proposal is based on the version read at the start', async () => {
    let seenVersion = -1;
    const fx = await setup(
      async (_e, b) => {
        seenVersion = (b as { version: number }).version;
        return [];
      },
      { extractEvery: 1 },
    );
    const v = (await fx.p.board()).version;
    await say(fx, 1);
    await fx.p.flushExtraction();
    expect(seenVersion).toBe(v);
  });

  test('failure keeps the range for retry; third consecutive failure emits extractFailed', async () => {
    let fail = true;
    const extract = vi.fn(async () => {
      if (fail) throw new Error('model down');
      return [decision()];
    });
    const fx = await setup(extract, { extractEvery: 2 });
    await say(fx, 2);
    await fx.p.flushExtraction();
    expect(extract).toHaveBeenCalledTimes(1);
    expect(fx.eventsOf('extractFailed')).toEqual([]);
    // retry on the next trigger: the next message keeps the threshold reached
    await say(fx, 1, 3);
    await fx.p.flushExtraction();
    expect(extract).toHaveBeenCalledTimes(2);
    expect((extract.mock.calls[1] as unknown as [LedgerEntry[]])[0]).toHaveLength(3);
    expect(fx.eventsOf('extractFailed')).toEqual([]);
    await say(fx, 1, 4);
    await fx.p.flushExtraction();
    expect(fx.eventsOf('extractFailed')).toEqual([{ attempts: 3 }]);
    // each further failure emits again
    await say(fx, 1, 5);
    await fx.p.flushExtraction();
    expect(fx.eventsOf('extractFailed')).toEqual([{ attempts: 3 }, { attempts: 4 }]);
    // success: the whole range goes through, failures reset
    fail = false;
    await say(fx, 1, 6);
    await fx.p.flushExtraction();
    expect((extract.mock.calls.at(-1) as unknown as [LedgerEntry[]])[0]).toHaveLength(6);
    expect((await fx.p.board()).decisions).toHaveLength(1);
    expect(await fx.store.getMeta(fx.projectId, 'extract')).toMatchObject({ failures: 0 });
    await say(fx, 2, 7);
    await fx.p.flushExtraction();
    expect((extract.mock.calls.at(-1) as unknown as [LedgerEntry[]])[0]).toHaveLength(2);
  });

  test('after a failure the idle timer is re-armed to retry', async () => {
    let fail = true;
    const extract = vi.fn(async () => {
      if (fail) throw new Error('boom');
      return [];
    });
    const fx = await setup(extract, { extractEvery: 2 });
    await say(fx, 2);
    await fx.p.flushExtraction();
    expect(extract).toHaveBeenCalledTimes(1);
    expect(fx.clock.pendingTimers()).toBe(1);
    fail = false;
    fx.clock.advance(60_000);
    await fx.p.flushExtraction();
    expect(extract).toHaveBeenCalledTimes(2);
    expect((extract.mock.calls[1] as unknown as [LedgerEntry[]])[0]).toHaveLength(2);
    expect(fx.clock.pendingTimers()).toBe(0);
  });

  test('invalid ops count as a failure and are not enqueued', async () => {
    const extract = vi.fn(async () => [{ op: 'nonsense' }] as unknown as BoardOp[]);
    const fx = await setup(extract, { extractEvery: 1 });
    const v = (await fx.p.board()).version;
    await say(fx, 1);
    await fx.p.flushExtraction();
    expect((await fx.p.board()).version).toBe(v);
    expect(await fx.store.getMeta(fx.projectId, 'extract')).toMatchObject({ fromSeq: 1, failures: 1 });
  });

  test('an empty result is a success: progress advances and nothing is enqueued', async () => {
    const extract = vi.fn(async () => []);
    const fx = await setup(extract, { extractEvery: 2 });
    const v = (await fx.p.board()).version;
    const es = await say(fx, 2);
    await fx.p.flushExtraction();
    expect((await fx.p.board()).version).toBe(v);
    expect(await fx.store.getMeta(fx.projectId, 'extract')).toEqual({ fromSeq: es[1]!.seq + 1, failures: 0 });
  });

  test('ingest does not wait for the extraction; one runs at a time and later messages wait for the next run', async () => {
    let release!: () => void;
    const gate = new Promise<void>(r => (release = r));
    const extract = vi.fn(async (e: LedgerEntry[]) => {
      if (extract.mock.calls.length === 1) await gate;
      return [];
    });
    const fx = await setup(extract as ExtractFn, { extractEvery: 2 });
    await say(fx, 2);
    await vi.waitFor(() => expect(extract).toHaveBeenCalledTimes(1));
    await say(fx, 2, 3); // reaches the threshold again while the first run is in flight
    expect(extract).toHaveBeenCalledTimes(1);
    release();
    await fx.p.flushExtraction();
    expect(extract).toHaveBeenCalledTimes(2);
    expect(texts((extract.mock.calls[0] as unknown as [LedgerEntry[]])[0])).toEqual(['msg 1', 'msg 2']);
    expect(texts((extract.mock.calls[1] as unknown as [LedgerEntry[]])[0])).toEqual(['msg 3', 'msg 4']);
  });

  test('messages left over after a run get an idle timer', async () => {
    let release!: () => void;
    const gate = new Promise<void>(r => (release = r));
    const extract = vi.fn(async () => {
      if (extract.mock.calls.length === 1) await gate;
      return [];
    });
    const fx = await setup(extract, { extractEvery: 2 });
    await say(fx, 2);
    await vi.waitFor(() => expect(extract).toHaveBeenCalledTimes(1));
    await say(fx, 1, 3);
    release();
    await fx.p.flushExtraction();
    expect(extract).toHaveBeenCalledTimes(1);
    expect(fx.clock.pendingTimers()).toBe(1);
    fx.clock.advance(60_000);
    await fx.p.flushExtraction();
    expect(extract).toHaveBeenCalledTimes(2);
    expect((extract.mock.calls[1] as unknown as [LedgerEntry[]])[0]).toHaveLength(1);
  });

  test('no extract function: nothing scheduled', async () => {
    const fx = await setup(undefined, { extractEvery: 2 });
    await say(fx, 5);
    await fx.p.flushExtraction();
    expect(fx.clock.pendingTimers()).toBe(0);
    expect(await fx.store.getMeta(fx.projectId, 'extract')).toBeNull();
  });

  test('dispose clears the idle timer', async () => {
    const extract = vi.fn(async () => []);
    const fx = await setup(extract);
    await say(fx, 1);
    expect(fx.clock.pendingTimers()).toBe(1);
    fx.p.dispose();
    expect(fx.clock.pendingTimers()).toBe(0);
    fx.clock.advance(120_000);
    expect(extract).not.toHaveBeenCalled();
  });

  test('progress survives a new createProject on the same store', async () => {
    const first = vi.fn(async () => []);
    const fx = await setup(first, { extractEvery: 3 });
    await say(fx, 3);
    await fx.p.flushExtraction();
    expect(first).toHaveBeenCalledTimes(1);
    await say(fx, 2, 4); // two pending, below the threshold
    fx.p.dispose();

    const second = vi.fn(async () => []);
    const p2 = createProject({
      projectId: fx.projectId,
      store: fx.store,
      employees: createEmployeeRegistry({ store: fx.store }),
      clock: fx.clock,
      options: { extractEvery: 3 },
      models: { extract: second },
    });
    await p2.ingest({ author: alice, text: 'msg 6' });
    await p2.flushExtraction();
    expect(second).toHaveBeenCalledTimes(1);
    expect(texts((second.mock.calls[0] as unknown as [LedgerEntry[]])[0])).toEqual(['msg 4', 'msg 5', 'msg 6']);
    p2.dispose();
  });

  test('on restart, messages already pending get an idle timer', async () => {
    const fx = await setup(vi.fn(async () => []), { extractEvery: 5 });
    await say(fx, 2);
    fx.p.dispose();
    expect(fx.clock.pendingTimers()).toBe(0);

    const second = vi.fn(async () => []);
    const p2 = createProject({
      projectId: fx.projectId,
      store: fx.store,
      employees: createEmployeeRegistry({ store: fx.store }),
      clock: fx.clock,
      options: { extractEvery: 5 },
      models: { extract: second },
    });
    await p2.flushExtraction();
    expect(fx.clock.pendingTimers()).toBe(1);
    fx.clock.advance(60_000);
    await p2.flushExtraction();
    expect(second).toHaveBeenCalledTimes(1);
    expect((second.mock.calls[0] as unknown as [LedgerEntry[]])[0]).toHaveLength(2);
    p2.dispose();
  });
});
