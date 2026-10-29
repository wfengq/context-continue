// End-to-end tests driven through the public API on sqlite stores (Task 15).
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test, vi } from 'vitest';
import { createEmployeeRegistry, createProject, exportMarkdown, exportMemoryMarkdown, sqliteStore } from '../src/index.js';
import type { ContextBundle, EmployeeMemory, LedgerEntry, PlanInput, ProjectModels, SegmentKind, Wake } from '../src/index.js';
import { FIXTURE_PLAN, PERSONAS, fakeClock, makeProject } from './helpers.js';

const pairs = (w: Wake[]) => w.map(x => [x.botId, x.reason]).sort();
const seg = (b: ContextBundle, kind: SegmentKind) => b.segments.find(s => s.kind === kind)!.text;
const tick = () => new Promise<void>(r => setImmediate(r));
const BUDGET = { maxTokens: 20_000 };
const BOTS = ['pm', 'art', 'logic', 'audio'];

describe('full lifecycle', () => {
  test('full lifecycle with sqlite store', async () => {
    const fx = await makeProject({ store: sqliteStore(':memory:') });
    const { p, store, projectId } = fx;

    // start -> plan -> owner rejects -> re-plan -> owner approves
    expect(pairs(await p.start({ goal: 'Ship a tiny platformer demo.', constraints: ['Runs in the browser'], lead: 'pm', by: 'alice' }))).toEqual([
      ['pm', 'needsLead'],
    ]);
    const first = await p.proposePlan(FIXTURE_PLAN, { by: 'pm' });
    expect(pairs(await p.rejectPlan(first.proposalId, { by: 'alice', feedback: 'Split sound out of gameplay.' }))).toEqual([['pm', 'needsLead']]);
    const replanned: PlanInput = {
      ...FIXTURE_PLAN,
      workstreams: FIXTURE_PLAN.workstreams.map(w => (w.id === 'audio' ? { ...w, brief: 'Make the sound, 8-bit style.' } : w)),
    };
    const second = await p.proposePlan(replanned, { by: 'pm' });
    expect(second.proposalId).not.toBe(first.proposalId);
    expect(pairs(await p.approvePlan(second.proposalId, { by: 'alice' }))).toEqual([
      ['art', 'assigned'],
      ['audio', 'assigned'],
    ]);
    expect((await p.board()).planStatus).toBe('approved');

    // art delivers; the check fails and adds a convention
    const delivered = await p.callTool('art', 'submitDeliverable', { workstreamId: 'art', summary: 'sprite sheet', content: 'sprites v1' });
    expect(pairs((delivered as { wakes: Wake[] }).wakes)).toEqual([['pm', 'needsLead']]);
    const art1 = (await p.board()).workstreams.find(w => w.id === 'art')!.deliverables[0]!;
    const failed = (await p.callTool('pm', 'submitReview', {
      deliverableId: art1.id,
      passed: false,
      notes: 'Tiles are not on the 16px grid.',
      conventions: ['All sprites sit on a 16px grid'],
    })) as { wakes: Wake[] };
    expect(failed.wakes.map(w => [w.botId, w.reason])).toEqual([['art', 'reviewFailed']]);
    expect((await p.board()).conventions.map(c => c.text)).toEqual(['All sprites sit on a 16px grid']);
    expect((await p.board()).workstreams.find(w => w.id === 'art')).toMatchObject({ status: 'active', reviewRounds: 1 });

    // art revises and delivers again; the new convention is visible in its next brief; the check passes
    await p.callTool('art', 'submitDeliverable', { workstreamId: 'art', summary: 'sprite sheet v2', content: 'sprites v2' });
    const art2 = (await p.board()).workstreams.find(w => w.id === 'art')!.deliverables.at(-1)!;
    expect(art2.id).not.toBe(art1.id);
    const artBrief = await p.buildBrief('art', { ...BUDGET, trigger: { reason: 'reviewFailed', detail: 'fix the grid' } });
    expect(seg(artBrief, 'board')).toContain('All sprites sit on a 16px grid');
    expect(seg(artBrief, 'trigger')).toContain('reviewFailed');
    const passed = (await p.callTool('pm', 'submitReview', { deliverableId: art2.id, passed: true, notes: 'Looks right.' })) as { wakes: Wake[] };
    expect(pairs(passed.wakes)).toEqual([['logic', 'upstreamDelivered']]);
    expect((await p.board()).workstreams.map(w => [w.id, w.status])).toEqual([
      ['art', 'delivered'],
      ['audio', 'active'],
      ['logic', 'active'],
    ]);

    // logic sees the upstream deliverable by reference, then logic and audio deliver and pass
    const logicBrief = await p.buildBrief('logic', { ...BUDGET, trigger: { reason: 'upstreamDelivered', detail: 'art delivered' } });
    expect(seg(logicBrief, 'projection')).toContain(`art delivered v${art2.version}: sprite sheet v2 (ref: ${art2.ref})`);
    expect(await p.callTool('logic', 'getDeliverable', { ref: art2.ref })).toBe('sprites v2');
    for (const [botId, ws, content] of [['logic', 'logic', 'rules.ts'], ['audio', 'audio', 'theme.ogg']] as const) {
      await p.callTool(botId, 'submitDeliverable', { workstreamId: ws, summary: `${ws} done`, content });
      const d = (await p.board()).workstreams.find(w => w.id === ws)!.deliverables[0]!;
      const r = (await p.callTool('pm', 'submitReview', { deliverableId: d.id, passed: true, notes: 'ok' })) as { wakes: Wake[] };
      expect(r.wakes).toEqual([]);
    }
    expect((await p.board()).workstreams.every(w => w.status === 'delivered')).toBe(true);

    // closing and the retrospective
    await p.close({ by: 'alice' });
    expect((await p.board()).status).toBe('closed');
    const before = new Map(await Promise.all(['art', 'logic', 'audio'].map(async b => [b, (await fx.employees.get(b))!.memories.length] as const)));
    for (const botId of ['art', 'logic', 'audio']) {
      const retro = await p.buildRetroContext(botId);
      expect(seg(retro, 'projection')).toContain('Retrospective');
      await p.commitRetro(botId, [{ text: `${botId}: keep sprites on the grid` }]);
    }
    for (const botId of ['art', 'logic', 'audio']) {
      const m = (await fx.employees.get(botId))!;
      expect(m.memories).toHaveLength(before.get(botId)! + 1);
      expect(m.memories.at(-1)).toMatchObject({ fromProject: projectId, pinned: false });
    }
    expect((await fx.employees.get('pm'))!.memories).toHaveLength(0);

    // the ledger tells the story in order
    const kinds = (await store.read(projectId, 1)).flatMap(e => (e.body.type === 'event' ? [e.body.event.kind] : []));
    expect(kinds.filter(k => k === 'planRejected' || k === 'planApproved' || k === 'projectClosed')).toEqual([
      'planRejected',
      'planApproved',
      'projectClosed',
    ]);
    expect(kinds.filter(k => k === 'reviewFailed')).toHaveLength(1);
    expect(kinds.filter(k => k === 'reviewPassed')).toHaveLength(3);
  });
});

describe('restart', () => {
  const dbFile = () => join(mkdtempSync(join(tmpdir(), 'cc-e2e-')), 'project.sqlite');

  /** Instance B: a fresh createProject over a freshly opened handle of the same file. */
  function reopen(file: string, clock: ReturnType<typeof fakeClock>, extract?: ProjectModels['extract']) {
    const store = sqliteStore(file);
    const employees = createEmployeeRegistry({ store });
    const p = createProject({ projectId: 'p1', store, employees, clock, options: { extractEvery: 2 }, models: extract ? { extract } : undefined });
    return { p, store, employees };
  }

  test('restart: a new createProject on the same sqlite file produces identical briefs and routing', async () => {
    const file = dbFile();
    const clock = fakeClock();
    const extractA = vi.fn(async (_: LedgerEntry[]) => []);
    const storeA = sqliteStore(file);
    const a = await makeProject({ store: storeA, approved: true, options: { extractEvery: 2 }, models: { extract: extractA } });

    // history: a decision, notes, a delivery under review, seen-compaction state, chat
    await a.p.callTool('art', 'proposeDecision', { text: 'Use PNG', rationale: 'Lossless', rejected: ['JPEG'], affects: ['art'] });
    await a.p.callTool('art', 'updateNotes', { text: 'Palette is 8 colours.' });
    await a.p.callTool('art', 'updateNotes', { text: 'Pinned: grid is 16px.', pinned: true });
    await a.p.callTool('art', 'submitDeliverable', { workstreamId: 'art', summary: 'sheet', content: 'sprites' });
    await a.p.buildBrief('art', { ...BUDGET }); // marks items as seen
    await a.p.buildBrief('logic', { ...BUDGET });
    await a.p.callTool('art', 'proposeDecision', { text: 'Add a dark theme', rationale: 'Requested', affects: ['logic'] }); // pending for the lead
    await a.p.callTool('logic', 'sendMessage', { text: 'Tile size confirmed?', act: 'query', mentions: ['art'] });
    await a.p.ingest({ author: { kind: 'human', id: 'alice' }, text: 'The Sprites need more contrast.' });
    await a.p.ingest({ author: { kind: 'human', id: 'alice' }, text: 'Sound should be quieter.' });
    await a.p.flushExtraction();
    expect(extractA).toHaveBeenCalledTimes(1);
    a.clock.advance(200_000);
    const pending = await storeA.listPending('p1');
    expect(pending).toHaveLength(1);
    const lastEntry = await a.p.ingest({ author: { kind: 'human', id: 'alice' }, text: 'Sprites: please use a warmer palette.' });

    const peek = (p: typeof a.p) => Promise.all(BOTS.map(async b => [b, await p.buildBrief(b, { ...BUDGET, peek: true })] as const));
    const briefsA = await peek(a.p);
    const boardA = await a.p.board();
    const routeA = await a.p.route(lastEntry);
    expect(routeA.map(w => w.botId)).toContain('art');
    const progressA = await storeA.getMeta<{ fromSeq: number }>('p1', 'extract');
    a.p.dispose();
    storeA.close();

    // restart on the same file; B's clock continues from A's time
    const extractB = vi.fn(async (_: LedgerEntry[]) => []);
    const b = reopen(file, clock, extractB);
    clock.advance(a.clock.now() - clock.now());
    const needsHuman: { ref: string }[] = [];
    b.p.on('needsHuman', e => needsHuman.push(e));

    const briefsB = await peek(b.p);
    for (const [botId, briefA] of briefsA) {
      const briefB = briefsB.find(x => x[0] === botId)![1];
      expect(briefB.segments.map(s => [s.kind, s.cacheable])).toEqual(briefA.segments.map(s => [s.kind, s.cacheable]));
      for (const sa of briefA.segments) expect(seg(briefB, sa.kind), `${botId} ${sa.kind}`).toBe(sa.text);
      expect(briefB.stats).toEqual(briefA.stats);
    }
    expect(await b.p.route(lastEntry)).toEqual(routeA);
    expect(await b.p.board()).toEqual(boardA);

    // extraction progress survived: only the message after the saved position is extracted, once
    expect(await b.store.getMeta<{ fromSeq: number }>('p1', 'extract')).toEqual(progressA);
    await b.p.flushExtraction();
    expect(extractB).not.toHaveBeenCalled();
    clock.advance(60_000);
    await b.p.flushExtraction();
    expect(extractB).toHaveBeenCalledTimes(1);
    expect(extractB.mock.calls[0]![0].map(e => (e.body.type === 'chat' ? e.body.text : ''))).toEqual(['Sprites: please use a warmer palette.']);

    // the pending lead timeout was re-armed with the time that is left (600_000 - 200_000 - 60_000)
    expect(needsHuman).toEqual([]);
    clock.advance(339_999);
    await tick();
    expect(needsHuman).toEqual([]);
    clock.advance(1);
    await tick();
    expect(needsHuman).toEqual([expect.objectContaining({ ref: pending[0]!.id })]);
    b.p.dispose();
    b.store.close();
  });

  async function withPending(file: string, clock: ReturnType<typeof fakeClock>) {
    const store = sqliteStore(file);
    const employees = createEmployeeRegistry({ store });
    for (const botId of BOTS) await employees.upsert({ botId, persona: PERSONAS[botId]!, skills: [] });
    const p = createProject({ projectId: 'p1', store, employees, clock });
    await p.start({ goal: 'Ship it', constraints: [], lead: 'pm', by: 'alice' });
    const { proposalId } = await p.proposePlan(FIXTURE_PLAN, { by: 'pm' });
    await p.approvePlan(proposalId, { by: 'alice' });
    await p.callTool('art', 'proposeDecision', { text: 'Dark theme', rationale: 'Asked', affects: ['logic'] });
    const [pending] = await store.listPending('p1');
    return { store, p, pendingId: pending!.id };
  }

  test('a lead timeout that is already past when the project restarts fires on the next tick', async () => {
    const file = dbFile();
    const clock = fakeClock();
    const a = await withPending(file, clock);
    a.p.dispose();
    a.store.close();
    clock.advance(700_000);

    const b = reopen(file, clock);
    const seen: string[] = [];
    b.p.on('needsHuman', e => seen.push(e.ref));
    await tick();
    expect(seen).toEqual([]); // not synchronously: it goes through the injected clock
    clock.advance(0);
    await tick();
    expect(seen).toEqual([a.pendingId]);
    b.p.dispose();
    b.store.close();
  });

  test('a restored lead timer does not fire for a pending proposal that was resolved meanwhile', async () => {
    const file = dbFile();
    const clock = fakeClock();
    const a = await withPending(file, clock);
    const b = reopen(file, clock);
    const seen: string[] = [];
    b.p.on('needsHuman', e => seen.push(e.ref));
    await tick();
    expect(clock.pendingTimers()).toBeGreaterThanOrEqual(2); // A's timer and B's restored one
    await a.p.resolveProposal(a.pendingId, { by: 'pm', accept: true }); // resolved by the first instance
    clock.advance(600_000);
    await tick();
    expect(seen).toEqual([]);
    a.p.dispose();
    b.p.dispose();
    a.store.close();
    b.store.close();
  });
});

describe('markdown export', () => {
  test('exportMarkdown contains decisions with rationale and rejected options', async () => {
    const fx = await makeProject({ store: sqliteStore(':memory:'), approved: true });
    const { p } = fx;
    await p.callTool('art', 'proposeDecision', {
      text: 'Use PNG for sprites',
      rationale: 'Lossless and supported everywhere',
      rejected: ['JPEG (lossy)', 'SVG (slow to render)'],
      affects: ['art'],
    });
    await p.callTool('art', 'promote', { kind: 'fact', text: 'Tiles are 16px', affects: ['art'] });
    await p.callTool('art', 'recordFailure', { text: 'Dithering', reason: 'Looks muddy', affects: ['art'] });
    await p.submit('art', { type: 'proposal', ops: [{ op: 'add', section: 'openQuestions', item: { text: 'Which palette?', source: { entryIds: [], by: 'art' } } }] });
    await p.submit('art', { type: 'deliverable', workstreamId: 'art', summary: 'sheet', content: 'sprites' });

    const md = await p.exportMarkdown();
    expect(md).toContain('Use PNG for sprites');
    expect(md).toContain('Lossless and supported everywhere');
    expect(md).toContain('JPEG (lossy)');
    expect(md).toContain('SVG (slow to render)');
    expect(md).toContain('Tiles are 16px');
    expect(md).toContain('Dithering');
    expect(md).toContain('Looks muddy');
    expect(md).toContain('Which palette?');
    expect(md).toContain('PNG sprite sheets, 16x16 tiles');
    expect(md).toContain('Ship a tiny platformer demo.');
    expect(md).toContain('Runs in the browser');
    for (const title of ['Sprites', 'Sound', 'Gameplay']) expect(md).toContain(title);
    expect(md).toContain('sheet');

    // every section, in project board order
    const headings = ['## Goal', '## Constraints', '## Conventions', '## Workstreams', '## Contracts', '## Decisions', '## Facts', '## Failures', '## Open questions'];
    const at = headings.map(h => md.indexOf(h));
    expect(at.every(i => i >= 0)).toBe(true);
    expect([...at].sort((x, y) => x - y)).toEqual(at);

    // deterministic and equal to the function applied to the resolved board
    const board = await p.board();
    expect(exportMarkdown(board, board.workstreams)).toBe(md);
    expect(await p.exportMarkdown()).toBe(md);
  });

  test('an empty board exports every section as empty', async () => {
    const fx = await makeProject();
    await fx.p.start({ goal: 'Ship it', constraints: [], lead: 'pm', by: 'alice' });
    const md = await fx.p.exportMarkdown();
    expect(md).toContain('## Decisions');
    expect(md).toContain('(none)');
  });

  test('memory markdown lists pinned memories, the summary and each memory with its source project', async () => {
    const m: EmployeeMemory = {
      botId: 'art',
      persona: 'Pixel artist\nDraws sprites.',
      skills: ['pixel art', 'palettes'],
      condensed: 'Prefers small palettes; always checks the grid.',
      memories: [
        { id: 'm1', text: 'Keep tiles on the grid', fromProject: 'p1', createdAt: 1_700_000_000_000, pinned: true },
        { id: 'm2', text: 'Ask for the palette early', fromProject: 'p2', createdAt: 1_700_000_100_000, pinned: false },
      ],
    };
    const md = exportMemoryMarkdown(m);
    expect(md).toContain('art');
    expect(md).toContain('Pixel artist');
    expect(md).toContain('pixel art');
    expect(md).toContain('Prefers small palettes; always checks the grid.');
    expect(md).toMatch(/Pinned memories[\s\S]*Keep tiles on the grid[\s\S]*p1/);
    expect(md).toMatch(/Ask for the palette early[\s\S]*p2/);
    expect(md).toContain('m2'); // the id lets a person ask for one memory to be deleted
    expect(md.indexOf('Keep tiles on the grid')).toBeLessThan(md.indexOf('Ask for the palette early'));
    expect(exportMemoryMarkdown(m)).toBe(md);
  });

  test('the registry exports one employee and fails for an unknown bot', async () => {
    const store = sqliteStore(':memory:');
    const employees = createEmployeeRegistry({ store });
    await employees.upsert({ botId: 'art', persona: 'Pixel artist', skills: [] });
    expect(await employees.exportMarkdown('art')).toBe(exportMemoryMarkdown((await employees.get('art'))!));
    await expect(employees.exportMarkdown('ghost')).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('cache-friendliness', () => {
  test('across bots at one board version, the cached segments are identical (cache-friendliness)', async () => {
    const fx = await makeProject({ store: sqliteStore(':memory:'), approved: true });
    const { p } = fx;
    const briefs = await Promise.all(BOTS.map(b => p.buildBrief(b, { ...BUDGET, peek: true })));
    for (const b of briefs) {
      expect(b.segments.slice(0, 3).map(s => [s.kind, s.cacheable])).toEqual([['common', true], ['board', true], ['memory', true]]);
      expect(b.segments.slice(3).every(s => !s.cacheable)).toBe(true);
    }
    // segments 1 and 2 are the same bytes for every member; segment 3 is the bot's own memory
    for (const kind of ['common', 'board'] as const) expect(new Set(briefs.map(b => seg(b, kind))).size).toBe(1);
    expect(new Set(briefs.map(b => seg(b, 'memory'))).size).toBe(BOTS.length);

    // segments 1-3 do not move while the board version stays: notes, reads and triggers only touch later segments
    const art = briefs[1]!;
    await p.callTool('art', 'updateNotes', { text: 'a private note' });
    await p.ingest({ author: { kind: 'human', id: 'alice' }, text: 'Hello team' });
    const again = await p.buildBrief('art', { ...BUDGET, trigger: { reason: 'mentioned', detail: 'hi' } });
    for (const kind of ['common', 'board', 'memory'] as const) expect(seg(again, kind)).toBe(seg(art, kind));
  });
});

describe('lead timer robustness', () => {
  async function started(store: ReturnType<typeof sqliteStore>, clock: ReturnType<typeof fakeClock>) {
    const employees = createEmployeeRegistry({ store });
    for (const botId of BOTS) await employees.upsert({ botId, persona: PERSONAS[botId]!, skills: [] });
    const p = createProject({ projectId: 'p1', store, employees, clock });
    await p.start({ goal: 'Ship it', constraints: [], lead: 'pm', by: 'alice' });
    const { proposalId } = await p.proposePlan(FIXTURE_PLAN, { by: 'pm' });
    await p.approvePlan(proposalId, { by: 'alice' });
    await p.callTool('art', 'proposeDecision', { text: 'Dark theme', rationale: 'Asked', affects: ['logic'] });
    return p;
  }

  test('dispose during the restore read arms no timers', async () => {
    const store = sqliteStore(':memory:');
    const clock = fakeClock();
    (await started(store, clock)).dispose();
    const real = store.listPending.bind(store);
    let release!: () => void;
    const gate = new Promise<void>(r => (release = r));
    store.listPending = async id => {
      await gate;
      return real(id);
    };
    const employees = createEmployeeRegistry({ store });
    const p = createProject({ projectId: 'p1', store, employees, clock });
    await tick();
    p.dispose();
    release();
    await tick();
    expect(clock.pendingTimers()).toBe(0);
  });

  test('a store error when the timer fires still escalates', async () => {
    const store = sqliteStore(':memory:');
    const clock = fakeClock();
    const p = await started(store, clock);
    const seen: string[] = [];
    p.on('needsHuman', e => seen.push(e.ref));
    const [pending] = await store.listPending('p1');
    store.listPending = async () => {
      throw new Error('disk gone');
    };
    clock.advance(600_000);
    await tick();
    expect(seen).toEqual([pending!.id]);
    p.dispose();
  });

  test('a store error during restore emits needsHuman with ref restore', async () => {
    const store = sqliteStore(':memory:');
    const clock = fakeClock();
    (await started(store, clock)).dispose();
    store.listPending = async () => {
      throw new Error('disk gone');
    };
    const p = createProject({ projectId: 'p1', store, employees: createEmployeeRegistry({ store }), clock });
    const seen: { ref: string; reason: string }[] = [];
    p.on('needsHuman', e => seen.push(e));
    await tick();
    expect(seen).toEqual([expect.objectContaining({ ref: 'restore', reason: expect.stringContaining('disk gone') })]);
    p.dispose();
  });
});
