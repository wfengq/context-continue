import { describe, expect, test, vi } from 'vitest';

// Count calls to randomUUID while keeping the real implementation.
const uuidCalls = vi.hoisted(() => ({ n: 0 }));
vi.mock('node:crypto', async importOriginal => {
  const real = await importOriginal<typeof import('node:crypto')>();
  return {
    ...real,
    randomUUID: () => {
      uuidCalls.n++;
      return real.randomUUID();
    },
  };
});

import { createEmployeeRegistry } from '../src/employees.js';
import { newId } from '../src/ids.js';
import { createProject } from '../src/project.js';
import { memoryStore } from '../src/store/memory.js';
import type { IdGenerator } from '../src/ids.js';
import { FIXTURE_PLAN, PERSONAS, fakeClock } from './helpers.js';

function counter(): IdGenerator & { made: string[] } {
  let n = 0;
  const made: string[] = [];
  const gen = (prefix: string) => {
    const id = `${prefix}-${(++n).toString(16).padStart(8, '0')}`;
    made.push(id);
    return id;
  };
  return Object.assign(gen, { made });
}

/** A full lifecycle touching every id kind: ledger entries, proposals, items, deliverables, pending, memories. */
async function lifecycle(ids?: IdGenerator) {
  const store = memoryStore(ids ? { newId: ids } : {});
  const employees = createEmployeeRegistry({ store });
  for (const botId of ['pm', 'art', 'logic', 'audio']) await employees.upsert({ botId, persona: PERSONAS[botId]!, skills: [] });
  const p = createProject({ projectId: 'p1', store, employees, clock: fakeClock(), ...(ids && { newId: ids }) });
  await p.start({ goal: 'Ship a tiny platformer demo.', constraints: ['Runs in the browser'], lead: 'pm', by: 'alice' });
  const { proposalId } = await p.proposePlan(FIXTURE_PLAN, { by: 'pm' });
  await p.approvePlan(proposalId, { by: 'alice' });
  await p.ingest({ author: { kind: 'human', id: 'alice' }, text: 'Tiles are 16px.' });
  await p.submit('art', { type: 'deliverable', workstreamId: 'art', summary: 'sprites', content: 'sprites.png' });
  await p.submit('art', {
    type: 'proposal',
    ops: [
      { op: 'addFact', fact: { text: 'Tiles are 16px', affects: ['logic'], source: { entryIds: [], by: 'art' } } },
      { op: 'addConvention', item: { text: 'Use 16px tiles', affects: ['art', 'logic'], source: { entryIds: [], by: 'art' } } },
    ],
  } as never);
  await p.submit('art', { type: 'notes', text: 'remember the palette' });
  await p.commitRetro('art', [{ text: 'Keep sprites small' }]);
  const board = await p.board();
  const ledger = await store.read('p1', 1);
  p.dispose();
  return { board, ledger, store };
}

describe('injectable id generator', () => {
  test('createProject and memoryStore use the injected generator for every id; randomUUID is never called', async () => {
    const ids = counter();
    uuidCalls.n = 0;
    const { board, ledger } = await lifecycle(ids);
    expect(uuidCalls.n).toBe(0);
    expect(ids.made.length).toBeGreaterThan(0);
    const made = new Set(ids.made);
    for (const e of ledger) expect(made.has(e.id)).toBe(true);
    const art = board.workstreams.find(w => w.id === 'art')!;
    for (const d of art.deliverables) {
      expect(made.has(d.id)).toBe(true);
      expect(made.has(d.ref)).toBe(true);
    }
    expect(made.has(board.facts[0]!.id)).toBe(true);
    // ids follow the generator's format
    expect(ids.made[0]).toMatch(/^[a-z]+-00000001$/);
  });

  test('two runs with fresh counters give identical boards and ledgers', async () => {
    const a = await lifecycle(counter());
    const b = await lifecycle(counter());
    expect(JSON.stringify(b.board)).toBe(JSON.stringify(a.board));
    expect(JSON.stringify(b.ledger)).toBe(JSON.stringify(a.ledger));
  });

  test('without a generator the default newId (randomUUID) is used', async () => {
    uuidCalls.n = 0;
    const { ledger } = await lifecycle();
    expect(uuidCalls.n).toBeGreaterThan(0);
    expect(ledger[0]!.id).toMatch(/^e-[0-9a-f]{8}$/);
    expect(newId('x')).toMatch(/^x-[0-9a-f]{8}$/);
  });
});
