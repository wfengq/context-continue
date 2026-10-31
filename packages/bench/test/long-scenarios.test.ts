import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import { generateLongApp } from '../src/gen/long-app.js';
import { scenarioJson } from '../src/gen/write.js';
import { createPolicy } from '../src/policies/index.js';
import { runScenario } from '../src/runner.js';
import { checkCoverage, loadScenario } from '../src/scenario.js';
import { isDeliverableArgs } from '../src/text.js';
import type { Group, Scenario } from '../src/types.js';

const GROUPS: Group[] = ['A', 'B', 'C', 'D', 'E', 'F'];
const defaults = { window: 128000, compactRatio: 0.8, summaryTokens: 1500 };
const file = (id: string) => fileURLToPath(new URL(`../scenarios/${id}.json`, import.meta.url));

/** submitDeliverable contents per workstream, in the order they appear. */
function deliverables(s: Scenario): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const st of s.steps) {
    if (st.kind !== 'work') continue;
    for (const op of st.ops ?? []) {
      if (op.name !== 'submitDeliverable' || !isDeliverableArgs(op.args)) continue;
      out.set(op.args.workstreamId, [...(out.get(op.args.workstreamId) ?? []), op.args.content]);
    }
  }
  return out;
}

describe('long-app', () => {
  test('long-app regenerates byte-identically to the committed file', () => {
    const committed = readFileSync(file('long-app'), 'utf8');
    expect({ id: 'long-app', same: scenarioJson(generateLongApp()) === committed }).toEqual({ id: 'long-app', same: true });
  });

  test('generating twice gives the same JSON', () => {
    expect(scenarioJson(generateLongApp())).toBe(scenarioJson(generateLongApp()));
  });

  test('long-app loads, is tier long with 150–300 steps and full coverage', () => {
    const s = loadScenario(file('long-app'));
    expect(s.id).toBe('long-app');
    expect(s.tier).toBe('long');
    expect(s.steps.length).toBeGreaterThanOrEqual(150);
    expect(s.steps.length).toBeLessThanOrEqual(300);
    expect(checkCoverage(s)).toEqual([]);
  });

  test('long-app: 8 bots and about 10 workstreams in the initial plan', () => {
    const s = loadScenario(file('long-app'));
    expect(s.employees.length).toBe(8);
    expect(s.plan.workstreams.length).toBeGreaterThanOrEqual(9);
    expect(s.plan.workstreams.length).toBeLessThanOrEqual(11);
  });

  test('long-app deliverables are 300–3000 chars and later versions are longer', () => {
    const byWs = deliverables(loadScenario(file('long-app')));
    expect(byWs.size).toBeGreaterThanOrEqual(10);
    expect([...byWs.values()].some(v => v.length >= 3)).toBe(true);
    for (const [ws, contents] of byWs) {
      for (const c of contents) {
        expect({ ws, n: c.length >= 300 && c.length <= 3000 }).toEqual({ ws, n: true });
      }
      for (let i = 1; i < contents.length; i++) {
        expect({ ws, version: i + 1, longer: contents[i]!.length > contents[i - 1]!.length }).toEqual({ ws, version: i + 1, longer: true });
      }
    }
  });

  test('long-app: a bot asking a question @-mentions the asked bot in its reply', () => {
    const s = loadScenario(file('long-app'));
    for (const st of s.steps) {
      if (st.kind !== 'work') continue;
      for (const op of st.ops ?? []) {
        const a = op.args as { act?: string; mentions?: string[] };
        if (op.name !== 'sendMessage' || a.act !== 'query') continue;
        expect(a.mentions?.length ?? 0).toBeGreaterThan(0);
        for (const m of a.mentions ?? []) expect(st.reply).toContain(`@${m}`);
      }
    }
  });

  test('long-app runs through all six groups; C has 0 core errors and finishes', async () => {
    const s = loadScenario(file('long-app'));
    const opportunities = new Map((s.facts ?? []).map(f => [f.id, 0]));
    for (const g of GROUPS) {
      const { records, stats } = await runScenario(s, createPolicy(g, defaults));
      expect(records.length).toBeGreaterThan(0);
      if (g === 'C') {
        expect(stats.coreErrors).toBe(0);
        expect(stats.unfinished).toBe(false);
      }
      for (const r of records) for (const fid of [...(r.factsSeen ?? []), ...(r.factsMissed ?? [])]) opportunities.set(fid, (opportunities.get(fid) ?? 0) + 1);
    }
    // Every fact's audience makes a scripted request after the fact is introduced.
    for (const [fid, n] of opportunities) expect({ fid, n: n > 0 }).toEqual({ fid, n: true });
  }, 60_000);
});
