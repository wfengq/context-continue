// Long-project stream mode (spec 2026-11-06 §2): append-only per-bot streams built by the core.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { createEmployeeRegistry } from '../src/employees.js';
import { DEFAULT_STREAM_OPTIONS, resolveStreamOptions } from '../src/options.js';
import { createProject, type Project } from '../src/project.js';
import { sqliteStore } from '../src/store/sqlite.js';
import type { BoardOp, ContextBundle, StreamBundle } from '../src/types.js';
import { FIXTURE_PLAN, fakeClock, makeProject, PERSONAS, type FacadeProject } from './helpers.js';

const MAX = 100_000;
const trig = (detail: string) => ({ reason: 'manual' as const, detail });
const texts = (b: { segments: { text: string }[] }) => b.segments.map(s => s.text);
const kinds = (b: { segments: { kind: string }[] }) => b.segments.map(s => s.kind);
const all = (b: { segments: { text: string }[] }) => texts(b).join('\n');
const isPrefix = (a: string[], b: string[]) => a.length <= b.length && a.every((t, i) => b[i] === t);
const occurrences = (hay: string, needle: string) => hay.split(needle).length - 1;
const ids = () => {
  let n = 0;
  return (prefix: string) => `${prefix}-${++n}`;
};
const on = (over: Record<string, unknown> = {}) => ({ mode: 'on' as const, ...over });

async function streamProject(over: Record<string, unknown> = {}, extra: Parameters<typeof makeProject>[0] = {}) {
  return makeProject({ approved: true, newId: ids(), stream: on(over), ...extra });
}

const brief = (p: Project, bot: string, detail = 'go') => p.buildStream(bot, { maxTokens: MAX, trigger: trig(detail) });
const addConvention = (text: string): BoardOp => ({ op: 'add', section: 'conventions', item: { text, source: { entryIds: [], by: 'pm' } } });

/** Resolves every pending proposal (lead ones by the lead, human ones by the owner). */
async function resolveAll(fx: FacadeProject) {
  for (const p of await fx.p.pending()) await fx.p.resolveProposal(p.id, { by: p.needs === 'lead' ? 'pm' : 'alice', accept: true });
}

// ---------------------------------------------------------------------------
// options
// ---------------------------------------------------------------------------

describe('stream options', () => {
  test('defaults: off, 8,000 restream tokens, 40 human messages kept in full', () => {
    expect(resolveStreamOptions()).toEqual(DEFAULT_STREAM_OPTIONS);
    expect(DEFAULT_STREAM_OPTIONS).toMatchObject({ mode: 'off', restreamTokens: 8000, snapshotHumanKeep: 40 });
    expect(resolveStreamOptions({ mode: 'on', restreamTokens: 100 })).toMatchObject({ mode: 'on', restreamTokens: 100, snapshotHumanKeep: 40 });
  });

  test.each([
    [{ mode: 'yes' }],
    [{ mode: 1 }],
    [{ restreamTokens: 0 }],
    [{ restreamTokens: -5 }],
    [{ restreamTokens: 1.5 }],
    [{ restreamTokens: '8000' }],
    [{ snapshotHumanKeep: 0 }],
    [{ snapshotHumanKeep: Number.POSITIVE_INFINITY }],
    [{ autoAfterEntries: 2.5 }],
    [{ autoAfterEntries: 0 }],
  ])('rejects %j with INVALID_OP', async bad => {
    expect(() => resolveStreamOptions(bad as never)).toThrow(expect.objectContaining({ code: 'INVALID_OP' }));
    await expect(makeProject({ stream: bad as never })).rejects.toMatchObject({ code: 'INVALID_OP' });
  });

  test('rejects a non-object', () => {
    for (const bad of [null, 5, 'on', []]) expect(() => resolveStreamOptions(bad as never)).toThrow(expect.objectContaining({ code: 'INVALID_OP' }));
  });
});

// ---------------------------------------------------------------------------
// mode off
// ---------------------------------------------------------------------------

describe('mode off', () => {
  test('buildStream equals buildBrief, the review context and the planning context; recordOwnOutput does nothing', async () => {
    const run = async (useStream: boolean) => {
      const fx = await makeProject({ approved: true, newId: ids(), ...(useStream ? { stream: { mode: 'off' as const } } : {}) });
      const out: (ContextBundle | StreamBundle)[] = [];
      const b = (bot: string, d: string) =>
        useStream ? fx.p.buildStream(bot, { maxTokens: MAX, trigger: trig(d) }) : fx.p.buildBrief(bot, { maxTokens: MAX, trigger: trig(d) });
      out.push(await b('art', 'one'));
      await fx.p.ingest({ author: { kind: 'human', id: 'alice' }, text: 'Use bright colours please' });
      await fx.p.submit('art', { type: 'deliverable', workstreamId: 'art', summary: 'sheet', content: 'PNG' });
      out.push(await b('pm', 'two'));
      if (useStream) await fx.p.recordOwnOutput('art', 'my reply');
      const d = (await fx.p.board()).workstreams.find(w => w.id === 'art')!.deliverables[0]!.id;
      out.push(
        useStream
          ? await fx.p.buildStream('pm', { maxTokens: MAX, trigger: trig('review'), request: { kind: 'review', deliverableId: d } })
          : await fx.p.buildReviewContext(d, { trigger: trig('review') }),
      );
      out.push(
        useStream
          ? await fx.p.buildStream('pm', { maxTokens: MAX, trigger: trig('plan'), request: { kind: 'planning' } })
          : await fx.p.buildPlanningContext({ trigger: trig('plan') }),
      );
      out.push(await b('art', 'three'));
      expect(await fx.store.getMeta(fx.projectId, 'stream:art')).toBeNull();
      return { out, ws: await Promise.all(['pm', 'art'].map(x => fx.store.getWorkspace(fx.projectId, x))) };
    };
    const plain = await run(false);
    const streamed = await run(true);
    expect(streamed.out).toEqual(plain.out);
    expect(streamed.ws).toEqual(plain.ws);
  });

  test('an unknown request kind is INVALID_OP', async () => {
    const fx = await makeProject({ approved: true });
    await expect(fx.p.buildStream('art', { maxTokens: MAX, trigger: trig('x'), request: { kind: 'nope' } as never })).rejects.toMatchObject({ code: 'INVALID_OP' });
    const s = await streamProject();
    await expect(s.p.buildStream('art', { maxTokens: MAX, trigger: trig('x'), request: { kind: 'nope' } as never })).rejects.toMatchObject({ code: 'INVALID_OP' });
  });
});

// ---------------------------------------------------------------------------
// snapshot
// ---------------------------------------------------------------------------

describe('snapshot', () => {
  test('the first request is a snapshot: brief prefix, the full project board, projection, delta, trigger; all cacheable', async () => {
    const fx = await streamProject();
    await fx.p.submit('pm', { type: 'proposal', ops: [addConvention('Use snake_case MARK-CONV')] });
    await fx.p.submit('pm', {
      type: 'proposal',
      ops: [
        { op: 'addDecision', decision: { text: 'Use canvas', rationale: 'fast MARK-WHY', rejected: ['WebGL'], affects: ['art'], source: { entryIds: [], by: 'pm' } } },
        { op: 'addFailure', failure: { text: 'Tried SVG', reason: 'too slow MARK-FAIL', affects: ['logic'], source: { entryIds: [], by: 'pm' } } },
      ],
    });
    await resolveAll(fx);
    await fx.p.ingest({ author: { kind: 'human', id: 'alice' }, text: 'Make it pop MARK-H1' });
    const b = await brief(fx.p, 'audio', 'first task');
    expect(b.snapshot).toBe(true);
    expect(kinds(b)).toEqual(['common', 'memory', 'workspace', 'board', 'projection', 'trigger']);
    expect(b.segments.every(s => s.cacheable)).toBe(true);
    const board = b.segments[3]!.text;
    for (const m of [
      '# Project',
      'Ship a tiny platformer demo.',
      '- Runs in the browser',
      'Use snake_case MARK-CONV',
      '- [c1@v1] art -> logic: PNG sprite sheets, 16x16 tiles',
      'Use canvas\n  why: fast MARK-WHY\n  rejected: WebGL\n  affects: art',
      'tried: Tried SVG\n  why it failed: too slow MARK-FAIL\n  affects: logic',
      '- art | Sprites | art | active',
      '- logic | Gameplay | logic | pending',
      '## Human messages',
      'alice] Make it pop MARK-H1',
    ]) {
      expect(board).toContain(m);
    }
    expect(board).not.toContain('## Retired contracts');
    expect(b.segments.at(-1)!.text).toBe('# Why you are awake\n\nreason: manual\nfirst task');
    expect(b.stats.total).toBe(Object.values(b.stats.bySegment).reduce((n, x) => n + (x ?? 0), 0));
  });

  test('human messages: all of them; beyond snapshotHumanKeep the older ones are folded to 160 characters', async () => {
    const fx = await streamProject({ snapshotHumanKeep: 3 });
    const long = (i: number) => `message ${i} MARK-${i} ${'x'.repeat(200)} TAIL-${i}`;
    for (let i = 1; i <= 5; i++) await fx.p.ingest({ author: { kind: 'human', id: 'alice' }, text: long(i) });
    const b = await brief(fx.p, 'art');
    const board = b.segments[3]!.text;
    for (let i = 1; i <= 5; i++) expect(board).toContain(`MARK-${i} `);
    // the two oldest: shortened, the three newest: in full
    for (const i of [1, 2]) {
      expect(board).not.toContain(`TAIL-${i}`);
      const line = board.split('\n').find(l => l.includes(`MARK-${i} `))!;
      expect(line).toContain(Array.from(long(i)).slice(0, 160).join(''));
      expect(line.length).toBeLessThan(200);
    }
    for (const i of [3, 4, 5]) expect(board).toContain(long(i));
    expect(board.indexOf('MARK-2 ')).toBeLessThan(board.indexOf('MARK-3 '));
  });

  test('with the default keep of 40, 45 messages fold the 5 oldest', async () => {
    const fx = await streamProject();
    for (let i = 1; i <= 45; i++) await fx.p.ingest({ author: { kind: 'human', id: 'alice' }, text: `m${i} ${'y'.repeat(170)} END${i}` });
    const board = (await brief(fx.p, 'art')).segments[3]!.text;
    for (let i = 1; i <= 45; i++) expect(board.includes(`END${i}\n`) || board.endsWith(`END${i}`), `END${i}`).toBe(i > 5);
  });
});

// ---------------------------------------------------------------------------
// appends
// ---------------------------------------------------------------------------

describe('appends', () => {
  test('nothing changed: only the trigger is appended (an empty delta is left out); the trigger is last', async () => {
    const fx = await streamProject();
    const a = await brief(fx.p, 'art', 't1');
    const b = await brief(fx.p, 'art', 't2');
    expect(b.snapshot).toBe(false);
    expect(isPrefix(texts(a), texts(b))).toBe(true);
    expect(kinds(b).slice(a.segments.length)).toEqual(['trigger']);
    expect(b.segments.at(-1)!.text).toContain('t2');
  });

  test('project-wide changes are appended once, to every bot: new, changed (version), status, human message', async () => {
    const fx = await streamProject();
    const a1 = await brief(fx.p, 'art');
    const l1 = await brief(fx.p, 'audio');
    await fx.p.submit('pm', { type: 'proposal', ops: [addConvention('Tabs MARK-NEW'), { op: 'updateContract', id: 'c1', spec: 'PNG 64x64 MARK-V2' }] });
    await resolveAll(fx);
    await fx.p.ingest({ author: { kind: 'human', id: 'alice' }, text: 'Hurry MARK-HUMAN' });
    await fx.p.submit('art', { type: 'blocked', workstreamId: 'art', reason: 'waiting' });
    const a2 = await brief(fx.p, 'art');
    const l2 = await brief(fx.p, 'audio');
    for (const [prev, now] of [
      [a1, a2],
      [l1, l2],
    ] as const) {
      expect(now.snapshot).toBe(false);
      expect(isPrefix(texts(prev), texts(now))).toBe(true);
      const added = now.segments.slice(prev.segments.length);
      expect(added[0]!.kind).toBe('updates');
      const u = added[0]!.text;
      expect(u.startsWith('# Project updates')).toBe(true);
      expect(u).toContain('Tabs MARK-NEW');
      expect(u).toContain('- [c1@v2] art -> logic: PNG 64x64 MARK-V2');
      expect(u).toContain('- art | Sprites | art | blocked');
      expect(u).toContain('alice] Hurry MARK-HUMAN');
      expect(u).not.toContain('audio | Sound');
      expect(added.at(-1)!.kind).toBe('trigger');
    }
    const a3 = await brief(fx.p, 'art');
    expect(kinds(a3).slice(a2.segments.length)).not.toContain('updates');
    // once in the project updates (art's own projection, appended whole when it changes, also names its contract and status)
    const updates = a3.segments.filter(s => s.kind === 'updates').map(s => s.text).join('\n');
    for (const m of ['MARK-NEW', 'MARK-V2', 'MARK-HUMAN', '| blocked']) expect(occurrences(updates, m), m).toBe(1);
    for (const m of ['MARK-NEW', 'MARK-HUMAN']) expect(occurrences(all(a3), m), m).toBe(1);
  });

  test('a human message the stream carries is removed from the delta (lead sees every human message in its delta)', async () => {
    const fx = await streamProject();
    await brief(fx.p, 'pm');
    await fx.p.ingest({ author: { kind: 'human', id: 'alice' }, text: 'please MARK-ONCE' });
    await fx.p.ingest({ author: { kind: 'bot', id: 'art' }, text: 'hello @pm MARK-BOT', mentions: ['pm'], act: 'inform' });
    // without the stream the lead's delta carries the human message
    const plain = await fx.p.buildBrief('pm', { maxTokens: MAX, peek: true });
    expect(plain.segments.find(s => s.kind === 'delta')!.text).toContain('MARK-ONCE');
    const b = await brief(fx.p, 'pm');
    expect(occurrences(all(b), 'MARK-ONCE')).toBe(1);
    const delta = b.segments.filter(s => s.kind === 'delta').at(-1)!.text;
    expect(delta).toContain('MARK-BOT');
    expect(delta).not.toContain('MARK-ONCE');
  });

  test('memory, notes and projection: unchanged ones are not repeated; a changed one is appended whole', async () => {
    const fx = await streamProject();
    const a = await brief(fx.p, 'art');
    await fx.p.submit('art', { type: 'notes', text: 'remember MARK-NOTE', pinned: true });
    const b = await brief(fx.p, 'art');
    const added = b.segments.slice(a.segments.length);
    expect(kinds({ segments: added })).toEqual(['workspace', 'trigger']);
    expect(added[0]!.text).toContain('MARK-NOTE');
    expect(added[0]!.text.startsWith('# Your notes')).toBe(true);
    // a decision affecting art changes art's projection
    await fx.p.submit('pm', { type: 'proposal', ops: [{ op: 'addDecision', decision: { text: 'Pixel art MARK-DEC', rationale: 'r', rejected: [], affects: ['art'], source: { entryIds: [], by: 'pm' } } }] });
    await resolveAll(fx);
    const c = await brief(fx.p, 'art');
    const k = kinds({ segments: c.segments.slice(b.segments.length) });
    expect(k).toContain('projection');
    expect(k).toContain('updates');
  });

  test('retired contracts: appended once under project updates; in the next snapshot; appended again after re-add and second retirement', async () => {
    const fx = await streamProject({ restreamTokens: 1_000_000 });
    const plan = (contracts: typeof FIXTURE_PLAN.contracts) => ({ workstreams: FIXTURE_PLAN.workstreams, contracts });
    const replan = async (contracts: typeof FIXTURE_PLAN.contracts) => {
      const { proposalId } = await fx.p.proposePlan(plan(contracts), { by: 'pm' });
      await fx.p.approvePlan(proposalId, { by: 'alice' });
    };
    const line = '- [c1@v1] art -> logic: PNG sprite sheets, 16x16 tiles';
    const a = await brief(fx.p, 'audio');
    await replan([]);
    const b = await brief(fx.p, 'audio');
    const u = b.segments.slice(a.segments.length).find(s => s.kind === 'updates')!.text;
    expect(u).toContain(`## Retired contracts\n${line}`);
    expect(u).not.toContain('removed from the board');
    const c = await brief(fx.p, 'audio');
    expect(kinds(c).slice(b.segments.length)).toEqual(['trigger']);
    // re-added: back under Contracts; retired again: appended again
    await replan(FIXTURE_PLAN.contracts);
    const d = await brief(fx.p, 'audio');
    expect(d.segments.slice(c.segments.length).find(s => s.kind === 'updates')!.text).toContain(`## Contracts\n${line}`);
    await replan([]);
    const e = await brief(fx.p, 'audio');
    expect(e.segments.slice(d.segments.length).find(s => s.kind === 'updates')!.text).toContain(`## Retired contracts\n${line}`);
    // a fresh bot's snapshot carries the retired contract in its own section
    const snap = await brief(fx.p, 'logic');
    expect(snap.snapshot).toBe(true);
    expect(snap.segments[3]!.text).toContain(`## Retired contracts\n${line}`);
  });

  test('review and planning: body and trigger appended; a snapshot on a context takes the projection from the brief', async () => {
    const fx = await streamProject();
    await fx.p.submit('art', { type: 'deliverable', workstreamId: 'art', summary: 'sheet', content: 'PNG MARK-CONTENT' });
    const d = (await fx.p.board()).workstreams.find(w => w.id === 'art')!.deliverables[0]!.id;
    const r1 = await fx.p.buildStream('pm', { maxTokens: MAX, trigger: trig('review it'), request: { kind: 'review', deliverableId: d } });
    expect(r1.snapshot).toBe(true);
    expect(kinds(r1)).toEqual(['common', 'memory', 'workspace', 'board', 'projection', 'projection', 'trigger']);
    expect(r1.segments[4]!.text.startsWith('# Your part')).toBe(true);
    expect(r1.segments[5]!.text).toContain('MARK-CONTENT');
    const r2 = await fx.p.buildStream('pm', { maxTokens: MAX, trigger: trig('plan it'), request: { kind: 'planning' } });
    expect(r2.snapshot).toBe(false);
    expect(isPrefix(texts(r1), texts(r2))).toBe(true);
    const added = r2.segments.slice(r1.segments.length);
    expect(added.at(-2)!.text.startsWith('# Plan the project')).toBe(true);
    expect(added.at(-1)!.text).toContain('plan it');
    const r3 = await brief(fx.p, 'pm');
    expect(isPrefix(texts(r2), texts(r3))).toBe(true);
  });

  test('recordOwnOutput appends to that bot only, counts toward the budget, and the next snapshot drops it', async () => {
    const fx = await streamProject({ restreamTokens: 200 });
    await fx.p.recordOwnOutput('art', 'before any request MARK-EARLY'); // no stream yet: nothing to append to
    const a = await brief(fx.p, 'art');
    expect(all(a)).not.toContain('MARK-EARLY');
    await fx.p.recordOwnOutput('art', '[bot art] drew it MARK-OWN');
    const b = await brief(fx.p, 'art');
    expect(b.snapshot).toBe(false);
    expect(isPrefix(texts(a), texts(b))).toBe(true);
    expect(kinds(b).slice(a.segments.length)).toEqual(['own', 'trigger']);
    expect(b.segments[a.segments.length]!).toEqual({ kind: 'own', text: '[bot art] drew it MARK-OWN', cacheable: true });
    expect(all(await brief(fx.p, 'audio'))).not.toContain('MARK-OWN');
    await fx.p.recordOwnOutput('art', `[bot art] ${'z'.repeat(2000)}`);
    const c = await brief(fx.p, 'art');
    expect(c.snapshot).toBe(true);
    expect(all(c)).not.toContain('MARK-OWN');
    expect(all(c)).not.toContain('zzzz');
  });

  test('restream: once more than restreamTokens were appended, the next request is a new complete snapshot', async () => {
    const fx = await streamProject({ restreamTokens: 150 });
    const a = await brief(fx.p, 'art');
    await fx.p.ingest({ author: { kind: 'human', id: 'alice' }, text: `big ${'w'.repeat(800)} MARK-BIG` });
    const b = await brief(fx.p, 'art');
    expect(b.snapshot).toBe(false);
    expect(isPrefix(texts(a), texts(b))).toBe(true);
    const c = await brief(fx.p, 'art');
    expect(c.snapshot).toBe(true);
    expect(kinds(c)).toEqual(['common', 'memory', 'workspace', 'board', 'projection', 'trigger']);
    expect(c.segments[3]!.text).toContain('MARK-BIG');
    const d = await brief(fx.p, 'art');
    expect(d.snapshot).toBe(false);
    expect(isPrefix(texts(c), texts(d))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// side effects and invariants
// ---------------------------------------------------------------------------

/** A small deterministic PRNG (mulberry32). */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Act = { do: (fx: FacadeProject, useStream: boolean) => Promise<unknown> };

/** One scripted step chosen by `r`; the same choices for both twins. */
function pickAction(r: () => number, i: number): Act {
  const bots = ['pm', 'art', 'logic', 'audio'];
  const bot = bots[Math.floor(r() * bots.length)]!;
  const x = r();
  const request = async (fx: FacadeProject, useStream: boolean) => {
    const board = await fx.p.board();
    const d = board.workstreams.flatMap(w => w.deliverables).at(-1);
    const y = r();
    if (bot === 'pm' && d && y < 0.15) {
      return useStream
        ? fx.p.buildStream('pm', { maxTokens: MAX, trigger: trig(`review ${i}`), request: { kind: 'review', deliverableId: d.id } })
        : fx.p.buildReviewContext(d.id, { trigger: trig(`review ${i}`) });
    }
    if (bot === 'pm' && y < 0.25) {
      return useStream
        ? fx.p.buildStream('pm', { maxTokens: MAX, trigger: trig(`plan ${i}`), request: { kind: 'planning' } })
        : fx.p.buildPlanningContext({ trigger: trig(`plan ${i}`) });
    }
    return useStream ? fx.p.buildStream(bot, { maxTokens: MAX, trigger: trig(`step ${i}`) }) : fx.p.buildBrief(bot, { maxTokens: MAX, trigger: trig(`step ${i}`) });
  };
  if (x < 0.4) return { do: request };
  if (x < 0.5) return { do: fx => fx.p.ingest({ author: { kind: 'human', id: 'alice' }, text: `human ${i} MARK-H${i}` }) };
  if (x < 0.58) return { do: fx => fx.p.ingest({ author: { kind: 'bot', id: bot }, text: `chat ${i} @pm about art`, mentions: ['pm'], act: 'inform' }) };
  if (x < 0.64) return { do: fx => fx.p.submit(bot, { type: 'notes', text: `note ${i}`, pinned: r() < 0.3 }) };
  if (x < 0.72)
    return {
      do: async fx => {
        await fx.p.submit('pm', { type: 'proposal', ops: [addConvention(`convention ${i} MARK-C${i}`)] });
        await resolveAll(fx);
      },
    };
  if (x < 0.78)
    return {
      do: async fx => {
        const affects = [['art'], ['logic'], ['audio']][i % 3]!;
        await fx.p.submit('pm', { type: 'proposal', ops: [{ op: 'addDecision', decision: { text: `decision ${i}`, rationale: 'why', rejected: [], affects, source: { entryIds: [], by: 'pm' } } }] });
        await resolveAll(fx);
      },
    };
  if (x < 0.83)
    return {
      do: async fx => {
        if (!(await fx.p.board()).contracts.some(c => c.id === 'c1')) return;
        await fx.p.submit('pm', { type: 'proposal', ops: [{ op: 'updateContract', id: 'c1', spec: `spec ${i}` }] });
        await resolveAll(fx);
      },
    };
  if (x < 0.88)
    return {
      do: async fx => {
        const w = (await fx.p.board()).workstreams.find(w => w.owner === 'art' && w.status === 'active');
        if (w) await fx.p.submit('art', { type: 'deliverable', workstreamId: w.id, summary: `v${i}`, content: `content ${i}` });
      },
    };
  if (x < 0.92)
    return {
      do: async fx => {
        const keep = r() < 0.5;
        const contracts = keep ? [{ id: 'c1', from: 'art', to: 'logic', spec: `replanned ${i}` }] : [];
        const { proposalId } = await fx.p.proposePlan({ workstreams: FIXTURE_PLAN.workstreams, contracts }, { by: 'pm' });
        await fx.p.approvePlan(proposalId, { by: 'alice' });
      },
    };
  if (x < 0.97) return { do: (fx, useStream) => (useStream ? fx.p.recordOwnOutput(bot, `own ${i} of ${bot}`) : Promise.resolve()) };
  return { do: fx => fx.p.callTool(bot, 'getBoardItem', { id: 'c1@1' }).catch(() => undefined) };
}

describe('invariants', () => {
  test('side effects equal the existing methods: workspaces, ledger and board after every step', async () => {
    const r1 = rng(7);
    const r2 = rng(7);
    const plain = await makeProject({ approved: true, newId: ids() });
    const streamed = await streamProject({ restreamTokens: 400 });
    for (let i = 0; i < 120; i++) {
      await pickAction(r1, i).do(plain, false);
      await pickAction(r2, i).do(streamed, true);
      for (const bot of ['pm', 'art', 'logic', 'audio']) {
        expect(await streamed.store.getWorkspace('p1', bot), `${bot} @${i}`).toEqual(await plain.store.getWorkspace('p1', bot));
      }
    }
    expect(await streamed.store.read('p1', 1)).toEqual(await plain.store.read('p1', 1));
    expect(await streamed.p.board()).toEqual(await plain.p.board());
  });

  test.each([1, 2, 3])('Focus 1: a long randomized sequence (seed %i): every non-snapshot request extends the previous one byte for byte, and everything project-wide stays visible', async seed => {
    const r = rng(seed);
    const fx = await streamProject({ restreamTokens: 700, snapshotHumanKeep: 6 });
    const prev = new Map<string, string[]>();
    let appends = 0;
    let snapshots = 0;
    for (let i = 0; i < 300; i++) {
      const out = await pickAction(r, i).do(fx, true);
      if (out === undefined || !(out as StreamBundle).segments) continue;
      const b = out as StreamBundle;
      expect(b.segments.every(s => s.cacheable)).toBe(true);
      expect(typeof b.snapshot).toBe('boolean');
      expect(b.segments.at(-1)!.kind).toBe('trigger');
      const t = texts(b);
      // the bot of this request: the one whose stream state ends with exactly these segments
      let owner: string | undefined;
      for (const id of ['pm', 'art', 'logic', 'audio']) {
        const st = await fx.store.getMeta<{ segments: { text: string }[] }>('p1', `stream:${id}`);
        if (st && st.segments.length === t.length && st.segments.every((s, k) => s.text === t[k])) owner = id;
      }
      expect(owner).toBeDefined();
      const p = prev.get(owner!);
      if (b.snapshot) snapshots++;
      else {
        appends++;
        expect(p, `request ${i}`).toBeDefined();
        expect(isPrefix(p!, t), `request ${i} of ${owner}`).toBe(true);
      }
      prev.set(owner!, t);
      // visibility: every current project-wide item and every human message is somewhere in the stream
      const text = t.join('\n');
      const board = await fx.p.board();
      for (const c of board.contracts) expect(text).toContain(`- [${c.id}@v${c.version}] ${c.from} -> ${c.to}: ${c.spec}`);
      for (const c of board.retiredContracts ?? []) expect(text).toContain(`- [${c.id}@v${c.version}] ${c.from} -> ${c.to}: ${c.spec}`);
      for (const c of board.conventions) expect(text).toContain(`- [${c.id}] ${c.text}`);
      for (const d of board.decisions) expect(text).toContain(`- [${d.id}] ${d.text}`);
      for (const w of board.workstreams) expect(text).toContain(`- ${w.id} | ${w.title} | ${w.owner} | ${w.status}`);
      for (const e of await fx.store.read('p1', 1)) {
        if (e.author.kind === 'human' && e.body.type === 'chat') expect(text).toContain(e.body.text);
      }
    }
    expect(appends).toBeGreaterThan(30);
    expect(snapshots).toBeGreaterThan(4);
  });
});

// ---------------------------------------------------------------------------
// persistence
// ---------------------------------------------------------------------------

describe('persistence', () => {
  test('Focus 3: after closing and reopening a SQLite-backed project the next request is a correct append', async () => {
    const file = join(mkdtempSync(join(tmpdir(), 'cc-stream-')), 'db.sqlite');
    const open = async (start: boolean) => {
      const store = sqliteStore(file);
      const employees = createEmployeeRegistry({ store });
      if (start) for (const botId of ['pm', 'art', 'logic', 'audio']) await employees.upsert({ botId, persona: PERSONAS[botId]!, skills: [] });
      const p = createProject({ projectId: 'p1', store, employees, clock: fakeClock(), publicBoard: { directives: false }, stream: { mode: 'on' } });
      return { store, p };
    };
    const a = await open(true);
    await a.p.start({ goal: 'Ship a tiny platformer demo.', constraints: ['Runs in the browser'], lead: 'pm', by: 'alice' });
    const { proposalId } = await a.p.proposePlan(FIXTURE_PLAN, { by: 'pm' });
    await a.p.approvePlan(proposalId, { by: 'alice' });
    await brief(a.p, 'art');
    await a.p.ingest({ author: { kind: 'human', id: 'alice' }, text: 'first MARK-1' });
    const before = await brief(a.p, 'art');
    await a.p.recordOwnOutput('art', 'own MARK-OWN');
    a.p.dispose();
    a.store.close();

    const b = await open(false);
    await b.p.ingest({ author: { kind: 'human', id: 'alice' }, text: 'second MARK-2' });
    const after = await brief(b.p, 'art');
    expect(after.snapshot).toBe(false);
    expect(isPrefix(texts(before), texts(after))).toBe(true);
    const added = after.segments.slice(before.segments.length);
    expect(kinds({ segments: added })).toEqual(['own', 'updates', 'trigger']);
    expect(added[1]!.text).toContain('MARK-2');
    expect(added[1]!.text).not.toContain('MARK-1');
    b.p.dispose();
    b.store.close();
  });
});
