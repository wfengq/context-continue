import { describe, expect, test } from 'vitest';
import { createEmployeeRegistry } from '../src/employees.js';
import { validatePlan, type PlanInput } from '../src/plan/validate.js';
import { memoryStore } from '../src/store/memory.js';

const roster = (...ids: string[]) => new Set(ids);

function plan(
  ws: [string, string[]][],
  owner = 'x',
  contracts: PlanInput['contracts'] = [],
): PlanInput {
  return {
    workstreams: ws.map(([id, dependsOn]) => ({ id, title: id, brief: `do ${id}`, owner, dependsOn })),
    contracts,
  };
}

function validPlan(): PlanInput {
  return {
    workstreams: [
      { id: 'art', title: 'Art', brief: 'sprites', owner: 'art', dependsOn: [], writeScopes: ['assets/'] },
      { id: 'logic', title: 'Logic', brief: 'game loop', owner: 'logic', dependsOn: ['art'] },
    ],
    contracts: [{ id: 'c1', from: 'art', to: 'logic', spec: 'png sprites' }],
  };
}

describe('validatePlan', () => {
  test('accepts a valid DAG', () => {
    expect(validatePlan(validPlan(), roster('art', 'logic'))).toEqual({ ok: true });
  });

  test('rejects dependency cycles with the cycle in the reason', () => {
    const r = validatePlan(plan([['a', ['b']], ['b', ['a']]]), roster('x'));
    expect(r).toEqual({ ok: false, reasons: [expect.stringContaining('a -> b -> a')] });
  });

  test('a self-dependency is a cycle a -> a', () => {
    const r = validatePlan(plan([['a', ['a']]]), roster('x'));
    expect(r).toEqual({ ok: false, reasons: [expect.stringContaining('a -> a')] });
  });

  test('reports only the first cycle found by DFS, from the cycle start', () => {
    const r = validatePlan(plan([['a', ['b']], ['b', ['c']], ['c', ['b']]]), roster('x'));
    expect(r).toEqual({ ok: false, reasons: [expect.stringContaining('b -> c -> b')] });
  });

  test('rejects owners not in the roster', () => {
    const r = validatePlan(plan([['a', []]], 'ghost'), roster('x'));
    expect(r).toEqual({ ok: false, reasons: [expect.stringContaining('ghost')] });
  });

  test('rejects unknown dependencies', () => {
    const r = validatePlan(plan([['a', ['nope']]]), roster('x'));
    expect(r).toEqual({ ok: false, reasons: [expect.stringContaining('nope')] });
  });

  test('rejects duplicate workstream ids', () => {
    const r = validatePlan(plan([['a', []], ['a', []]]), roster('x'));
    expect(r).toEqual({ ok: false, reasons: [expect.stringContaining('Duplicate workstream id "a"')] });
  });

  test('rejects contracts on unknown workstreams (from and to)', () => {
    const p = plan([['a', []]], 'x', [
      { id: 'c1', from: 'zzz', to: 'a', spec: 's' },
      { id: 'c2', from: 'a', to: 'yyy', spec: 's' },
    ]);
    const r = validatePlan(p, roster('x'));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reasons).toHaveLength(2);
      expect(r.reasons[0]).toContain('zzz');
      expect(r.reasons[1]).toContain('yyy');
    }
  });

  test('rejects duplicate contract ids', () => {
    const p = plan([['a', []]], 'x', [
      { id: 'c1', from: 'a', to: 'a', spec: 's' },
      { id: 'c1', from: 'a', to: 'a', spec: 't' },
    ]);
    const r = validatePlan(p, roster('x'));
    expect(r).toEqual({ ok: false, reasons: [expect.stringContaining('Duplicate contract id "c1"')] });
  });

  test('reports all problems, not just the first', () => {
    const p = plan([['a', ['b', 'missing']], ['b', ['a']], ['a', []]], 'ghost', [
      { id: 'c1', from: 'a', to: 'nope', spec: 's' },
      { id: 'c1', from: 'a', to: 'b', spec: 's' },
    ]);
    const r = validatePlan(p, roster('x'));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      const all = r.reasons.join('\n');
      expect(all).toContain('Duplicate workstream id "a"');
      expect(all).toContain('ghost');
      expect(all).toContain('missing');
      expect(all).toContain('a -> b -> a');
      expect(all).toContain('nope');
      expect(all).toContain('Duplicate contract id "c1"');
    }
  });
});

describe('employee registry', () => {
  test('upsert creates the memory when absent', async () => {
    const store = memoryStore();
    const reg = createEmployeeRegistry({ store });
    expect(await reg.get('art')).toBeNull();
    await reg.upsert({ botId: 'art', persona: 'artist', skills: ['draw'] });
    expect(await reg.get('art')).toEqual({
      botId: 'art',
      persona: 'artist',
      skills: ['draw'],
      memories: [],
      condensed: '',
    });
  });

  test('upsert keeps memories and condensed summary', async () => {
    const store = memoryStore();
    const reg = createEmployeeRegistry({ store });
    await reg.upsert({ botId: 'art', persona: 'artist', skills: ['draw'] });
    const m = (await store.getMemory('art'))!;
    m.memories.push({ id: 'm1', text: 'likes pixels', fromProject: 'p1', createdAt: 5, pinned: true });
    m.condensed = 'summary';
    await store.saveMemory(m);

    await reg.upsert({ botId: 'art', persona: 'senior artist', skills: ['draw', 'animate'] });
    const after = (await reg.get('art'))!;
    expect(after.persona).toBe('senior artist');
    expect(after.skills).toEqual(['draw', 'animate']);
    expect(after.memories).toHaveLength(1);
    expect(after.condensed).toBe('summary');
  });

  test('roster lists botId, persona and skills only', async () => {
    const store = memoryStore();
    const reg = createEmployeeRegistry({ store });
    await reg.upsert({ botId: 'art', persona: 'artist', skills: ['draw'] });
    await reg.upsert({ botId: 'logic', persona: 'coder', skills: [] });
    const r = await reg.roster();
    expect(r).toHaveLength(2);
    expect(r).toEqual(
      expect.arrayContaining([
        { botId: 'art', persona: 'artist', skills: ['draw'] },
        { botId: 'logic', persona: 'coder', skills: [] },
      ]),
    );
  });
});
