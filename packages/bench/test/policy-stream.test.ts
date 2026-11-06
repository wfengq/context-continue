import { describe, expect, test } from 'vitest';
import type { LedgerEntry, ProjectBoard } from '@context-continue/core';
import { briefStream, DEFAULT_RESTREAM_TOKENS, type CoreSegment, type StreamSegment } from '../src/policies/stream.js';
import { projectPolicy } from '../src/policies/project.js';
import { createPolicy } from '../src/policies/index.js';
import { runScenario } from '../src/runner.js';
import { ScriptedModel, type ModelRequest } from '../src/model.js';
import { loadScenario } from '../src/scenario.js';
import { scenarioPath } from '../src/cli.js';

const count = (s: string) => Math.ceil(s.length / 4);

const item = (id: string, text: string) => ({ id, text, source: { entryIds: [], by: 'pm' }, authority: 'bot' as const });

function board(over: Partial<ProjectBoard> = {}): ProjectBoard {
  return {
    projectId: 'p', version: 1, updatedAt: 0, status: 'active', owner: 'human', lead: 'pm',
    goal: 'Build a tiny game', constraints: ['Runs in the browser'], planStatus: 'approved',
    conventions: [item('conv-1', 'Use snake_case MARK-CONV')],
    workstreams: [
      { id: 'art', title: 'Art', brief: 'do art', owner: 'art', dependsOn: [], writeScopes: [], status: 'active', reviewRounds: 0, deliverables: [] },
      { id: 'logic', title: 'Logic', brief: 'do logic', owner: 'logic', dependsOn: ['art'], writeScopes: [], status: 'pending', reviewRounds: 0, deliverables: [] },
    ],
    contracts: [{ id: 'c-1', from: 'art', to: 'logic', spec: 'PNG 32x32 MARK-CONTRACT', version: 1 }],
    decisions: [{ ...item('dec-1', 'Use canvas'), rationale: 'fast MARK-WHY', rejected: ['WebGL'], affects: ['art'] }],
    facts: [],
    failures: [{ ...item('fail-1', 'Tried SVG'), reason: 'too slow MARK-FAIL', affects: ['art'] }],
    openQuestions: [],
    ...over,
  };
}

let seq = 0;
const human = (text: string): LedgerEntry => {
  seq++;
  return { id: `e-${seq}`, projectId: 'p', seq, createdAt: seq, author: { kind: 'human', id: 'human' }, body: { type: 'chat', text, mentions: [], hops: 0 } };
};

/** The core segments of a brief for `bot`: the seven kinds; delta and trigger texts are given. */
const brief = (bot: string, delta: string, trigger: string): CoreSegment[] => [
  { kind: 'common', text: '# Team\n\nmembers' },
  { kind: 'memory', text: `# Your memory\n\n${bot}` },
  { kind: 'workspace', text: `# Your notes\n\n${bot}` },
  { kind: 'board', text: '# Project (core board)' },
  { kind: 'projection', text: `# Your part\n\n${bot} part` },
  { kind: 'delta', text: `# Since you last looked\n\n${delta}` },
  { kind: 'trigger', text: `# Why you are awake\n\nreason: manual\n${trigger}` },
];
/** A review or planning context: lead prefix, board, body as projection, trigger. */
const context = (body: string, trigger: string): CoreSegment[] => [
  { kind: 'common', text: '# Team\n\nmembers' },
  { kind: 'memory', text: '# Your memory\n\npm' },
  { kind: 'workspace', text: '# Your notes\n\npm' },
  { kind: 'board', text: '# Project (core board)' },
  { kind: 'projection', text: body },
  { kind: 'trigger', text: `# Why you are awake\n\nreason: manual\n${trigger}` },
];

const texts = (s: StreamSegment[]) => s.map(x => x.text);
const kinds = (s: StreamSegment[]) => s.map(x => x.kind);
const isPrefix = (a: string[], b: string[]) => a.length <= b.length && a.every((t, i) => b[i] === t);
const all = (s: StreamSegment[]) => texts(s).join('\n');
const big = { restreamTokens: 1_000_000, count };

describe('briefStream', () => {
  test('the first request is a snapshot: core prefix, a full project board, projection, then delta and trigger', () => {
    const s = briefStream(big);
    const humans = Array.from({ length: 25 }, (_, i) => human(`directive ${i} MARK-H${i}`));
    const r = s.request('art', { core: brief('art', '- x', 'task 1'), shape: 'brief', board: board(), humans });
    expect(r.snapshot).toBe(true);
    expect(kinds(r.segments)).toEqual(['common', 'memory', 'workspace', 'board', 'projection', 'delta', 'trigger']);
    expect(r.segments.every(x => x.cacheable)).toBe(true);
    const b = r.segments[3]!.text;
    // Every project-wide item in the core's field layouts, and every human message (no 20 limit).
    for (const m of ['MARK-CONV', '- [c-1@v1] art -> logic: PNG 32x32 MARK-CONTRACT', '- [dec-1] Use canvas\n  why: fast MARK-WHY\n  rejected: WebGL\n  affects: art',
      '- [fail-1] tried: Tried SVG\n  why it failed: too slow MARK-FAIL\n  affects: art', 'art | Art | art | active', 'logic | Logic | logic | pending', 'Build a tiny game', 'Runs in the browser']) {
      expect(b).toContain(m);
    }
    for (const h of humans) expect(b).toContain(`- [#${h.seq} human] ${(h.body as { text: string }).text}`);
    expect(b).not.toContain('core board');
  });

  test('Focus 1/2: later requests only append; new and changed items are appended once, removals once', () => {
    const s = briefStream(big);
    const h1 = human('first MARK-A');
    const r1 = s.request('art', { core: brief('art', '- d1', 't1'), shape: 'brief', board: board(), humans: [h1] });
    // nothing changed: delta and trigger only
    const r2 = s.request('art', { core: brief('art', '- d2', 't2'), shape: 'brief', board: board(), humans: [h1] });
    expect(r2.snapshot).toBe(false);
    expect(isPrefix(texts(r1.segments), texts(r2.segments))).toBe(true);
    expect(kinds(r2.segments.slice(r1.segments.length))).toEqual(['delta', 'trigger']);
    // a new convention, a contract version bump, a status change, a new human message
    const h2 = human('second MARK-B');
    const b3 = board({
      conventions: [item('conv-1', 'Use snake_case MARK-CONV'), item('conv-2', 'Tabs MARK-NEW')],
      contracts: [{ id: 'c-1', from: 'art', to: 'logic', spec: 'PNG 64x64 MARK-V2', version: 2 }],
      workstreams: board().workstreams.map(w => (w.id === 'art' ? { ...w, status: 'delivered' as const } : w)),
    });
    const r3 = s.request('art', { core: brief('art', '- d3', 't3'), shape: 'brief', board: b3, humans: [h1, h2] });
    expect(isPrefix(texts(r2.segments), texts(r3.segments))).toBe(true);
    const added = r3.segments.slice(r2.segments.length);
    expect(kinds(added)).toEqual(['updates', 'delta', 'trigger']);
    const u = added[0]!.text;
    expect(u).toContain('- [#' + h2.seq + ' human] second MARK-B');
    expect(u).not.toContain('MARK-A');
    expect(u).toContain('- [conv-2] Tabs MARK-NEW');
    expect(u).not.toContain('MARK-CONV');
    expect(u).toContain('- [c-1@v2] art -> logic: PNG 64x64 MARK-V2');
    expect(u).toContain('art | Art | art | delivered');
    expect(u).not.toContain('logic | Logic');
    expect(u).not.toContain('dec-1');
    // same board again: nothing re-appended
    const r4 = s.request('art', { core: brief('art', '- d4', 't4'), shape: 'brief', board: b3, humans: [h1, h2] });
    expect(kinds(r4.segments.slice(r3.segments.length))).toEqual(['delta', 'trigger']);
    // removal: dec-1 and the logic workstream leave the board; a decision's text changes
    const b5 = { ...b3, decisions: [], failures: [{ ...b3.failures[0]!, reason: 'way too slow MARK-FAIL2' }], workstreams: b3.workstreams.filter(w => w.id !== 'logic') };
    const r5 = s.request('art', { core: brief('art', '- d5', 't5'), shape: 'brief', board: b5, humans: [h1, h2] });
    const u5 = r5.segments.slice(r4.segments.length)[0]!;
    expect(u5.kind).toBe('updates');
    expect(u5.text).toContain('- [dec-1] removed from the board');
    expect(u5.text).toContain('- workstream logic removed from the board');
    expect(u5.text).toContain('why it failed: way too slow MARK-FAIL2');
    const r6 = s.request('art', { core: brief('art', '- d6', 't6'), shape: 'brief', board: b5, humans: [h1, h2] });
    expect(all(r6.segments).split('removed from the board').length - 1).toBe(2);
    expect(r6.segments.every(x => x.cacheable)).toBe(true);
  });

  test('project-wide items reach every bot; bot-relevant content (delta, trigger) only the bot it was built for', () => {
    const s = briefStream(big);
    s.request('art', { core: brief('art', '- d', 't'), shape: 'brief', board: board(), humans: [] });
    s.request('logic', { core: brief('logic', '- d', 't'), shape: 'brief', board: board(), humans: [] });
    const b = board({ failures: [...board().failures, { ...item('fail-2', 'Tried canvas2d'), reason: 'MARK-ALL', affects: ['logic'] }] });
    const a = s.request('art', { core: brief('art', '- art only MARK-ART', 't'), shape: 'brief', board: b, humans: [] });
    const l = s.request('logic', { core: brief('logic', '- logic only', 't'), shape: 'brief', board: b, humans: [] });
    expect(all(a.segments)).toContain('MARK-ALL');
    expect(all(l.segments)).toContain('MARK-ALL');
    expect(all(a.segments)).toContain('MARK-ART');
    expect(all(l.segments)).not.toContain('MARK-ART');
  });

  test('Focus 4: review and planning bodies are appended after the existing stream; they do not change the prefix', () => {
    const s = briefStream(big);
    const r1 = s.request('pm', { core: brief('pm', '- d', 't1'), shape: 'brief', board: board(), humans: [] });
    const r2 = s.request('pm', { core: context('## Content to review\nMARK-REVIEW', 'review'), shape: 'context', board: board(), humans: [] });
    expect(r2.snapshot).toBe(false);
    expect(isPrefix(texts(r1.segments), texts(r2.segments))).toBe(true);
    expect(kinds(r2.segments.slice(r1.segments.length))).toEqual(['projection', 'trigger']);
    expect(r2.segments.at(-2)!.text).toContain('MARK-REVIEW');
    const r3 = s.request('pm', { core: context('# Plan the project\nMARK-PLAN', 'replan'), shape: 'context', board: board(), humans: [] });
    expect(isPrefix(texts(r2.segments), texts(r3.segments))).toBe(true);
    const r4 = s.request('pm', { core: brief('pm', '- d4', 't4'), shape: 'brief', board: board(), humans: [] });
    expect(isPrefix(texts(r3.segments), texts(r4.segments))).toBe(true);
  });

  test('a snapshot on a review or planning request takes the projection the host passes (a peek brief), then the body', () => {
    const s = briefStream(big);
    expect(s.needsSnapshot('pm')).toBe(true);
    const r = s.request('pm', { core: context('BODY', 'review'), shape: 'context', board: board(), humans: [], projection: '# Your part\n\npm part' });
    expect(r.snapshot).toBe(true);
    expect(kinds(r.segments)).toEqual(['common', 'memory', 'workspace', 'board', 'projection', 'projection', 'trigger']);
    expect(r.segments[4]!.text).toBe('# Your part\n\npm part');
    expect(r.segments[5]!.text).toBe('BODY');
    expect(s.needsSnapshot('pm')).toBe(false);
    // the next brief compares its projection with the peeked one: unchanged, so nothing re-appended
    const r2 = s.request('pm', { core: brief('pm', '- d', 't'), shape: 'brief', board: board(), humans: [] });
    expect(kinds(r2.segments.slice(r.segments.length))).toEqual(['delta', 'trigger']);
  });

  test('R-S2: a changed memory, workspace or projection appends only its new lines, under a header naming the section', () => {
    const s = briefStream(big);
    const part = (decisions: string, facts: string, upstream: string) =>
      ['# Your part', '', 'art | Art | art | active', 'Brief:', 'do art', 'review rounds: 0', '', '## Decisions', decisions, '', '## Facts', facts, '', '## Upstream deliverables', upstream].join('\n');
    const core = (notes: string, p: string, mem = 'art') =>
      brief('art', '- d', 't').map(x =>
        x.kind === 'workspace' ? { ...x, text: `# Your notes\n\n${notes}` } : x.kind === 'projection' ? { ...x, text: p } : x.kind === 'memory' ? { ...x, text: `# Your memory\n\n${mem}` } : x,
      );
    const decision = '- [dec-1] Use canvas for every sprite\n  why: fast\n  affects: art';
    const p1 = part(decision, '- [fact-1] Palette has 16 colours', '(nothing yet)');
    const r1 = s.request('art', { core: core('Pinned:\n- n1', p1), shape: 'brief', board: board(), humans: [] });
    // unchanged: nothing but delta and trigger
    const r2 = s.request('art', { core: core('Pinned:\n- n1', p1), shape: 'brief', board: board(), humans: [] });
    expect(kinds(r2.segments.slice(r1.segments.length))).toEqual(['delta', 'trigger']);
    // an upstream deliverable arrives and a pinned note is added: only the new lines
    const p3 = part(decision, '- [fact-1] Palette has 16 colours', '- logic delivered v1: rules MARK-UP (ref: r1)');
    const r3 = s.request('art', { core: core('Pinned:\n- n1\n- n2 MARK-PIN', p3), shape: 'brief', board: board(), humans: [] });
    expect(isPrefix(texts(r2.segments), texts(r3.segments))).toBe(true);
    const a3 = r3.segments.slice(r2.segments.length);
    expect(kinds(a3)).toEqual(['workspace', 'projection', 'delta', 'trigger']);
    expect(a3[0]!.text).toBe('# Your notes — updates\n\n- n2 MARK-PIN');
    expect(a3[1]!.text).toBe('# Your part — updates\n\n## Upstream deliverables\n- logic delivered v1: rules MARK-UP (ref: r1)');
    // seen compaction: the decision becomes its "(seen)" form: nothing appended
    const p4 = part('- [dec-1] Use canvas for every sprite (seen)', '- [fact-1] Palette has 16 colours (seen)', '- logic delivered v1: rules MARK-UP (ref: r1)');
    const r4 = s.request('art', { core: core('Pinned:\n- n1\n- n2 MARK-PIN', p4), shape: 'brief', board: board(), humans: [] });
    expect(kinds(r4.segments.slice(r3.segments.length))).toEqual(['delta', 'trigger']);
    // a content line disappears (and a value line changes): one "no longer" entry, the new value line
    const p5 = part('- [dec-1] Use canvas for every sprite (seen)', '(nothing yet)', '- logic delivered v1: rules MARK-UP (ref: r1)').replace('review rounds: 0', 'review rounds: 1');
    const r5 = s.request('art', { core: core('Pinned:\n- n1\n- n2 MARK-PIN', p5), shape: 'brief', board: board(), humans: [] });
    const a5 = r5.segments.slice(r4.segments.length);
    expect(kinds(a5)).toEqual(['projection', 'delta', 'trigger']);
    expect(a5[0]!.text).toBe('# Your part — updates\n\nreview rounds: 1\n\n## Facts\nno longer: - [fact-1] Palette has 16 colours (seen)');
    // a context request: its projection segment is the body; memory is still diffed
    const ctx = context('BODY', 'review').map(x => (x.kind === 'workspace' ? { ...x, text: '# Your notes\n\nPinned:\n- n1\n- n2 MARK-PIN' } : x.kind === 'memory' ? { ...x, text: '# Your memory\n\nart\nMARK-MEM' } : x));
    const r6 = s.request('art', { core: ctx, shape: 'context', board: board(), humans: [] });
    const a6 = r6.segments.slice(r5.segments.length);
    expect(kinds(a6)).toEqual(['memory', 'projection', 'trigger']);
    expect(a6[0]!.text).toBe('# Your memory — updates\n\nMARK-MEM');
    const r7 = s.request('art', { core: core('Pinned:\n- n1\n- n2 MARK-PIN', p5, 'art\nMARK-MEM'), shape: 'brief', board: board(), humans: [] });
    expect(kinds(r7.segments.slice(r6.segments.length))).toEqual(['delta', 'trigger']);
  });

  test('Focus 3: once more than restreamTokens were appended since the snapshot, the next request is a new, complete snapshot', () => {
    const s = briefStream({ restreamTokens: 60, count });
    const hs = [human('h0 MARK-S0')];
    const r1 = s.request('art', { core: brief('art', '- d', 't'), shape: 'brief', board: board(), humans: hs });
    expect(r1.snapshot).toBe(true);
    // small appends stay below the limit
    const r2 = s.request('art', { core: brief('art', '-', 'x'), shape: 'brief', board: board(), humans: hs });
    expect(r2.snapshot).toBe(false);
    // a big append crosses it; this request is still an append
    hs.push(human('h1 MARK-S1'));
    const b = board({ conventions: [item('conv-1', 'Use snake_case MARK-CONV'), item('conv-9', 'MARK-LATE')] });
    const r3 = s.request('art', { core: brief('art', `- ${'y'.repeat(200)}`, 't'), shape: 'brief', board: b, humans: hs });
    expect(r3.snapshot).toBe(false);
    expect(isPrefix(texts(r2.segments), texts(r3.segments))).toBe(true);
    // the next one is a snapshot holding everything appended before
    const r4 = s.request('art', { core: brief('art', '- d4', 't4'), shape: 'brief', board: b, humans: hs });
    expect(r4.snapshot).toBe(true);
    expect(kinds(r4.segments)).toEqual(['common', 'memory', 'workspace', 'board', 'projection', 'delta', 'trigger']);
    for (const m of ['MARK-S0', 'MARK-S1', 'MARK-LATE', 'MARK-CONV', 'MARK-CONTRACT', 'MARK-WHY', 'MARK-FAIL']) expect(r4.segments[3]!.text).toContain(m);
    expect(all(r4.segments)).not.toContain('y'.repeat(200));
    // and the stream continues from the new snapshot, without re-appending what it holds
    const r5 = s.request('art', { core: brief('art', '-', 'x'), shape: 'brief', board: b, humans: hs });
    expect(r5.snapshot).toBe(false);
    expect(isPrefix(texts(r4.segments), texts(r5.segments))).toBe(true);
    expect(kinds(r5.segments.slice(r4.segments.length))).toEqual(['delta', 'trigger']);
  });

  test('a human message the stream already carries is not repeated from the delta; an empty delta is left out', () => {
    const s = briefStream(big);
    const h = human('please MARK-ONCE');
    const line = `- #${h.seq} human (id: ${h.id}): please MARK-ONCE`;
    s.request('logic', { core: brief('logic', '- d', 't'), shape: 'brief', board: board(), humans: [] });
    const r = s.request('logic', { core: brief('logic', `${line}\n- #99 art (id: e-99): hello`, 't2'), shape: 'brief', board: board(), humans: [h] });
    expect(all(r.segments).split('MARK-ONCE').length - 1).toBe(1);
    expect(all(r.segments)).toContain('- #99 art (id: e-99): hello');
    const r2 = s.request('logic', { core: brief('logic', line, 't3'), shape: 'brief', board: board(), humans: [h] });
    expect(kinds(r2.segments.slice(r.segments.length))).toEqual(['trigger']);
    const r3 = s.request('logic', { core: brief('logic', '(nothing yet)', 't4'), shape: 'brief', board: board(), humans: [h] });
    expect(kinds(r3.segments.slice(r2.segments.length))).toEqual(['trigger']);
  });

  test('the default restream budget is 8,000 tokens', () => {
    expect(DEFAULT_RESTREAM_TOKENS).toBe(8000);
  });
});

// ---------------------------------------------------------------------------
// group C in stream mode, end to end with the real core
// ---------------------------------------------------------------------------

/** Runs group C on a scenario, capturing every request the model sees. */
async function runC(id: string, stream?: { restreamTokens: number }) {
  const s = loadScenario(scenarioPath(id));
  const seen: ModelRequest[] = [];
  const inner = new ScriptedModel(s.idleReply ?? 'Noted.');
  const model = { complete: async (r: ModelRequest) => (seen.push(r), inner.complete(r)) };
  const policy = projectPolicy(stream === undefined ? {} : { stream });
  const run = await runScenario(s, policy, { model });
  return { ...run, seen };
}

describe('group C with --c-stream on', () => {
  test('the core is driven exactly as without the stream: same requests, wakes and core errors; only the text changes', async () => {
    for (const id of ['product-plan', 'flappy-bird', 'event-plan']) {
      const off = await runC(id);
      const on = await runC(id, { restreamTokens: DEFAULT_RESTREAM_TOKENS });
      expect(on.records.map(r => [r.botId, r.kind, r.step]), id).toEqual(off.records.map(r => [r.botId, r.kind, r.step]));
      expect(on.stats.coreErrors, id).toBe(off.stats.coreErrors);
      expect(on.stats.unfinished, id).toBe(off.stats.unfinished);
      expect(on.stats.cacheableUpperBound, id).toBeUndefined();
      expect(on.records.map(r => r.inputTokens), id).not.toEqual(off.records.map(r => r.inputTokens));
    }
  });

  test('Focus 1: without a restream every request of a bot extends its previous one, and that prefix is cacheable', async () => {
    const { records, seen } = await runC('long-app', { restreamTokens: 100_000_000 });
    const prev = new Map<string, string[]>();
    for (const [i, req] of seen.entries()) {
      const t = req.segments.map(x => x.text);
      const p = prev.get(req.botId);
      if (p !== undefined) {
        expect(isPrefix(p, t), `request ${i} of ${req.botId}`).toBe(true);
        const prefixTokens = records[i]!.inputTokens - records[i]!.segments!.filter(x => !x.cacheable).reduce((n, x) => n + x.tokens, 0);
        expect(records[i]!.cacheableTokens).toBe(prefixTokens);
        expect(req.segments.slice(0, p.length).every(x => x.cacheable)).toBe(true);
        expect(req.segments.slice(p.length).some(x => x.cacheable)).toBe(false);
      }
      prev.set(req.botId, t);
    }
  });

  test('with the default budget streams restream, and every request is either an append or a fresh snapshot', async () => {
    const { seen } = await runC('long-app', { restreamTokens: DEFAULT_RESTREAM_TOKENS });
    const prev = new Map<string, string[]>();
    let snapshots = 0;
    for (const req of seen) {
      const t = req.segments.map(x => x.text);
      const p = prev.get(req.botId);
      if (p !== undefined && !isPrefix(p, t)) {
        snapshots++;
        // a snapshot: common, memory, workspace, the full board, projection(s), then at most delta and trigger
        expect(t[0]!.startsWith('# Team')).toBe(true);
        expect(t[3]!.startsWith('# Project\n\n## Goal')).toBe(true);
        expect(t.length).toBeLessThanOrEqual(7);
        expect(t.some(x => x.startsWith('# Project updates'))).toBe(false);
        expect(t.at(-1)!.startsWith('# Why you are awake')).toBe(true);
      }
      prev.set(req.botId, t);
    }
    expect(snapshots).toBeGreaterThan(0);
  });

  test('a restream landing on a review or replan carries the lead projection from a peek brief; the core is driven the same', async () => {
    const off = await runC('long-app');
    const { seen, records, stats } = await runC('long-app', { restreamTokens: 300 });
    expect(records.map(r => [r.botId, r.kind, r.step])).toEqual(off.records.map(r => [r.botId, r.kind, r.step]));
    expect(stats.coreErrors).toBe(off.stats.coreErrors);
    const prev = new Map<string, string[]>();
    let onContext = 0;
    for (const req of seen) {
      const t = req.segments.map(x => x.text);
      const p = prev.get(req.botId);
      prev.set(req.botId, t);
      if (p === undefined || isPrefix(p, t)) continue;
      expect(t[4]!.startsWith('# Your part')).toBe(true);
      const body = t.at(-2)!;
      if (body.startsWith('# Plan the project') || body.includes('## Content to review')) onContext++;
    }
    expect(onContext).toBeGreaterThan(0);
  });

  test('the stream setting reaches group C only', () => {
    const opts = { window: 128000, compactRatio: 0.8, summaryTokens: 1500, stream: { restreamTokens: 8000 } };
    for (const g of ['A', 'B', 'D', 'E', 'F'] as const) expect(createPolicy(g, opts).group).toBe(g);
    expect(createPolicy('C', opts).group).toBe('C');
  });
});
