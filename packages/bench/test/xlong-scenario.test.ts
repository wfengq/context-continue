import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, test } from 'vitest';
import { scenarioJson } from '../src/gen/write.js';
import { generateXlongProduct } from '../src/gen/xlong-product.js';
import { createPolicy } from '../src/policies/index.js';
import { runScenario } from '../src/runner.js';
import { checkCoverage, loadScenario, stepText } from '../src/scenario.js';
import { isDeliverableArgs } from '../src/text.js';
import type { CallRecord, Group, PolicyStats, Scenario } from '../src/types.js';

// xlong-product (spec 2026-11-04-xlong-scenario §2): one SaaS product across six release cycles,
// 1,000–1,500 steps, eight bots; group E must compact at the default window.

const ID = 'xlong-product';
const GROUPS: Group[] = ['A', 'B', 'C', 'D', 'E', 'F'];
const defaults = { window: 128000, compactRatio: 0.8, summaryTokens: 1500 };
const file = fileURLToPath(new URL(`../scenarios/${ID}.json`, import.meta.url));

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

/**
 * Review Focus 5: how often each deliverable paragraph appears verbatim in the scenario. A later
 * version of a deliverable repeats its earlier paragraphs by design (each version extends the one
 * before), so a deliverable counts only the paragraphs it adds; every other text of every step
 * (replies, messages, notes, reviews, briefs, specs, human messages) counts each time it contains
 * the paragraph.
 */
function paragraphCounts(s: Scenario): Map<string, number> {
  const added: string[] = [];
  const prev = new Map<string, Set<string>>();
  const others: string[] = [];
  for (const st of s.steps) {
    if (st.kind !== 'work') {
      others.push(stepText(st));
      continue;
    }
    others.push(st.reply);
    for (const op of st.ops ?? []) {
      if (op.name === 'submitDeliverable' && isDeliverableArgs(op.args)) {
        // The first paragraph is the generated title line ("<title>, version <n>.").
        const paras = op.args.content.split('\n\n').slice(1).filter(p => p.trim() !== '');
        const before = prev.get(op.args.workstreamId) ?? new Set<string>();
        added.push(...paras.filter(p => !before.has(p)));
        prev.set(op.args.workstreamId, new Set(paras));
        others.push(op.args.summary);
      } else {
        others.push(JSON.stringify(op.args));
      }
    }
  }
  const counts = new Map<string, number>();
  for (const p of added) counts.set(p, (counts.get(p) ?? 0) + 1);
  for (const p of counts.keys()) {
    const json = JSON.stringify(p).slice(1, -1);
    for (const t of others) if (t.includes(p) || t.includes(json)) counts.set(p, counts.get(p)! + 1);
  }
  return counts;
}

describe(ID, () => {
  test(`${ID} regenerates byte-identically to the committed file`, () => {
    const committed = readFileSync(file, 'utf8');
    expect({ same: scenarioJson(generateXlongProduct()) === committed }).toEqual({ same: true });
  });

  test('generating twice gives the same JSON', () => {
    expect(scenarioJson(generateXlongProduct())).toBe(scenarioJson(generateXlongProduct()));
  });

  test(`${ID} loads, is tier xlong with 1,000–1,500 steps and full coverage`, () => {
    const s = loadScenario(file);
    expect(s.id).toBe(ID);
    expect(s.tier).toBe('xlong');
    expect(s.steps.length).toBeGreaterThanOrEqual(1000);
    expect(s.steps.length).toBeLessThanOrEqual(1500);
    expect(checkCoverage(s)).toEqual([]);
    expect((s.facts ?? []).length).toBeGreaterThanOrEqual(40);
  });

  test(`${ID}: 8 bots, six release cycles each with new workstreams`, () => {
    const s = loadScenario(file);
    expect(s.employees.length).toBe(8);
    expect(s.plan.workstreams.length).toBeGreaterThanOrEqual(6);
    // Each cycle's workstreams share a prefix (acct-, bill-, collab-, off-, exp-, comp-) and are all delivered.
    const byWs = deliverables(s);
    for (const prefix of ['acct-', 'bill-', 'collab-', 'off-', 'exp-', 'comp-']) {
      expect({ prefix, delivered: [...byWs.keys()].filter(w => w.startsWith(prefix)).length >= 5 }).toEqual({ prefix, delivered: true });
    }
  });

  test(`${ID} deliverables: first versions 300–1500 chars, later ones up to 3000 and longer than the one before`, () => {
    const byWs = deliverables(loadScenario(file));
    expect(byWs.size).toBeGreaterThanOrEqual(36);
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

  test(`${ID}: no non-empty deliverable paragraph appears verbatim more than twice (Review Focus 5)`, () => {
    const counts = paragraphCounts(loadScenario(file));
    expect(counts.size).toBeGreaterThan(100);
    const repeated = [...counts].filter(([, n]) => n > 2).map(([p, n]) => `${n}x ${p.slice(0, 80)}`);
    expect(repeated).toEqual([]);
  });

  test(`${ID}: a status step's reply is its message text, so the message is posted once (R-L14, R-L9)`, () => {
    const s = loadScenario(file);
    let statuses = 0;
    for (const st of s.steps) {
      if (st.kind !== 'work') continue;
      for (const op of st.ops ?? []) {
        const text = op.name === 'sendMessage' ? (op.args as { text?: unknown }).text : undefined;
        if (typeof text !== 'string' || !text.startsWith('Status for the week:')) continue;
        statuses++;
        expect({ step: st.reply, same: st.reply === text }).toEqual({ step: st.reply, same: true });
      }
    }
    expect(statuses).toBeGreaterThan(0);
  });

  test(`${ID}: a bot asking a question @-mentions the asked bot in its reply`, () => {
    const s = loadScenario(file);
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

  test(`${ID}: every fact is told to the team, not only in a private note`, () => {
    const s = loadScenario(file);
    for (const f of s.facts ?? []) {
      const st = s.steps[f.step]!;
      const ops = st.kind === 'work' ? (st.ops ?? []).filter(o => o.name !== 'updateNotes') : [];
      const shared = st.kind !== 'work' || st.reply.includes(f.marker) || ops.some(o => JSON.stringify(o.args).includes(f.marker));
      expect({ fact: f.id, shared }).toEqual({ fact: f.id, shared: true });
    }
  });

  describe('runs through all six groups at the default parameters', () => {
    const runs = new Map<Group, { records: CallRecord[]; stats: PolicyStats }>();
    let s: Scenario;
    beforeAll(async () => {
      s = loadScenario(file);
      for (const g of GROUPS) runs.set(g, await runScenario(s, createPolicy(g, defaults)));
    }, 600_000);

    test('C has 0 core errors and finishes', () => {
      const c = runs.get('C')!;
      expect(c.records.length).toBeGreaterThan(0);
      expect(c.stats.coreErrors).toBe(0);
      expect(c.stats.unfinished).toBe(false);
    });

    test('E compacts at least once at the default window (Review Focus 4)', () => {
      expect(runs.get('E')!.stats.compactions).toBeGreaterThanOrEqual(1);
    });

    test('every fact has opportunities in every group', () => {
      for (const g of GROUPS) {
        const opportunities = new Map((s.facts ?? []).map(f => [f.id, 0]));
        for (const r of runs.get(g)!.records) for (const fid of [...(r.factsSeen ?? []), ...(r.factsMissed ?? [])]) opportunities.set(fid, (opportunities.get(fid) ?? 0) + 1);
        for (const [fid, n] of opportunities) expect({ g, fid, n: n > 0 }).toEqual({ g, fid, n: true });
      }
    });
  });
});
