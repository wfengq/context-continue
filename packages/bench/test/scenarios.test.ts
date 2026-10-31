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
