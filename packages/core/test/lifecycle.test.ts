import { describe, expect, test, vi } from 'vitest';
import { ContextError } from '../src/errors.js';
import { createEventBus } from '../src/events.js';
import { memoryStore } from '../src/store/memory.js';
import type { RouteInput } from '../src/route.js';
import type { Store } from '../src/store/store.js';
import type { BoardOp, ContextBundle, SegmentKind, Wake, Workstream } from '../src/types.js';
import type { WorkstreamSource } from '../src/workstreams/source.js';
import { withRetry } from '../src/project.js';
import { FIXTURE_PLAN, makeProject, type FacadeProject } from './helpers.js';

const pairs = (w: Wake[]) => w.map(x => [x.botId, x.reason]).sort();
const seg = (b: ContextBundle, kind: SegmentKind) => b.segments.find(s => s.kind === kind)?.text;

async function startOnly(opts: Parameters<typeof makeProject>[0] = {}) {
  const fx = await makeProject(opts);
  await fx.p.start({ goal: 'Ship a tiny platformer demo.', constraints: ['Runs in the browser'], lead: 'pm', by: 'alice' });
  return fx;
}

/** art submits a deliverable; returns its id. */
async function deliverArt(fx: FacadeProject, content = 'sprites.png'): Promise<{ id: string; wakes: Wake[] }> {
  const wakes = await fx.p.submit('art', { type: 'deliverable', workstreamId: 'art', summary: 'sprite sheet', content });
  const art = (await fx.p.board()).workstreams.find(w => w.id === 'art')!;
  return { id: art.deliverables.at(-1)!.id, wakes };
}

const fact = (affects: string[]): BoardOp => ({
  op: 'addFact',
  fact: { text: 'Tiles are 16px', affects, source: { entryIds: [], by: 'art' } },
});

describe('events', () => {
  test('the bus delivers typed events and unsubscribes', () => {
    const bus = createEventBus();
    const seen: number[] = [];
    const off = bus.on('boardChanged', e => seen.push(e.version));
    bus.emit('boardChanged', { version: 1 });
    off();
    bus.emit('boardChanged', { version: 2 });
    expect(seen).toEqual([1]);
  });

  test('a throwing handler does not stop other handlers', () => {
    const bus = createEventBus();
    const seen: string[] = [];
    bus.on('needsHuman', () => {
      throw new Error('boom');
    });
    bus.on('needsHuman', e => seen.push(e.ref));
    bus.emit('needsHuman', { reason: 'r', ref: 'x' });
    expect(seen).toEqual(['x']);
  });
});

describe('start and planning', () => {
  test('start wakes the lead and creates the board with owner', async () => {
    const fx = await makeProject();
    const w = await fx.p.start({ goal: 'Ship it', constraints: ['c1'], lead: 'pm', by: 'alice' });
    expect(pairs(w)).toEqual([['pm', 'needsLead']]);
    const b = await fx.p.board();
    expect(b).toMatchObject({ owner: 'alice', lead: 'pm', goal: 'Ship it', constraints: ['c1'], status: 'active', planStatus: 'none' });
    const ledger = await fx.store.read(fx.projectId, 1);
    expect(ledger.map(e => (e.body.type === 'event' ? e.body.event.kind : 'chat'))).toEqual(['projectStarted']);
  });

  test('planning context carries goal, roster and human messages; cacheable segments come first', async () => {
    const fx = await startOnly();
    await fx.p.ingest({ author: { kind: 'human', id: 'alice' }, text: 'Make it cute.' });
    const ctx = await fx.p.buildPlanningContext();
    expect(ctx.segments.map(s => [s.kind, s.cacheable])).toEqual([
      ['common', true],
      ['board', true],
      ['projection', false],
    ]);
    const body = seg(ctx, 'projection')!;
    expect(body).toContain('Ship a tiny platformer demo.');
    expect(body).toContain('- art: Pixel artist');
    expect(body).toContain('Make it cute.');
    expect(ctx.tools).toEqual([]);
    expect(ctx.stats.total).toBe(Object.values(ctx.stats.bySegment).reduce((a, b) => a + b, 0));
  });

  test('proposePlan by non-lead is FORBIDDEN; invalid plan is INVALID_PLAN with reasons', async () => {
    const fx = await startOnly();
    await expect(fx.p.proposePlan(FIXTURE_PLAN, { by: 'art' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    const bad = { ...FIXTURE_PLAN, workstreams: [...FIXTURE_PLAN.workstreams, { id: 'ui', title: 'UI', brief: '', owner: 'ghost', dependsOn: ['ui'] }] };
    const err = await fx.p.proposePlan(bad, { by: 'pm' }).catch(e => e);
    expect(err).toBeInstanceOf(ContextError);
    expect(err.code).toBe('INVALID_PLAN');
    expect(err.details.reasons.length).toBeGreaterThanOrEqual(2);
  });

  test('proposePlan writes planProposed, sets draft and asks the owner', async () => {
    const fx = await startOnly();
    const { proposalId } = await fx.p.proposePlan(FIXTURE_PLAN, { by: 'pm' });
    expect((await fx.p.board()).planStatus).toBe('draft');
    expect(fx.eventsOf('needsHuman')).toEqual([expect.objectContaining({ ref: proposalId })]);
    const last = (await fx.store.read(fx.projectId, 1)).at(-1)!;
    expect(last.body).toMatchObject({ type: 'event', event: { kind: 'planProposed', proposalId } });
  });

  test('approvePlan by non-owner is FORBIDDEN', async () => {
    const fx = await startOnly();
    const { proposalId } = await fx.p.proposePlan(FIXTURE_PLAN, { by: 'pm' });
    await expect(fx.p.approvePlan(proposalId, { by: 'pm' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(fx.p.approvePlan('nope', { by: 'alice' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  test('approvePlan activates ready workstreams and wakes their owners with assigned', async () => {
    const fx = await startOnly();
    const { proposalId: id } = await fx.p.proposePlan(FIXTURE_PLAN, { by: 'pm' });
    const w = await fx.p.approvePlan(id, { by: 'alice' }); // art、audio 无依赖；logic 依赖 art
    expect(w.map(x => [x.botId, x.reason]).sort()).toEqual([
      ['art', 'assigned'],
      ['audio', 'assigned'],
    ]);
    const b = await fx.p.board();
    expect(b.planStatus).toBe('approved');
    expect(Object.fromEntries(b.workstreams.map(x => [x.id, x.status]))).toEqual({ art: 'active', audio: 'active', logic: 'pending' });
    expect(b.contracts).toEqual([{ id: 'c1', from: 'art', to: 'logic', spec: 'PNG sprite sheets, 16x16 tiles', version: 1 }]);
    await expect(fx.p.approvePlan(id, { by: 'alice' })).rejects.toMatchObject({ code: 'INVALID_OP' });
  });

  test('approvePlan with edits validates and uses the edited plan', async () => {
    const fx = await startOnly();
    const { proposalId: id } = await fx.p.proposePlan(FIXTURE_PLAN, { by: 'pm' });
    const bad = { ...FIXTURE_PLAN, contracts: [{ id: 'c9', from: 'art', to: 'nope', spec: 'x' }] };
    await expect(fx.p.approvePlan(id, { by: 'alice', edits: bad })).rejects.toMatchObject({ code: 'INVALID_PLAN' });
    const edits = { workstreams: [FIXTURE_PLAN.workstreams[0]!], contracts: [] };
    expect(pairs(await fx.p.approvePlan(id, { by: 'alice', edits }))).toEqual([['art', 'assigned']]);
    expect((await fx.p.board()).workstreams.map(x => x.id)).toEqual(['art']);
  });

  test('approvePlan emits writeScopeOverlap for overlapping active workstreams', async () => {
    const fx = await startOnly();
    const plan = {
      workstreams: [
        { ...FIXTURE_PLAN.workstreams[0]!, writeScopes: ['src/ui'] },
        { ...FIXTURE_PLAN.workstreams[1]!, writeScopes: ['src/ui/sound'] },
      ],
      contracts: [],
    };
    const { proposalId } = await fx.p.proposePlan(plan, { by: 'pm' });
    await fx.p.approvePlan(proposalId, { by: 'alice' });
    expect(fx.eventsOf('writeScopeOverlap')).toEqual([{ a: 'art', b: 'audio', prefix: 'src/ui' }]);
  });

  test('rejectPlan wakes lead; third rejection emits needsHuman', async () => {
    const fx = await startOnly();
    for (let i = 1; i <= 3; i++) {
      const { proposalId } = await fx.p.proposePlan(FIXTURE_PLAN, { by: 'pm' });
      fx.events.length = 0;
      await expect(fx.p.rejectPlan(proposalId, { by: 'pm', feedback: 'x' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
      const w = await fx.p.rejectPlan(proposalId, { by: 'alice', feedback: `too big ${i}` });
      expect(pairs(w)).toEqual([['pm', 'needsLead']]);
      expect(fx.eventsOf('needsHuman')).toHaveLength(i === 3 ? 1 : 0);
    }
    const ctx = await fx.p.buildPlanningContext();
    expect(seg(ctx, 'projection')).toContain('too big 3');
    expect(seg(ctx, 'projection')).toContain('## Previous plan');
  });
});

describe('execution and review', () => {
  test('deliverable → lead woken → review pass → dependent woken with upstreamDelivered', async () => {
    const fx = await makeProject({ approved: true });
    const { id, wakes } = await deliverArt(fx);
    expect(pairs(wakes)).toEqual([['pm', 'needsLead']]);
    const ledger = await fx.store.read(fx.projectId, 1);
    expect(ledger.at(-1)!.body).toMatchObject({ event: { kind: 'deliverableSubmitted', workstreamId: 'art', deliverableId: id } });

    const review = await fx.p.buildReviewContext(id);
    expect(seg(review, 'projection')).toContain('sprites.png');
    expect(seg(review, 'projection')).toContain('c1@v1');

    await expect(fx.p.submitReview(id, { by: 'art', passed: true, notes: '' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    const w = await fx.p.submitReview(id, { by: 'pm', passed: true, notes: 'ok' });
    expect(pairs(w)).toEqual([['logic', 'upstreamDelivered']]);
    const statuses = Object.fromEntries((await fx.p.board()).workstreams.map(x => [x.id, x.status]));
    expect(statuses).toEqual({ art: 'delivered', audio: 'active', logic: 'active' });
  });

  test('submit deliverable checks membership and ownership', async () => {
    const fx = await makeProject({ approved: true });
    const d = { type: 'deliverable' as const, workstreamId: 'art', summary: 's', content: 'c' };
    await expect(fx.p.submit('ghost', d)).rejects.toMatchObject({ code: 'NOT_A_MEMBER' });
    await expect(fx.p.submit('audio', d)).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  test('review fail increments rounds; exceeding maxReviewRounds emits needsHuman', async () => {
    const fx = await makeProject({ approved: true });
    for (let round = 1; round <= 4; round++) {
      const { id } = await deliverArt(fx, `v${round}`);
      const w = await fx.p.submitReview(id, { by: 'pm', passed: false, notes: `wrong size ${round}` });
      expect(pairs(w)).toEqual([['art', 'reviewFailed']]);
      expect((await fx.p.board()).workstreams.find(x => x.id === 'art')!.reviewRounds).toBe(round);
      expect(fx.eventsOf('needsHuman').filter(e => e.ref === 'art')).toHaveLength(round > 3 ? 1 : 0);
    }
  });

  test('review conventions are merged onto the board', async () => {
    const fx = await makeProject({ approved: true });
    const { id } = await deliverArt(fx);
    await fx.p.submitReview(id, { by: 'pm', passed: false, notes: 'naming', conventions: ['Use snake_case file names'] });
    const b = await fx.p.board();
    expect(b.conventions).toEqual([
      expect.objectContaining({ text: 'Use snake_case file names', authority: 'bot', source: { entryIds: [], by: 'pm' } }),
    ]);
    expect(fx.eventsOf('merged')).not.toHaveLength(0);
  });

  test('blocked sets status and wakes lead', async () => {
    const fx = await makeProject({ approved: true });
    const w = await fx.p.submit('audio', { type: 'blocked', workstreamId: 'audio', reason: 'no samples' });
    expect(pairs(w)).toEqual([['pm', 'needsLead']]);
    expect((await fx.p.board()).workstreams.find(x => x.id === 'audio')!.status).toBe('blocked');
    const last = (await fx.store.read(fx.projectId, 1)).at(-1)!;
    expect(last.body).toMatchObject({ event: { kind: 'blocked', workstreamId: 'audio', reason: 'no samples' } });
  });

  test('proposal submissions merge and return structural wakes', async () => {
    const fx = await makeProject({ approved: true });
    const w = await fx.p.submit('art', { type: 'proposal', ops: [fact(['logic'])] });
    expect(pairs(w)).toEqual([['logic', 'decisionChanged']]);
    expect((await fx.p.board()).facts).toHaveLength(1);
  });

  test('replan keeps delivered workstreams and wakes owners whose contracts changed', async () => {
    const fx = await makeProject({ approved: true });
    const { id } = await deliverArt(fx);
    await fx.p.submitReview(id, { by: 'pm', passed: true, notes: 'ok' });
    const replan = {
      workstreams: [
        FIXTURE_PLAN.workstreams[0]!,
        { ...FIXTURE_PLAN.workstreams[1]!, brief: 'Make the sound, 8-bit style.' },
        // logic's brief and its contract both change: one contractChanged wake (deduped)
        { ...FIXTURE_PLAN.workstreams[2]!, brief: 'Write the rules for 32px tiles.' },
        { id: 'ui', title: 'Menus', brief: 'Build menus.', owner: 'pm', dependsOn: ['logic'] },
      ],
      contracts: [{ id: 'c1', from: 'art', to: 'logic', spec: 'PNG sprite sheets, 32x32 tiles' }],
    };
    const { proposalId } = await fx.p.proposePlan(replan, { by: 'pm' });
    expect((await fx.p.board()).planStatus).toBe('approved');
    const w = await fx.p.approvePlan(proposalId, { by: 'alice' });
    expect(pairs(w)).toEqual([
      ['art', 'contractChanged'],
      ['audio', 'contractChanged'],
      ['logic', 'contractChanged'],
    ]);
    const b = await fx.p.board();
    const art = b.workstreams.find(x => x.id === 'art')!;
    expect(art.status).toBe('delivered');
    expect(art.deliverables).toHaveLength(1);
    expect(b.workstreams.find(x => x.id === 'audio')!.brief).toBe('Make the sound, 8-bit style.');
    expect(b.workstreams.find(x => x.id === 'ui')!.status).toBe('pending');
    expect(b.contracts).toEqual([expect.objectContaining({ id: 'c1', spec: 'PNG sprite sheets, 32x32 tiles', version: 2 })]);
  });
});

describe('pending proposals', () => {
  test('setGoal from a bot becomes human-pending; owner resolves it', async () => {
    const fx = await makeProject({ approved: true });
    const w = await fx.p.submit('art', { type: 'proposal', ops: [{ op: 'setGoal', goal: 'Ship a big game' }] });
    expect(w).toEqual([]);
    const pending = await fx.store.listPending(fx.projectId);
    expect(pending).toEqual([expect.objectContaining({ needs: 'human' })]);
    expect(fx.eventsOf('needsHuman').at(-1)).toMatchObject({ ref: pending[0]!.id });
    await expect(fx.p.resolveProposal(pending[0]!.id, { by: 'pm', accept: true })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await fx.p.resolveProposal(pending[0]!.id, { by: 'alice', accept: true });
    expect((await fx.p.board()).goal).toBe('Ship a big game');
    expect(await fx.store.listPending(fx.projectId)).toEqual([]);
  });

  test('lead pending wakes the lead; resolving it returns structural wakes and clears the timer', async () => {
    const fx = await makeProject({ approved: true });
    fx.events.length = 0;
    const op: BoardOp = { op: 'updateContract', id: 'c1', spec: 'PNG, 32x32' };
    const w = await fx.p.submit('art', { type: 'proposal', ops: [op] });
    expect(pairs(w)).toEqual([['pm', 'needsLead']]);
    expect(fx.clock.pendingTimers()).toBe(1);
    const [pending] = await fx.store.listPending(fx.projectId);
    const r = await fx.p.resolveProposal(pending!.id, { by: 'pm', accept: true });
    expect(pairs(r)).toEqual([
      ['art', 'contractChanged'],
      ['logic', 'contractChanged'],
    ]);
    expect(fx.clock.pendingTimers()).toBe(0);
    fx.clock.advance(600_000);
    expect(fx.eventsOf('needsHuman')).toHaveLength(0);
  });

  test('lead pending times out into needsHuman', async () => {
    const fx = await makeProject({ approved: true });
    fx.events.length = 0;
    await fx.p.submit('art', { type: 'proposal', ops: [{ op: 'updateContract', id: 'c1', spec: 'PNG, 32x32' }] });
    const [pending] = await fx.store.listPending(fx.projectId);
    fx.clock.advance(599_999);
    expect(fx.eventsOf('needsHuman')).toHaveLength(0);
    fx.clock.advance(1);
    expect(fx.eventsOf('needsHuman')).toEqual([expect.objectContaining({ ref: pending!.id })]);
    // the pending proposal is kept for the lead
    expect(await fx.store.listPending(fx.projectId)).toHaveLength(1);
  });

  test('dispose clears lead timers', async () => {
    const fx = await makeProject({ approved: true });
    await fx.p.submit('art', { type: 'proposal', ops: [{ op: 'updateContract', id: 'c1', spec: 'PNG, 32x32' }] });
    fx.p.dispose();
    expect(fx.clock.pendingTimers()).toBe(0);
  });
});

describe('close and retro', () => {
  test('close refuses with pending workstreams unless forced; writes after close are PROJECT_CLOSED', async () => {
    const fx = await makeProject({ approved: true });
    await expect(fx.p.close({ by: 'pm' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    const err = await fx.p.close({ by: 'alice' }).catch(e => e);
    expect(err.code).toBe('PROJECT_NOT_COMPLETE');
    expect(err.details.pending.sort()).toEqual(['art', 'audio', 'logic']);
    await fx.p.close({ by: 'alice', force: true });
    const b = await fx.p.board();
    expect(b.status).toBe('closed');
    const last = (await fx.store.read(fx.projectId, 1)).at(-1)!;
    expect(last.body).toMatchObject({ event: { kind: 'projectClosed', forced: true } });

    const closed = { code: 'PROJECT_CLOSED' };
    await expect(fx.p.submit('art', { type: 'notes', text: 'x' })).rejects.toMatchObject(closed);
    await expect(fx.p.proposePlan(FIXTURE_PLAN, { by: 'pm' })).rejects.toMatchObject(closed);
    await expect(fx.p.ingest({ author: { kind: 'human', id: 'alice' }, text: 'hi' })).rejects.toMatchObject(closed);
    await expect(fx.p.merge()).rejects.toMatchObject(closed);
    await expect(fx.p.close({ by: 'alice', force: true })).rejects.toMatchObject(closed);
    // retro and reads stay available
    await expect(fx.p.buildRetroContext('art')).resolves.toBeDefined();
    await expect(fx.p.commitRetro('art', [{ text: 'lesson' }])).resolves.toBeUndefined();
    await expect(fx.p.buildBrief('art', { maxTokens: 100_000 })).resolves.toBeDefined();
  });

  test('close succeeds without force once every workstream is delivered', async () => {
    const fx = await startOnly();
    const { proposalId } = await fx.p.proposePlan({ workstreams: [FIXTURE_PLAN.workstreams[0]!], contracts: [] }, { by: 'pm' });
    await fx.p.approvePlan(proposalId, { by: 'alice' });
    const { id } = await deliverArt(fx);
    await fx.p.submitReview(id, { by: 'pm', passed: true, notes: '' });
    await fx.p.close({ by: 'alice' });
    const last = (await fx.store.read(fx.projectId, 1)).at(-1)!;
    expect(last.body).toMatchObject({ event: { kind: 'projectClosed', forced: false } });
  });

  test('commitRetro writes only own memory and condenses when over budget', async () => {
    const condense = vi.fn(async (i: { condensed: string; evicted: string[] }) => `summary of ${i.evicted.length}`);
    const fx = await makeProject({ approved: true, options: { memoryMaxTokens: 40, recentKeep: 2 }, models: { condense } });
    const before = await fx.employees.get('logic');
    await fx.p.commitRetro('art', [{ text: 'Always export sprites at 16px.', pinned: true }]);
    for (let i = 0; i < 4; i++) await fx.p.commitRetro('art', [{ text: `Lesson number ${i} about sprite sheets.` }]);
    const art = (await fx.employees.get('art'))!;
    expect(await fx.employees.get('logic')).toEqual(before);
    expect(condense).toHaveBeenCalled();
    expect(art.condensed).toMatch(/^summary of/);
    expect(art.memories.filter(m => m.pinned).map(m => m.text)).toEqual(['Always export sprites at 16px.']);
    expect(art.memories.filter(m => !m.pinned).length).toBeLessThanOrEqual(2);
    expect(art.memories.at(-1)).toMatchObject({ text: 'Lesson number 3 about sprite sheets.', fromProject: 'p1' });
    await expect(fx.p.commitRetro('ghost', [{ text: 'x' }])).rejects.toMatchObject({ code: 'NOT_A_MEMBER' });
  });

  test('commitRetro keeps memories and emits condenseAborted when condensing fails', async () => {
    const condense = vi.fn(async () => {
      throw new Error('model down');
    });
    const fx = await makeProject({ approved: true, options: { memoryMaxTokens: 10 }, models: { condense } });
    await fx.p.commitRetro('art', [{ text: 'A long enough lesson to blow the budget.' }, { text: 'Another lesson.' }]);
    const art = (await fx.employees.get('art'))!;
    expect(art.memories.map(m => m.text)).toEqual(['A long enough lesson to blow the budget.', 'Another lesson.']);
    expect(fx.eventsOf('condenseAborted')).toEqual([expect.objectContaining({ target: 'memory', botId: 'art' })]);
  });

  test('retro context shows own part, reviews and memory', async () => {
    const fx = await makeProject({ approved: true });
    const { id } = await deliverArt(fx);
    await fx.p.submitReview(id, { by: 'pm', passed: false, notes: 'too blurry' });
    const ctx = await fx.p.buildRetroContext('art');
    const body = seg(ctx, 'projection')!;
    expect(body).toContain('# Retrospective');
    expect(body).toContain('art | Sprites | art');
    expect(body).toContain('too blurry');
    await expect(fx.p.buildRetroContext('ghost')).rejects.toMatchObject({ code: 'NOT_A_MEMBER' });
  });
});

describe('notes', () => {
  test('notes are appended as paragraphs; pinned notes are pinned', async () => {
    const fx = await makeProject({ approved: true });
    await fx.p.submit('art', { type: 'notes', text: 'first' });
    await fx.p.submit('art', { type: 'notes', text: 'second' });
    await fx.p.submit('art', { type: 'notes', text: 'keep me', pinned: true });
    const ws = (await fx.store.getWorkspace(fx.projectId, 'art'))!;
    expect(ws.notes).toBe('first\n\nsecond');
    expect(ws.pinnedNotes).toEqual(['keep me']);
  });

  test('notes over budget are condensed; a failed condense keeps them and emits condenseAborted', async () => {
    const ok = await makeProject({ approved: true, options: { notesMaxTokens: 15, recentKeep: 1 }, models: { condense: async () => 'sum' } });
    for (let i = 0; i < 4; i++) await ok.p.submit('art', { type: 'notes', text: `note number ${i} here` });
    const ws = (await ok.store.getWorkspace(ok.projectId, 'art'))!;
    expect(ws.condensed).toBe('sum');
    expect(ws.notes).toBe('note number 3 here');

    const bad = await makeProject({ approved: true, options: { notesMaxTokens: 5 } });
    await bad.p.submit('art', { type: 'notes', text: 'a note that is clearly longer than five tokens' });
    const ws2 = (await bad.store.getWorkspace(bad.projectId, 'art'))!;
    expect(ws2.notes).toBe('a note that is clearly longer than five tokens');
    expect(bad.eventsOf('condenseAborted')).toEqual([expect.objectContaining({ target: 'notes', botId: 'art' })]);
  });
});

describe('chat', () => {
  test('ingest stores chat; route wakes mentioned members', async () => {
    const fx = await makeProject({ approved: true });
    const e = await fx.p.ingest({ author: { kind: 'human', id: 'alice' }, text: '@art hi', mentions: ['art'] });
    expect(e.seq).toBeGreaterThan(0);
    expect(pairs(await fx.p.route(e))).toEqual([['art', 'mentioned']]);
    const r = await fx.p.ingest({ author: { kind: 'bot', id: 'art' }, text: 'what size?', replyTo: e.id, act: 'query' });
    expect(r.body).toMatchObject({ hops: 1 });
  });

  test('route emits wakeLimitReached once per human message', async () => {
    const fx = await makeProject({ approved: true, options: { maxBotTurnsPerHumanMessage: 2 } });
    const h = await fx.p.ingest({ author: { kind: 'human', id: 'alice' }, text: 'go' });
    const bot = (text: string) => fx.p.ingest({ author: { kind: 'bot', id: 'art' }, text, mentions: ['logic'], act: 'request' });
    expect(pairs(await fx.p.route(await bot('1')))).toEqual([['logic', 'mentioned']]);
    expect(pairs(await fx.p.route(await bot('2')))).toEqual([['logic', 'mentioned']]);
    expect(await fx.p.route(await bot('3'))).toEqual([]);
    expect(await fx.p.route(await bot('4'))).toEqual([]);
    expect(fx.eventsOf('wakeLimitReached')).toEqual([{ afterSeq: h.seq }]);
    const h2 = await fx.p.ingest({ author: { kind: 'human', id: 'alice' }, text: 'again' });
    expect(pairs(await fx.p.route(await bot('5')))).toEqual([['logic', 'mentioned']]);
    await fx.p.route(await bot('6'));
    await fx.p.route(await bot('7'));
    expect(fx.eventsOf('wakeLimitReached')).toEqual([{ afterSeq: h.seq }, { afterSeq: h2.seq }]);
  });

  test('route with no match falls back to the routing model', async () => {
    const route = vi.fn(async (_i: RouteInput) => ['audio']);
    const fx = await makeProject({ approved: true, models: { route } });
    const e = await fx.p.ingest({ author: { kind: 'human', id: 'alice' }, text: 'anything new?' });
    expect(pairs(await fx.p.route(e))).toEqual([['audio', 'routed']]);
    const input = route.mock.calls[0]![0];
    expect(input.message.id).toBe(e.id);
    expect(input.candidates.map(c => c.botId).sort()).toEqual(['art', 'audio', 'logic', 'pm']);
  });
});

describe('facade wiring', () => {
  test('wake events are emitted for every returned wake', async () => {
    const fx = await startOnly();
    const all: Wake[] = [];
    const { proposalId } = await fx.p.proposePlan(FIXTURE_PLAN, { by: 'pm' });
    all.push(...(await fx.p.approvePlan(proposalId, { by: 'alice' })));
    all.push(...(await deliverArt(fx)).wakes);
    all.push(...(await fx.p.submit('audio', { type: 'blocked', workstreamId: 'audio', reason: 'r' })));
    const emitted = fx.eventsOf('wake').flatMap(e => e.wakes);
    expect([{ botId: 'pm', reason: 'needsLead' }, ...all].map(w => [w.botId, w.reason])).toEqual(
      emitted.map(w => [w.botId, w.reason]),
    );
    expect(fx.eventsOf('wake').every(e => e.wakes.length > 0)).toBe(true);
  });

  test('returned wakes are deduped by bot and reason', async () => {
    const fx = await makeProject({ approved: true });
    const w = await fx.p.submit('art', { type: 'proposal', ops: [fact(['logic']), fact(['logic'])] });
    expect(pairs(w)).toEqual([['logic', 'decisionChanged']]);
  });

  test('boardChanged is emitted with the new version after board writes', async () => {
    const fx = await makeProject({ approved: true });
    fx.events.length = 0;
    await fx.p.submit('art', { type: 'proposal', ops: [fact(['art'])] });
    const v = (await fx.store.getBoard(fx.projectId)).version;
    expect(fx.eventsOf('boardChanged').at(-1)).toEqual({ version: v });
  });

  test('planning and review contexts share cacheable segments with buildBrief', async () => {
    const fx = await makeProject({ approved: true });
    const brief = await fx.p.buildBrief('pm', { maxTokens: 100_000, peek: true });
    const plan = await fx.p.buildPlanningContext();
    const { id } = await deliverArt(fx);
    const brief2 = await fx.p.buildBrief('pm', { maxTokens: 100_000, peek: true });
    const review = await fx.p.buildReviewContext(id);
    expect(seg(plan, 'common')).toBe(seg(brief, 'common'));
    expect(seg(plan, 'board')).toBe(seg(brief, 'board'));
    expect(seg(review, 'common')).toBe(seg(brief2, 'common'));
    expect(seg(review, 'board')).toBe(seg(brief2, 'board'));
  });

  test('buildBrief delegates and enforces membership', async () => {
    const fx = await makeProject({ approved: true });
    const b = await fx.p.buildBrief('art', { maxTokens: 100_000 });
    expect(seg(b, 'projection')).toContain('Draw the sprites.');
    await expect(fx.p.buildBrief('ghost', { maxTokens: 100_000 })).rejects.toMatchObject({ code: 'NOT_A_MEMBER' });
  });
});

/** Records calls; keeps host-owned fields in its own list. */
function fakeSource(): WorkstreamSource & { calls: string[]; rows: Pick<Workstream, 'id' | 'title' | 'owner' | 'dependsOn' | 'writeScopes' | 'status'>[]; failList: boolean; failSetStatus: number } {
  const s = {
    calls: [] as string[],
    rows: [] as Pick<Workstream, 'id' | 'title' | 'owner' | 'dependsOn' | 'writeScopes' | 'status'>[],
    failList: false,
    failSetStatus: 0,
    async list() {
      if (s.failList) throw new Error('host down');
      return structuredClone(s.rows);
    },
    async create(_p: string, ws: Parameters<WorkstreamSource['create']>[1]) {
      s.calls.push(`create:${ws.map(w => w.id).join(',')}`);
      for (const w of ws) s.rows.push({ id: w.id, title: w.title, owner: w.owner, dependsOn: [...w.dependsOn], writeScopes: [...(w.writeScopes ?? [])], status: 'pending' });
    },
    async setStatus(_p: string, id: string, status: Workstream['status']) {
      s.calls.push(`setStatus:${id}:${status}`);
      if (s.failSetStatus > 0) {
        s.failSetStatus--;
        throw new Error('host write failed');
      }
      s.rows.find(r => r.id === id)!.status = status;
    },
    onChange: () => () => {},
  };
  return s;
}

describe('external WorkstreamSource', () => {
  test('external WorkstreamSource is used when provided', async () => {
    const source = fakeSource();
    const fx = await makeProject({ approved: true, workstreams: source });
    expect(source.calls).toEqual(['create:art,audio,logic', 'setStatus:art:active', 'setStatus:audio:active']);
    const stored = await fx.store.getBoard(fx.projectId);
    // core-owned fields are stored (R14); host-owned status is not tracked by the core board
    expect(stored.workstreams.map(w => [w.id, w.brief, w.reviewRounds, w.deliverables.length])).toEqual([
      ['art', 'Draw the sprites.', 0, 0],
      ['audio', 'Make the sound.', 0, 0],
      ['logic', 'Write the rules.', 0, 0],
    ]);
    expect(stored.workstreams.every(w => w.status === 'pending')).toBe(true);
    expect((await fx.p.board()).workstreams.find(w => w.id === 'art')!.status).toBe('active');

    const { id } = await deliverArt(fx);
    const w = await fx.p.submitReview(id, { by: 'pm', passed: true, notes: '' });
    // art is delivered, then logic (all dependencies delivered) becomes active
    expect(source.calls.slice(-2)).toEqual(['setStatus:art:delivered', 'setStatus:logic:active']);
    expect(pairs(w)).toEqual([['logic', 'upstreamDelivered']]);
    expect((await fx.store.getBoard(fx.projectId)).workstreams.find(x => x.id === 'art')!.status).toBe('pending');
  });

  test('WorkstreamSource.list failure makes buildBrief and route throw; setStatus failing 3 times emits needsHuman', async () => {
    const source = fakeSource();
    const fx = await makeProject({ approved: true, workstreams: source });
    const e = await fx.p.ingest({ author: { kind: 'human', id: 'alice' }, text: 'hello' });
    source.failList = true;
    await expect(fx.p.buildBrief('art', { maxTokens: 100_000 })).rejects.toThrow('host down');
    await expect(fx.p.route(e)).rejects.toThrow('host down');
    source.failList = false;

    source.failSetStatus = 2; // two failures then success: retried, no escalation
    await fx.p.submit('audio', { type: 'blocked', workstreamId: 'audio', reason: 'r' });
    expect(fx.eventsOf('needsHuman').filter(x => x.ref === 'audio')).toHaveLength(0);

    source.failSetStatus = 3;
    await expect(fx.p.submit('art', { type: 'blocked', workstreamId: 'art', reason: 'r' })).rejects.toThrow('host write failed');
    expect(source.calls.filter(c => c === 'setStatus:art:blocked')).toHaveLength(3);
    expect(fx.eventsOf('needsHuman').filter(x => x.ref === 'art')).toHaveLength(1);
  });
});

/** Wraps a store so that `method` fails `times` times before working; counts calls. */
function flaky(method: keyof Store, times: number): { store: Store; calls: () => number } {
  const inner = memoryStore();
  let left = times;
  let calls = 0;
  const store = new Proxy(inner, {
    get(t, k, r) {
      const v = Reflect.get(t, k, r);
      if (k !== method || typeof v !== 'function') return v;
      return async (...args: unknown[]) => {
        calls++;
        if (left > 0) {
          left--;
          throw new Error(`${String(method)} failed`);
        }
        return (v as (...a: unknown[]) => unknown).apply(t, args);
      };
    },
  });
  return { store, calls: () => calls };
}

describe('store write retries', () => {
  test('withRetry tries up to 3 times and rethrows the last error', async () => {
    let n = 0;
    await expect(withRetry(async () => ++n)).resolves.toBe(1);
    n = 0;
    const fails = async () => {
      n++;
      throw new Error(`fail ${n}`);
    };
    await expect(withRetry(fails)).rejects.toThrow('fail 3');
    expect(n).toBe(3);
  });

  test('store writes other than append are retried up to 3 times; append failure is thrown immediately', async () => {
    const two = flaky('saveWorkspace', 2);
    const fx = await makeProject({ approved: true, store: two.store });
    await fx.p.submit('art', { type: 'notes', text: 'hello' });
    expect(two.calls()).toBe(3);
    expect((await fx.store.getWorkspace(fx.projectId, 'art'))!.notes).toBe('hello');

    const three = flaky('saveWorkspace', 3);
    const fx3 = await makeProject({ approved: true, store: three.store });
    await expect(fx3.p.submit('art', { type: 'notes', text: 'hello' })).rejects.toThrow('saveWorkspace failed');
    expect(three.calls()).toBe(3);

    const board = flaky('saveBoard', 2);
    const fxb = await makeProject({ approved: true, store: board.store });
    await fxb.p.submit('art', { type: 'proposal', ops: [fact(['art'])] });
    expect((await fxb.p.board()).facts).toHaveLength(1);

    const app = flaky('append', 1);
    const fxa = await makeProject({ store: app.store });
    await expect(fxa.p.start({ goal: 'g', constraints: [], lead: 'pm', by: 'alice' })).rejects.toThrow('append failed');
    expect(app.calls()).toBe(1);
  });
});
