import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import { createPolicy } from '../src/policies/index.js';
import { runScenario } from '../src/runner.js';
import { checkCoverage, loadScenario, validateScenario } from '../src/scenario.js';
import { isDeliverableArgs } from '../src/text.js';
import type { Group, Scenario } from '../src/types.js';

const IDS = ['product-plan', 'flappy-bird', 'event-plan'];
const GROUPS: Group[] = ['A', 'B', 'C', 'D', 'E', 'F'];
const defaults = { window: 128000, compactRatio: 0.8, summaryTokens: 1500 };
const load = (id: string) => loadScenario(fileURLToPath(new URL(`../scenarios/${id}.json`, import.meta.url)));

const ws = (id: string, owner: string) => ({ id, title: id, brief: `do ${id}`, owner, dependsOn: [] as string[] });
const tiny = (steps: unknown[]): Scenario =>
  validateScenario({
    id: 't', goal: 'g', constraints: [], owner: 'human', lead: 'pm',
    employees: [{ botId: 'pm', persona: 'p', skills: [] }, { botId: 'dev', persona: 'p', skills: [] }],
    plan: { workstreams: [ws('code', 'dev')], contracts: [] },
    steps,
  });

describe('checkCoverage', () => {
  test('reports every missing item for a scenario that covers nothing', () => {
    expect(checkCoverage(tiny([{ kind: 'human', text: 'Hello.' }]))).toEqual([
      'human requirement change',
      'failed review',
      'review with conventions',
      'replan',
      'bot-to-bot query',
      'standard scenario needs 20–40 steps',
    ]);
  });

  test('a requirement change must come after work has started and say what changed', () => {
    const work = { kind: 'work', botId: 'dev', workstreamId: 'code', reply: 'ok' };
    expect(checkCoverage(tiny([{ kind: 'human', text: 'Change of plan: use Go instead.' }, work]))).toContain('human requirement change');
    expect(checkCoverage(tiny([work, { kind: 'human', text: 'Thanks.' }]))).toContain('human requirement change');
    const replanStep = { kind: 'replan', plan: { workstreams: [ws('code', 'dev')], contracts: [] } };
    // A change needs a replan after it.
    expect(checkCoverage(tiny([work, { kind: 'human', text: 'Change of plan: use Go instead.' }]))).toContain('human requirement change');
    expect(checkCoverage(tiny([work, replanStep, { kind: 'human', text: 'Change of plan: use Go instead.' }]))).toContain('human requirement change');
    expect(checkCoverage(tiny([work, { kind: 'human', text: 'Change of plan: use Go instead.' }, replanStep]))).not.toContain('human requirement change');
  });

  test('a message with a change word but no later replan is not a requirement change', () => {
    const work = { kind: 'work', botId: 'dev', workstreamId: 'code', reply: 'ok' };
    expect(checkCoverage(tiny([work, { kind: 'human', text: 'No changes, great work.' }]))).toContain('human requirement change');
  });

  test('a bot-to-bot query is a sendMessage with act "query" in a work step', () => {
    const query = (act: string) => ({
      kind: 'work', botId: 'dev', workstreamId: 'code', reply: 'asking',
      ops: [{ name: 'sendMessage', args: { text: 'Which format?', act, mentions: ['pm'] } }],
    });
    expect(checkCoverage(tiny([query('inform')]))).toContain('bot-to-bot query');
    expect(checkCoverage(tiny([query('query')]))).not.toContain('bot-to-bot query');
  });
});

describe('the three scenarios', () => {
  test.each(IDS)('%s loads, has 20–40 steps and full coverage', id => {
    const s = load(id);
    expect(s.id).toBe(id);
    expect(s.steps.length).toBeGreaterThanOrEqual(20);
    expect(s.steps.length).toBeLessThanOrEqual(40);
    expect(checkCoverage(s)).toEqual([]);
  });

  test.each(IDS)('%s: every deliverable is 300–1500 characters', id => {
    const sizes = load(id).steps.flatMap(st =>
      st.kind === 'work' ? (st.ops ?? []).filter(o => o.name === 'submitDeliverable' && isDeliverableArgs(o.args)).map(o => (o.args as { content: string }).content.length) : [],
    );
    expect(sizes.length).toBeGreaterThanOrEqual(5);
    for (const n of sizes) {
      expect(n).toBeGreaterThanOrEqual(300);
      expect(n).toBeLessThanOrEqual(1500);
    }
  });

  test.each(IDS)('%s: human messages both @-mention bots and do not', id => {
    const humans = load(id).steps.filter(st => st.kind === 'human');
    expect(humans.some(h => (h.mentions ?? []).length > 0)).toBe(true);
    expect(humans.some(h => (h.mentions ?? []).length === 0)).toBe(true);
  });

  test.each(IDS)('%s: a bot asking a question @-mentions the asked bot in its reply', id => {
    const asks = load(id).steps.flatMap(st =>
      st.kind === 'work'
        ? (st.ops ?? [])
            .filter(o => o.name === 'sendMessage' && (o.args as { act: string }).act === 'query')
            .map(o => ({ reply: st.reply, mentions: (o.args as { mentions?: string[] }).mentions ?? [] }))
        : [],
    );
    expect(asks.length).toBeGreaterThanOrEqual(2);
    for (const a of asks) {
      expect(a.mentions.length).toBeGreaterThan(0);
      for (const m of a.mentions) expect(a.reply).toContain(`@${m}`);
    }
  });

  test('flappy-bird contains a failed review that adds a convention (style conflict)', () => {
    const s = load('flappy-bird');
    const conflict = s.steps.find(
      st => st.kind === 'review' && !st.passed && (st.conventions ?? []).length > 0 && /style/i.test(st.notes),
    );
    expect(conflict).toBeDefined();
    if (conflict?.kind !== 'review') throw new Error('unreachable');
    // The conflict is between the art and the game logic workstreams.
    expect(conflict.notes).toMatch(/art/i);
    expect(['art', 'gameplay']).toContain(conflict.deliverableOf);
  });

  test.each(IDS)('%s runs through all six groups without throwing', async id => {
    const s = load(id);
    for (const g of GROUPS) {
      const { records, stats } = await runScenario(s, createPolicy(g, defaults));
      expect(records.length).toBeGreaterThan(0);
      expect(records.every(r => r.group === g && r.scenario === id)).toBe(true);
      if (g === 'C') {
        // Every op is a valid core call, and the project finishes (R-B13, R-B14).
        expect(stats.coreErrors).toBe(0);
        expect(stats.unfinished).toBe(false);
      }
    }
  });
});

describe('standard scenario facts', () => {
  test.each(IDS)('%s has 4–6 annotated facts across all four categories', id => {
    const s = load(id);
    expect(s.facts).toBeDefined();
    expect(s.facts!.length).toBeGreaterThanOrEqual(4);
    expect(s.facts!.length).toBeLessThanOrEqual(6);
    expect(checkCoverage(s)).toEqual([]);
  });

  test.each(IDS)('%s: every fact has at least one opportunity in some group', async id => {
    const s = load(id);
    const opportunities = new Map((s.facts ?? []).map(f => [f.id, 0]));
    for (const g of GROUPS) {
      const { records } = await runScenario(s, createPolicy(g, defaults));
      for (const r of records) for (const fid of [...(r.factsSeen ?? []), ...(r.factsMissed ?? [])]) opportunities.set(fid, (opportunities.get(fid) ?? 0) + 1);
    }
    for (const [fid, n] of opportunities) expect({ fid, n: n > 0 }).toEqual({ fid, n: true });
  });
});

describe('fact markers', () => {
  test('a marker with characters outside [A-Za-z0-9_-] is rejected, naming the fact id', () => {
    const base = {
      id: 't', goal: 'g', constraints: [], owner: 'human', lead: 'pm',
      employees: [{ botId: 'pm', persona: 'p', skills: [] }],
      plan: { workstreams: [], contracts: [] },
      steps: [{ kind: 'human', text: 'Use MAX 5MB please' }],
    };
    expect(() => validateScenario({ ...base, facts: [{ id: 'conv-a', marker: 'MAX 5MB', step: 0, audience: ['*'] }] })).toThrow(/fact conv-a: marker/);
    expect(() => validateScenario({ ...base, steps: [{ kind: 'human', text: 'Use MAX-5MB_x' }], facts: [{ id: 'conv-a', marker: 'MAX-5MB_x', step: 0, audience: ['*'] }] })).not.toThrow();
  });
});

describe('checkCoverage: tier and facts', () => {
  const human = (text: string) => ({ kind: 'human', text });
  const factsFor = (prefixes: string[], extra = 0) => {
    const ids = [...prefixes.map(p => `${p}a`), ...Array.from({ length: extra }, (_, i) => `conv-extra${i}`)];
    return ids.map(id => ({ id, marker: 'M', step: 0, audience: ['*'] }));
  };
  const build = (tier: 'standard' | 'long' | undefined, facts: unknown[] | undefined, steps: unknown[]): Scenario =>
    validateScenario({
      id: 't', goal: 'g', constraints: [], owner: 'human', lead: 'pm', ...(tier ? { tier } : {}), ...(facts ? { facts } : {}),
      employees: [{ botId: 'pm', persona: 'p', skills: [] }, { botId: 'dev', persona: 'p', skills: [] }],
      plan: { workstreams: [ws('code', 'dev')], contracts: [] },
      steps,
    });
  const pad = (n: number) => Array.from({ length: n }, () => human('M'));
  const P = ['change-', 'conv-', 'contract-', 'fail-'];

  test('standard scenario without facts is checked for step count but not for facts', () => {
    const short = checkCoverage(build(undefined, undefined, [human('Hello.')]));
    expect(short).toContain('standard scenario needs 20–40 steps');
    expect(short.some(m => /fact/.test(m))).toBe(false);
    expect(checkCoverage(build(undefined, undefined, pad(25))).some(m => /fact|steps/.test(m))).toBe(false);
  });
  test('standard scenario with facts needs 20–40 steps, 4–6 facts, and all four categories', () => {
    const ok = build(undefined, factsFor(P), pad(25));
    expect(checkCoverage(ok).filter(m => /fact|steps/.test(m))).toEqual([]);
    expect(checkCoverage(build('standard', factsFor(P), pad(10)))).toContain('standard scenario needs 20–40 steps');
    expect(checkCoverage(build('standard', factsFor(P, 3), pad(25)))).toContain('standard scenario needs 4–6 facts');
    expect(checkCoverage(build('standard', factsFor(P.slice(0, 3), 1), pad(25)))).toEqual(
      expect.arrayContaining(['fact category fail-']),
    );
  });
  test('long scenario always requires steps, facts, categories and minimum counts', () => {
    const out = checkCoverage(build('long', undefined, pad(120)));
    expect(out).toEqual(expect.arrayContaining([
      'long scenario needs 150–300 steps',
      'long scenario needs at least 15 facts',
      'fact category change-', 'fact category conv-', 'fact category contract-', 'fact category fail-',
      'long scenario needs at least 3 replans',
      'long scenario needs at least 4 requirement changes',
      'long scenario needs at least 6 failed reviews',
      'long scenario needs at least 8 new conventions',
      'long scenario needs at least 10 bot-to-bot queries',
    ]));
  });
  test('long scenario that meets every minimum has no missing items', () => {
    const work = { kind: 'work', botId: 'dev', workstreamId: 'code', reply: 'M' };
    const q = { ...work, ops: [{ name: 'sendMessage', args: { text: 't', act: 'query', mentions: ['pm'] } }] };
    const plan = { kind: 'replan', plan: { workstreams: [ws('code', 'dev')], contracts: [] } };
    const chg = human('Change of plan: M');
    const fail = { kind: 'review', deliverableOf: 'code', passed: false, notes: 'n', conventions: ['a', 'b'] };
    const steps = [
      work,
      ...Array.from({ length: 4 }, () => chg), plan, plan, plan,
      ...Array.from({ length: 6 }, () => fail),
      ...Array.from({ length: 10 }, () => q),
      ...pad(150),
    ];
    const facts = [...factsFor(P), ...Array.from({ length: 11 }, (_, i) => ({ id: `conv-n${i}`, marker: 'M', step: 1, audience: ['*'] }))];
    expect(checkCoverage(build('long', facts, steps))).toEqual([]);
  });
});
