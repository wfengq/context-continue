import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import { generateLongApp } from '../src/gen/long-app.js';
import { generateLongEvent } from '../src/gen/long-event.js';
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

const CASES = [
  { id: 'long-app', generate: generateLongApp, bots: 8, minWs: 9, maxWs: 11, delivered: 10 },
  { id: 'long-event', generate: generateLongEvent, bots: 6, minWs: 7, maxWs: 9, delivered: 9 },
];

describe.each(CASES)('$id', ({ id, generate, bots, minWs, maxWs, delivered }) => {
  test(`${id} regenerates byte-identically to the committed file`, () => {
    const committed = readFileSync(file(id), 'utf8');
    expect({ id, same: scenarioJson(generate()) === committed }).toEqual({ id, same: true });
  });

  test('generating twice gives the same JSON', () => {
    expect(scenarioJson(generate())).toBe(scenarioJson(generate()));
  });

  test(`${id} loads, is tier long with 150–300 steps and full coverage`, () => {
    const s = loadScenario(file(id));
    expect(s.id).toBe(id);
    expect(s.tier).toBe('long');
    expect(s.steps.length).toBeGreaterThanOrEqual(150);
    expect(s.steps.length).toBeLessThanOrEqual(300);
    expect(checkCoverage(s)).toEqual([]);
  });

  test(`${id}: ${bots} bots and ${minWs}–${maxWs} workstreams in the initial plan`, () => {
    const s = loadScenario(file(id));
    expect(s.employees.length).toBe(bots);
    expect(s.plan.workstreams.length).toBeGreaterThanOrEqual(minWs);
    expect(s.plan.workstreams.length).toBeLessThanOrEqual(maxWs);
  });

  test(`${id} deliverables: first versions 300–1500 chars, later ones up to 3000 and longer than the one before`, () => {
    const byWs = deliverables(loadScenario(file(id)));
    expect(byWs.size).toBeGreaterThanOrEqual(delivered);
    expect([...byWs.values()].some(v => v.length >= 3)).toBe(true);
    for (const [ws, contents] of byWs) {
      contents.forEach((c, i) => {
        const max = i === 0 ? 1500 : 3000;
        expect({ ws, version: i + 1, inRange: c.length >= 300 && c.length <= max }).toEqual({ ws, version: i + 1, inRange: true });
      });
      for (let i = 1; i < contents.length; i++) {
        expect({ ws, version: i + 1, longer: contents[i]!.length > contents[i - 1]!.length }).toEqual({ ws, version: i + 1, longer: true });
      }
    }
  });

  test(`${id}: a bot asking a question @-mentions the asked bot in its reply`, () => {
    const s = loadScenario(file(id));
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

  test(`${id} runs through all six groups; C has 0 core errors and finishes`, async () => {
    const s = loadScenario(file(id));
    for (const g of GROUPS) {
      const opportunities = new Map((s.facts ?? []).map(f => [f.id, 0]));
      const { records, stats } = await runScenario(s, createPolicy(g, defaults));
      expect(records.length).toBeGreaterThan(0);
      if (g === 'C') {
        expect(stats.coreErrors).toBe(0);
        expect(stats.unfinished).toBe(false);
      }
      for (const r of records) for (const fid of [...(r.factsSeen ?? []), ...(r.factsMissed ?? [])]) opportunities.set(fid, (opportunities.get(fid) ?? 0) + 1);
      // In every group, each fact's audience makes a scripted request after the fact is introduced.
      for (const [fid, n] of opportunities) expect({ g, fid, n: n > 0 }).toEqual({ g, fid, n: true });
    }
  }, 60_000);
});
