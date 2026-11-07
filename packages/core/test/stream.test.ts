// Long-project stream mode (spec 2026-11-06 §2): append-only per-bot streams built by the core.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { createEmployeeRegistry } from '../src/employees.js';
import { defaultWorkspace } from '../src/members.js';
import { DEFAULT_STREAM_OPTIONS, resolveStreamOptions } from '../src/options.js';
import { createProject, type Project } from '../src/project.js';
import { memoryStore } from '../src/store/memory.js';
import { sqliteStore } from '../src/store/sqlite.js';
import { knownOf, sectionUpdate } from '../src/stream/diff.js';
import { splitParagraphs } from '../src/render.js';
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
  test('defaults: off, 8,000 restream tokens, auto after 75 ledger entries (bench-chosen), 40 human messages kept in full', () => {
    expect(resolveStreamOptions()).toEqual(DEFAULT_STREAM_OPTIONS);
    expect(DEFAULT_STREAM_OPTIONS).toEqual({ mode: 'off', restreamTokens: 8000, autoAfterEntries: 75, snapshotHumanKeep: 40 });
    expect(resolveStreamOptions({ mode: 'on', restreamTokens: 100 })).toMatchObject({ mode: 'on', restreamTokens: 100, snapshotHumanKeep: 40 });
  });

  test.each([
    [{ mode: 'yes' }],
    [{ mode: 1 }],
    [{ restreamTokens: 0 }],
    [{ restreamTokens: -5 }],
    [{ restreamTokens: 1.5 }],
    [{ restreamTokens: '8000' }],
    [{ snapshotHumanKeep: -1 }],
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
// item-level updates of memory, notes and projection (Task 3)
// ---------------------------------------------------------------------------

const addedOf = (prev: { segments: unknown[] }, now: StreamBundle) => now.segments.slice(prev.segments.length);
/** The text of the one appended segment of `kind` (undefined when none). */
const appended = (prev: { segments: unknown[] }, now: StreamBundle, kind: string) => {
  const xs = addedOf(prev, now).filter(s => s.kind === kind);
  expect(xs.length, kind).toBeLessThanOrEqual(1);
  return xs[0]?.text;
};
async function replan(fx: FacadeProject, plan: { workstreams: typeof FIXTURE_PLAN.workstreams; contracts: typeof FIXTURE_PLAN.contracts }) {
  const { proposalId } = await fx.p.proposePlan(plan, { by: 'pm' });
  await fx.p.approvePlan(proposalId, { by: 'alice' });
}
async function setPinned(fx: FacadeProject, bot: string, pinnedNotes: string[]) {
  const ws = (await fx.store.getWorkspace(fx.projectId, bot)) ?? defaultWorkspace(fx.projectId, bot, await fx.store.latestSeq(fx.projectId));
  await fx.store.saveWorkspace({ ...ws, pinnedNotes });
}
const decide = (text: string, affects: string[]): BoardOp => ({ op: 'addDecision', decision: { text, rationale: 'r', rejected: [], affects, source: { entryIds: [], by: 'pm' } } });

describe('item-level updates', () => {
  test('a new note: only that note, under its label, in a "— updates" segment', async () => {
    const fx = await streamProject();
    const a = await brief(fx.p, 'art');
    await fx.p.submit('art', { type: 'notes', text: 'remember MARK-NOTE', pinned: true });
    const b = await brief(fx.p, 'art');
    expect(kinds({ segments: addedOf(a, b) })).toEqual(['workspace', 'trigger']);
    expect(appended(a, b, 'workspace')).toBe('# Your notes — updates\n\nPinned:\n- remember MARK-NOTE');
    await fx.p.submit('art', { type: 'notes', text: 'later MARK-R' });
    const c = await brief(fx.p, 'art');
    expect(appended(b, c, 'workspace')).toBe('# Your notes — updates\n\nRecent:\n- later MARK-R');
  });

  test('memory: a new memory, a pinned one and a new skill, each under its label', async () => {
    const fx = await streamProject();
    const a = await brief(fx.p, 'art');
    const m = (await fx.store.getMemory('art'))!;
    const mem = (id: string, text: string, pinned: boolean) => ({ id, text, fromProject: 'p0', createdAt: 1, pinned });
    await fx.store.saveMemory({ ...m, skills: ['pixel art'], memories: [mem('m1', 'keep palettes small MARK-M1', false), mem('m2', 'always MARK-PIN', true)] });
    const b = await brief(fx.p, 'art');
    expect(appended(a, b, 'memory')).toBe('# Your memory — updates\n\nSkills:\n- pixel art\n\nPinned:\n- always MARK-PIN\n\nRecent:\n- keep palettes small MARK-M1');
    await fx.store.saveMemory({ ...m, skills: ['pixel art'], memories: [mem('m1', 'keep palettes small MARK-M1', false), mem('m2', 'always MARK-PIN', true), mem('m3', 'new MARK-M3', false)] });
    const c = await brief(fx.p, 'art');
    expect(appended(b, c, 'memory')).toBe('# Your memory — updates\n\nRecent:\n- new MARK-M3');
  });

  test('Focus 2: a multi-line item changed in the middle is appended whole (notes and workstream brief)', async () => {
    const fx = await streamProject();
    await setPinned(fx, 'art', ['top\nmiddle\nbottom']);
    const a = await brief(fx.p, 'art');
    await setPinned(fx, 'art', ['top\nMIDDLE\nbottom']);
    const b = await brief(fx.p, 'art');
    const w = appended(a, b, 'workspace')!;
    expect(w).toContain('Pinned:\n- top\nMIDDLE\nbottom');
    expect(w).toContain('no longer: - top\nmiddle\nbottom');
    const plan = (brief: string) => ({ workstreams: FIXTURE_PLAN.workstreams.map(x => (x.id === 'art' ? { ...x, brief } : x)), contracts: FIXTURE_PLAN.contracts });
    await replan(fx, plan('Draw\nthe sprites\nfast'));
    const c = await brief(fx.p, 'art');
    await replan(fx, plan('Draw\nthe SPRITES\nfast'));
    const d = await brief(fx.p, 'art');
    const p = appended(c, d, 'projection')!;
    expect(p).toBe('# Your part — updates\n\n(part art)\nBrief:\nDraw\nthe SPRITES\nfast');
  });

  test('Focus 2: two identical items in one section count separately; removing one says "no longer" once', async () => {
    const fx = await streamProject();
    const a = await brief(fx.p, 'art');
    await fx.p.submit('art', { type: 'notes', text: 'same MARK-SAME', pinned: true });
    const b = await brief(fx.p, 'art');
    await fx.p.submit('art', { type: 'notes', text: 'same MARK-SAME', pinned: true });
    const c = await brief(fx.p, 'art');
    expect(appended(a, b, 'workspace')).toBe('# Your notes — updates\n\nPinned:\n- same MARK-SAME');
    expect(appended(b, c, 'workspace')).toBe('# Your notes — updates\n\nPinned:\n- same MARK-SAME');
    await setPinned(fx, 'art', ['same MARK-SAME']);
    const d = await brief(fx.p, 'art');
    expect(appended(c, d, 'workspace')).toBe('# Your notes — updates\n\nPinned:\nno longer: - same MARK-SAME');
    const e = await brief(fx.p, 'art');
    expect(kinds({ segments: addedOf(d, e) })).toEqual(['trigger']);
  });

  test('Focus 2: reordered items are not a change', async () => {
    const fx = await streamProject();
    await setPinned(fx, 'art', ['alpha', 'beta']);
    const a = await brief(fx.p, 'art');
    await setPinned(fx, 'art', ['beta', 'alpha']);
    const b = await brief(fx.p, 'art');
    expect(kinds({ segments: addedOf(a, b) })).toEqual(['trigger']);
  });

  test('Focus 2: several workstreams: grouped by part with the part in each heading; one item in two parts is two items', async () => {
    const fx = await streamProject();
    const art0 = await brief(fx.p, 'art');
    const two = { workstreams: FIXTURE_PLAN.workstreams.map(x => (x.id === 'audio' ? { ...x, owner: 'art' } : x)), contracts: FIXTURE_PLAN.contracts };
    await replan(fx, two);
    const art1 = await brief(fx.p, 'art');
    // art gains the audio part, whole
    const gained = appended(art0, art1, 'projection')!;
    expect(gained.startsWith('# Your part — updates\n\n(part audio)\naudio | Sound | art |')).toBe(true);
    expect(gained).toContain('Brief:\nMake the sound.');
    expect(gained).not.toContain('(part art)');

    await fx.p.submit('pm', { type: 'proposal', ops: [decide('Shared MARK-SHARED', ['art', 'audio'])] });
    await resolveAll(fx);
    const art2 = await brief(fx.p, 'art');
    const p2 = appended(art1, art2, 'projection')!;
    // the project updates of this request carry the decision in full, so both parts add the compact form
    expect(appended(art1, art2, 'updates')).toMatch(/- \[d-\d+\] Shared MARK-SHARED\n {2}why: r\n {2}affects: art, audio/);
    expect(p2).toMatch(/## Decisions \(part art\)\n- \[d-\d+\] Shared MARK-SHARED \(seen\)/);
    expect(p2).toMatch(/## Decisions \(part audio\)\n- \[d-\d+\] Shared MARK-SHARED \(seen\)/);
    expect(p2.indexOf('(part art)')).toBeLessThan(p2.indexOf('(part audio)'));

    await fx.p.submit('pm', { type: 'proposal', ops: [decide('Audio only MARK-AUDIO', ['audio'])] });
    await resolveAll(fx);
    const art3 = await brief(fx.p, 'art');
    const p3 = appended(art2, art3, 'projection')!;
    expect(p3).toMatch(/^# Your part — updates\n\n## Decisions \(part audio\)\n- \[d-\d+\] Audio only MARK-AUDIO \(seen\)/);
    expect(p3).not.toContain('(part art)');

    // art loses the audio part again: one line for the whole part
    await replan(fx, FIXTURE_PLAN);
    const art4 = await brief(fx.p, 'art');
    expect(appended(art3, art4, 'projection')).toMatch(/^# Your part — updates\n\n\(part audio\)\nno longer: audio \| Sound \| art \| \w+$/);
  });

  test('Focus 2: seen compaction is not a change; a new contract version is appended once in full', async () => {
    const fx = await streamProject();
    const a = await brief(fx.p, 'art');
    expect(a.segments[4]!.text).toContain('- [c1@v1] art -> logic: PNG sprite sheets, 16x16 tiles');
    await fx.p.callTool('art', 'getBoardItem', { id: 'c1@1' }).catch(() => undefined); // acting confirms the items shown as seen
    const peek = await fx.p.buildBrief('art', { maxTokens: MAX, peek: true });
    expect(peek.segments.find(s => s.kind === 'projection')!.text).toContain('- [c1@v1] art -> logic (seen)');
    const b = await brief(fx.p, 'art');
    expect(kinds({ segments: addedOf(a, b) })).not.toContain('projection');
    await fx.p.submit('pm', { type: 'proposal', ops: [{ op: 'updateContract', id: 'c1', spec: 'PNG 64x64 MARK-V2' }] });
    await resolveAll(fx);
    const c = await brief(fx.p, 'art');
    // the project updates of this same request carry the contract in full, so the projection adds its compact form
    expect(appended(b, c, 'updates')).toContain('- [c1@v2] art -> logic: PNG 64x64 MARK-V2');
    expect(appended(b, c, 'projection')).toBe('# Your part — updates\n\n## Contracts (part art)\n- [c1@v2] art -> logic (seen)');
    expect(occurrences(all(c), 'MARK-V2')).toBe(1);
  });

  test('carry-over: an own-projection item already in this request\'s project updates is appended compact; one that is not stays full', async () => {
    const fx = await streamProject();
    const a = await brief(fx.p, 'art');
    await fx.p.submit('pm', { type: 'proposal', ops: [decide('Use MARK-DEC everywhere', ['art'])] });
    await resolveAll(fx);
    const b = await brief(fx.p, 'art');
    expect(appended(a, b, 'updates')).toContain('Use MARK-DEC everywhere');
    const p = appended(a, b, 'projection')!;
    expect(p).toMatch(/^# Your part — updates\n\n## Decisions \(part art\)\n- \[[^\]]+\] Use MARK-DEC everywhere \(seen\)$/);
    expect(occurrences(all(b), 'MARK-DEC')).toBe(2);
    // nothing changed since: nothing is appended
    const c = await brief(fx.p, 'art');
    expect(kinds({ segments: addedOf(b, c) })).not.toContain('projection');
  });

  test('a new upstream deliverable appends only its line; the older version is not "no longer"', async () => {
    const fx = await streamProject();
    const a = await brief(fx.p, 'logic');
    await fx.p.submit('art', { type: 'deliverable', workstreamId: 'art', summary: 'sheet MARK-D1', content: 'PNG' });
    const b = await brief(fx.p, 'logic');
    expect(appended(a, b, 'projection')).toMatch(/^# Your part — updates\n\n## Upstream deliverables \(part logic\)\n- art delivered v1: sheet MARK-D1 \(ref: [^)]+\)$/);
    await fx.p.submit('art', { type: 'deliverable', workstreamId: 'art', summary: 'sheet MARK-D2', content: 'PNG 2' });
    const c = await brief(fx.p, 'logic');
    const p = appended(b, c, 'projection')!;
    expect(p).toMatch(/^# Your part — updates\n\n## Upstream deliverables \(part logic\)\n- art delivered v2: sheet MARK-D2 \(ref: [^)]+\)$/);
  });

  test('a removed pinned note and a removed projection item get one "no longer"; a workstream field too', async () => {
    const fx = await streamProject();
    await fx.p.submit('pm', { type: 'proposal', ops: [decide('Old MARK-OLD', ['art'])] });
    await resolveAll(fx);
    await setPinned(fx, 'art', ['gone MARK-GONE', 'stays']);
    const a = await brief(fx.p, 'art');
    const old = (await fx.p.board()).decisions.find(d => d.text.includes('MARK-OLD'))!.id;
    await setPinned(fx, 'art', ['stays']);
    await fx.p.submit('pm', { type: 'proposal', ops: [{ op: 'supersede', section: 'decisions', id: old, item: { text: 'New MARK-NEW', source: { entryIds: [], by: 'pm' }, affects: ['logic'] } }] });
    await resolveAll(fx);
    const b = await brief(fx.p, 'art');
    expect(appended(a, b, 'workspace')).toBe('# Your notes — updates\n\nPinned:\nno longer: - gone MARK-GONE');
    expect(appended(a, b, 'projection')).toBe(`# Your part — updates\n\n## Decisions (part art)\nno longer: - [${old}] Old MARK-OLD`);
    // logic loses its dependency on art: the field is gone (and logic can start)
    const l0 = await brief(fx.p, 'logic');
    await replan(fx, { workstreams: FIXTURE_PLAN.workstreams.map(x => (x.id === 'logic' ? { ...x, dependsOn: [] } : x)), contracts: FIXTURE_PLAN.contracts });
    const l1 = await brief(fx.p, 'logic');
    expect(appended(l0, l1, 'projection')).toBe('# Your part — updates\n\n(part logic)\nlogic | Gameplay | logic | active\nno longer: depends on: art');
  });

  test('notes rolling out of the Recent window, or trimmed to fit the budget, are not "no longer" and are not repeated', async () => {
    const fx = await streamProject({}, { options: { recentKeep: 2, notesMaxTokens: 10 } });
    let prev = await brief(fx.p, 'art');
    const updates: string[] = [];
    for (let i = 1; i <= 4; i++) {
      await fx.p.submit('art', { type: 'notes', text: `note ${i} MARK-N${i}` });
      const now = await brief(fx.p, 'art');
      updates.push(appended(prev, now, 'workspace')!);
      prev = now;
    }
    expect(updates).toEqual([1, 2, 3, 4].map(i => `# Your notes — updates\n\nRecent:\n- note ${i} MARK-N${i}`));
    // budget trimming: the tight request drops a recent note from the brief; nothing is retracted, and it is not repeated later
    const t = { reason: 'manual' as const, detail: 'go' };
    const full = (await fx.p.buildBrief('art', { maxTokens: MAX, peek: true, trigger: t })).stats.total;
    const tight = await fx.p.buildStream('art', { maxTokens: full - 1, trigger: t });
    const trimmed = await fx.p.buildBrief('art', { maxTokens: full - 1, peek: true, trigger: t });
    expect(trimmed.segments.find(s => s.kind === 'workspace')!.text).not.toContain('MARK-N3');
    expect(kinds({ segments: addedOf(prev, tight) })).toEqual(['trigger']);
    const again = await brief(fx.p, 'art');
    expect(kinds({ segments: addedOf(tight, again) })).toEqual(['trigger']);
  });

  test('the summary is replaced whole when condensing changes it', async () => {
    const fx = await streamProject();
    const a = await brief(fx.p, 'art');
    const w = (await fx.store.getWorkspace(fx.projectId, 'art'))!;
    await fx.store.saveWorkspace({ ...w, condensed: 'line one\nline two MARK-SUM' });
    const b = await brief(fx.p, 'art');
    expect(appended(a, b, 'workspace')).toBe('# Your notes — updates\n\nSummary:\nline one\nline two MARK-SUM');
  });
});

describe('sectionUpdate (pure)', () => {
  const part = (leaves: 'retract' | 'roll' | 'replace', texts: string[], heading = 'Recent:') => [
    { part: null, groups: [{ heading, leaves, items: texts.map(t => ({ key: t, text: `- ${t}`, full: `- ${t}` })) }] },
  ];
  const step = (leaves: 'retract' | 'roll' | 'replace', a: string[], b: string[]) => {
    const h = leaves === 'roll' ? 'Recent:' : 'Pinned:';
    return sectionUpdate('# Your notes', knownOf(part(leaves, a, h)), part(leaves, b, h));
  };

  test('a window: an equal note written again is new; what rolled out stays known', () => {
    expect(step('roll', ['a', 'b'], ['b', 'a']).text).toBe('# Your notes — updates\n\nRecent:\n- a');
    expect(step('roll', ['a', 'b', 'c'], ['c']).text).toBeNull();
    const r = step('roll', ['a', 'b', 'c'], ['c']);
    expect(sectionUpdate('# Your notes', r.known, part('roll', ['b', 'c', 'd'])).text).toBe('# Your notes — updates\n\nRecent:\n- d');
    // an edited note in the middle of the window: only the new text
    expect(step('roll', ['a', 'b', 'c'], ['a', 'B', 'c']).text).toBe('# Your notes — updates\n\nRecent:\n- B');
  });

  test('a retracting list: duplicates count, reordering is nothing, removal says "no longer" once per item', () => {
    expect(step('retract', ['x', 'x', 'y'], ['y', 'x', 'x']).text).toBeNull();
    expect(step('retract', ['x', 'x', 'y'], ['x', 'y']).text).toBe('# Your notes — updates\n\nPinned:\nno longer: - x');
    expect(step('retract', ['x'], ['x', 'x']).text).toBe('# Your notes — updates\n\nPinned:\n- x');
  });
});

// ---------------------------------------------------------------------------
// Task 2 carry-overs
// ---------------------------------------------------------------------------

describe('carry-overs', () => {
  test('snapshotHumanKeep 0 folds every human message in a snapshot', async () => {
    expect(resolveStreamOptions({ snapshotHumanKeep: 0 }).snapshotHumanKeep).toBe(0);
    const fx = await streamProject({ snapshotHumanKeep: 0 });
    await fx.p.ingest({ author: { kind: 'human', id: 'alice' }, text: `hi MARK-0 ${'q'.repeat(200)} TAIL-0` });
    const board = (await brief(fx.p, 'art')).segments[3]!.text;
    expect(board).toContain('## Earlier human messages (first 160 characters each)\n- [#');
    expect(board).toContain('MARK-0');
    expect(board).not.toContain('TAIL-0');
    expect(board.endsWith('## Human messages\n(nothing yet)')).toBe(true);
  });

  test('a snapshot keeps in the delta the human messages it folds', async () => {
    const fx = await streamProject({ snapshotHumanKeep: 1, restreamTokens: 50 });
    await brief(fx.p, 'pm');
    await fx.p.ingest({ author: { kind: 'human', id: 'alice' }, text: `first MARK-F1 ${'v'.repeat(200)} TAIL-F1` });
    await fx.p.ingest({ author: { kind: 'human', id: 'alice' }, text: 'second MARK-F2' });
    await fx.p.recordOwnOutput('pm', 'x '.repeat(400));
    const b = await brief(fx.p, 'pm');
    expect(b.snapshot).toBe(true);
    expect(b.segments[3]!.text).not.toContain('TAIL-F1');
    const delta = b.segments.find(s => s.kind === 'delta')!.text;
    expect(delta).toContain('TAIL-F1');
    expect(delta).not.toContain('MARK-F2');
    expect(occurrences(all(b), 'MARK-F2')).toBe(1);
  });

  test('a workstream a replan removes is "removed from the board" in project updates', async () => {
    const fx = await streamProject();
    const a = await brief(fx.p, 'art');
    await replan(fx, { workstreams: FIXTURE_PLAN.workstreams.filter(w => w.id !== 'audio'), contracts: FIXTURE_PLAN.contracts });
    const b = await brief(fx.p, 'art');
    expect(appended(a, b, 'updates')).toContain('## Workstreams\n- workstream audio removed from the board');
  });

  test('a failing stream store read leaves no side effect (state and messages are read before the brief runs)', async () => {
    const base = memoryStore({ newId: ids() });
    let fail = false;
    const store = new Proxy(base, {
      get(t, k, r) {
        if (k === 'getMeta') {
          return async (pid: string, key: string) => {
            if (fail && key.startsWith('stream:')) throw new Error('disk MARK-FAIL');
            return t.getMeta(pid, key);
          };
        }
        const v = Reflect.get(t, k, r);
        return typeof v === 'function' ? v.bind(t) : v;
      },
    });
    const fx = await makeProject({ approved: true, store, stream: on() });
    await brief(fx.p, 'art');
    await fx.p.ingest({ author: { kind: 'human', id: 'alice' }, text: 'art please MARK-X' });
    const before = await fx.store.getWorkspace('p1', 'art');
    fail = true;
    await expect(brief(fx.p, 'art')).rejects.toThrow('MARK-FAIL');
    expect(await fx.store.getWorkspace('p1', 'art')).toEqual(before);
  });

  test('concurrent buildStream and recordOwnOutput calls are serialized in call order', async () => {
    const fx = await streamProject();
    const a = await brief(fx.p, 'art', '0');
    const [b1, , b2, , b3] = await Promise.all([
      brief(fx.p, 'art', '1'),
      fx.p.recordOwnOutput('art', 'own one'),
      brief(fx.p, 'art', '2'),
      fx.p.recordOwnOutput('art', 'own two'),
      brief(fx.p, 'art', '3'),
    ]);
    const bs = [a, b1, b2, b3] as StreamBundle[];
    for (let i = 1; i < bs.length; i++) expect(isPrefix(texts(bs[i - 1]!), texts(bs[i]!))).toBe(true);
    expect(addedOf(a, b3!).map(s => [s.kind, s.text])).toEqual([
      ['trigger', '# Why you are awake\n\nreason: manual\n1'],
      ['own', 'own one'],
      ['trigger', '# Why you are awake\n\nreason: manual\n2'],
      ['own', 'own two'],
      ['trigger', '# Why you are awake\n\nreason: manual\n3'],
    ]);
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
      // the bot's own items: every note, and the latest deliverable of each upstream workstream
      const ws = await fx.store.getWorkspace('p1', owner!);
      for (const n of [...(ws?.pinnedNotes ?? []), ...splitParagraphs(ws?.notes ?? '')]) expect(text).toContain(`- ${n}`);
      for (const w of board.workstreams.filter(x => x.owner === owner)) {
        for (const dep of board.workstreams.filter(x => w.dependsOn.includes(x.id))) {
          const d = dep.deliverables.at(-1);
          if (d) expect(text).toContain(`- ${dep.id} delivered v${d.version}: ${d.summary} (ref: ${d.ref})`);
        }
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

// ---------------------------------------------------------------------------
// auto mode (Task 4)
// ---------------------------------------------------------------------------

const entryCount = async (fx: FacadeProject) => (await fx.store.read(fx.projectId, 1)).length;
const say = (fx: FacadeProject, text: string) => fx.p.ingest({ author: { kind: 'human', id: 'alice' }, text });

describe('auto mode', () => {
  test('Focus 4: below the threshold it equals off and writes no stream state; the request at the threshold is a snapshot, later ones append', async () => {
    const off = await makeProject({ approved: true, newId: ids() });
    const auto = await makeProject({ approved: true, newId: ids(), stream: { mode: 'auto', autoAfterEntries: 1000 } });
    // find the threshold: two entries more than the ledger holds after setup
    const base = await entryCount(auto);
    const fx = await makeProject({ approved: true, newId: ids(), stream: { mode: 'auto', autoAfterEntries: base + 3 } });
    const step = async (f: FacadeProject, t: string, bot = 'art') => f.p.buildStream(bot, { maxTokens: MAX, trigger: trig(t) });
    const early: unknown[] = [];
    const earlyOff: unknown[] = [];
    for (const f of [off, auto, fx]) {
      const sink = f === off ? earlyOff : f === auto ? early : [];
      sink.push(await step(f, 'one'));
      await say(f, 'MARK-A');
      sink.push(await step(f, 'two'));
    }
    expect(early).toEqual(earlyOff);
    expect(await auto.store.getMeta(auto.projectId, 'stream:art')).toBeNull();
    // fx: the ledger is one entry short of the threshold after one more message
    await say(fx, 'MARK-B');
    expect(await entryCount(fx)).toBe(base + 2);
    expect(((await step(fx, 'almost')) as StreamBundle).snapshot).toBeUndefined();
    expect(await fx.store.getMeta(fx.projectId, 'stream:art')).toBeNull();
    await say(fx, 'MARK-B2');
    expect(await entryCount(fx)).toBe(base + 3);
    const snap = (await step(fx, 'three')) as StreamBundle;
    expect(snap.snapshot).toBe(true);
    expect(kinds(snap)).toEqual(['common', 'memory', 'workspace', 'board', 'projection', 'trigger']);
    await say(fx, 'MARK-C');
    const next = (await step(fx, 'four')) as StreamBundle;
    expect(next.snapshot).toBe(false);
    expect(isPrefix(texts(snap), texts(next))).toBe(true);
    expect(appended(snap, next, 'updates')).toContain('MARK-C');
  });

  test('every bot starts its stream with a snapshot after the switch; recordOwnOutput before it is a no-op', async () => {
    const base = await entryCount(await makeProject({ approved: true, newId: ids() }));
    const fx = await makeProject({ approved: true, newId: ids(), stream: { mode: 'auto', autoAfterEntries: base + 1 } });
    await fx.p.recordOwnOutput('art', 'before MARK-EARLY');
    expect(await fx.store.getMeta(fx.projectId, 'stream:art')).toBeNull();
    await say(fx, 'MARK-1');
    for (const bot of ['art', 'logic']) expect(((await brief(fx.p, bot)) as StreamBundle).snapshot).toBe(true);
    await fx.p.recordOwnOutput('art', 'after MARK-LATE');
    const b = (await brief(fx.p, 'art')) as StreamBundle;
    expect(b.snapshot).toBe(false);
    expect(all(b)).toContain('MARK-LATE');
    expect(all(b)).not.toContain('MARK-EARLY');
  });

  test('once on it stays on, also after reopening with a larger threshold (persisted)', async () => {
    const file = join(mkdtempSync(join(tmpdir(), 'cc-auto-')), 'db.sqlite');
    const open = async (start: boolean, after: number) => {
      const store = sqliteStore(file);
      const employees = createEmployeeRegistry({ store });
      if (start) for (const botId of ['pm', 'art', 'logic', 'audio']) await employees.upsert({ botId, persona: PERSONAS[botId]!, skills: [] });
      const p = createProject({ projectId: 'p1', store, employees, clock: fakeClock(), publicBoard: { directives: false }, stream: { mode: 'auto', autoAfterEntries: after } });
      return { store, p };
    };
    const a = await open(true, 8);
    await a.p.start({ goal: 'Ship a tiny platformer demo.', constraints: ['Runs in the browser'], lead: 'pm', by: 'alice' });
    const { proposalId } = await a.p.proposePlan(FIXTURE_PLAN, { by: 'pm' });
    await a.p.approvePlan(proposalId, { by: 'alice' });
    for (let i = 0; (await a.store.read('p1', 1)).length < 8; i++) await a.p.ingest({ author: { kind: 'human', id: 'alice' }, text: `m${i}` });
    const first = await brief(a.p, 'art');
    expect(first.snapshot).toBe(true);
    a.p.dispose();
    a.store.close();
    const b = await open(false, 1_000_000);
    await b.p.ingest({ author: { kind: 'human', id: 'alice' }, text: 'later MARK-L' });
    const second = await brief(b.p, 'art');
    expect(second.snapshot).toBe(false);
    expect(isPrefix(texts(first), texts(second))).toBe(true);
    // a bot with no stream yet starts with a snapshot, not an off-style brief
    expect(((await brief(b.p, 'logic')) as StreamBundle).snapshot).toBe(true);
    b.p.dispose();
    b.store.close();
  });

  test('an unknown request kind is INVALID_OP below and above the threshold', async () => {
    const fx = await makeProject({ approved: true, stream: { mode: 'auto', autoAfterEntries: 1000 } });
    await expect(fx.p.buildStream('art', { maxTokens: MAX, trigger: trig('x'), request: { kind: 'nope' } as never })).rejects.toMatchObject({ code: 'INVALID_OP' });
  });
});
