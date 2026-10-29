import { describe, expect, test, vi } from 'vitest';
import { ContextError } from '../src/errors.js';
import { createEventBus } from '../src/events.js';
import { memoryStore } from '../src/store/memory.js';
import type { RouteInput } from '../src/route.js';
import type { Store } from '../src/store/store.js';
import type { BoardOp, ContextBundle, SegmentKind, Wake, Workstream } from '../src/types.js';
import type { WorkstreamSource } from '../src/workstreams/source.js';
import { withRetry } from '../src/project.js';
import { createEmployeeRegistry } from '../src/employees.js';
import { createProject } from '../src/project.js';
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
    expect(ctx.tools.map(t => t.name)).toContain('proposePlan');
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
    // logic is woken once, with both reasons in the detail
    expect(w.find(x => x.botId === 'logic')!.detail).toBe('contract c1 changed for logic; brief of logic changed');
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
type HostRow = Pick<Workstream, 'id' | 'title' | 'owner' | 'dependsOn' | 'writeScopes' | 'status'>;
type FakeSource = WorkstreamSource & {
  calls: string[];
  rows: HostRow[];
  failList: boolean;
  /** setStatus failures still to come; limited to `failOn` when set. */
  failSetStatus: number;
  failOn?: string;
  handlers: Set<(ids: string[]) => void>;
  /** Simulates a host-side change notification. */
  fire(ids: string[]): void;
};

function fakeSource(): FakeSource {
  const s: FakeSource = {
    calls: [] as string[],
    rows: [] as HostRow[],
    failList: false,
    failSetStatus: 0,
    handlers: new Set(),
    fire: ids => {
      for (const h of s.handlers) h(ids);
    },
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
      if (s.failSetStatus > 0 && (s.failOn === undefined || s.failOn === id)) {
        s.failSetStatus--;
        throw new Error('host write failed');
      }
      s.rows.find(r => r.id === id)!.status = status;
    },
    onChange(_p, h) {
      s.handlers.add(h);
      return () => {
        s.handlers.delete(h);
      };
    },
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
function flaky(method: keyof Store, times: number): { store: Store; calls: () => number; arm(n: number): void } {
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
  return {
    store,
    calls: () => calls,
    arm: n => {
      left = n;
      calls = 0;
    },
  };
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

describe('fix round 1', () => {
  test('host onChange: a host-side delivery wakes the dependent with upstreamDelivered and activates it', async () => {
    const source = fakeSource();
    const fx = await makeProject({ approved: true, workstreams: source });
    fx.events.length = 0;
    source.rows.find(r => r.id === 'art')!.status = 'delivered';
    source.fire(['art']);
    await fx.p.merge(); // queued behind the host-change handling
    expect(fx.eventsOf('wake').flatMap(e => pairs(e.wakes))).toEqual([['logic', 'upstreamDelivered']]);
    expect(source.calls.at(-1)).toBe('setStatus:logic:active');
    // a notification with nothing new wakes nobody
    source.fire(['logic']);
    await fx.p.merge();
    expect(fx.eventsOf('wake')).toHaveLength(1);
    fx.p.dispose();
    expect(source.handlers.size).toBe(0);
  });

  test('two concurrent approvePlan calls: one succeeds, the other fails cleanly, workstreams created once', async () => {
    const source = fakeSource();
    const fx = await startOnly({ workstreams: source });
    const { proposalId } = await fx.p.proposePlan(FIXTURE_PLAN, { by: 'pm' });
    const [a, b] = await Promise.allSettled([
      fx.p.approvePlan(proposalId, { by: 'alice' }),
      fx.p.approvePlan(proposalId, { by: 'alice' }),
    ]);
    expect(a.status).toBe('fulfilled');
    expect(b).toMatchObject({ status: 'rejected', reason: { code: 'INVALID_OP' } });
    expect(source.calls.filter(c => c.startsWith('create:'))).toHaveLength(1);
    const approved = (await fx.store.read(fx.projectId, 1)).filter(e => e.body.type === 'event' && e.body.event.kind === 'planApproved');
    expect(approved).toHaveLength(1);
  });

  test('approvePlan racing rejectPlan leaves a consistent state', async () => {
    const fx = await startOnly();
    const { proposalId } = await fx.p.proposePlan(FIXTURE_PLAN, { by: 'pm' });
    const [a, r] = await Promise.allSettled([
      fx.p.approvePlan(proposalId, { by: 'alice' }),
      fx.p.rejectPlan(proposalId, { by: 'alice', feedback: 'no' }),
    ]);
    expect([a.status, r.status].filter(x => x === 'fulfilled')).toHaveLength(1);
    const proposal = (await fx.store.getPlanProposal(proposalId))!;
    const board = await fx.p.board();
    if (a.status === 'fulfilled') {
      expect(proposal.status).toBe('approved');
      expect(board.planStatus).toBe('approved');
      expect(board.workstreams).toHaveLength(3);
    } else {
      expect(proposal.status).toBe('rejected');
      expect(board.workstreams).toHaveLength(0);
    }
  });

  test('two concurrent passing reviews whose shared dependent becomes ready give exactly one upstreamDelivered', async () => {
    const fx = await startOnly();
    const plan = {
      workstreams: [
        FIXTURE_PLAN.workstreams[0]!,
        FIXTURE_PLAN.workstreams[1]!,
        { ...FIXTURE_PLAN.workstreams[2]!, dependsOn: ['art', 'audio'] },
      ],
      contracts: [],
    };
    const { proposalId } = await fx.p.proposePlan(plan, { by: 'pm' });
    await fx.p.approvePlan(proposalId, { by: 'alice' });
    const { id: artId } = await deliverArt(fx);
    await fx.p.submit('audio', { type: 'deliverable', workstreamId: 'audio', summary: 's', content: 'c' });
    const audioId = (await fx.p.board()).workstreams.find(w => w.id === 'audio')!.deliverables[0]!.id;
    const results = await Promise.all([
      fx.p.submitReview(artId, { by: 'pm', passed: true, notes: '' }),
      fx.p.submitReview(audioId, { by: 'pm', passed: true, notes: '' }),
    ]);
    expect(results.flat().filter(w => w.reason === 'upstreamDelivered')).toEqual([expect.objectContaining({ botId: 'logic' })]);
    expect((await fx.p.board()).workstreams.find(w => w.id === 'logic')!.status).toBe('active');
  });

  test('approvePlan can be retried after a partial failure and still assigns every ready workstream', async () => {
    const source = fakeSource();
    const fx = await startOnly({ workstreams: source });
    const { proposalId } = await fx.p.proposePlan(FIXTURE_PLAN, { by: 'pm' });
    source.failOn = 'audio';
    source.failSetStatus = 3; // art is activated, then audio fails three times
    await expect(fx.p.approvePlan(proposalId, { by: 'alice' })).rejects.toThrow('host write failed');
    expect((await fx.store.getPlanProposal(proposalId))!.status).toBe('pending');
    const w = await fx.p.approvePlan(proposalId, { by: 'alice' });
    expect(pairs(w)).toEqual([
      ['art', 'assigned'],
      ['audio', 'assigned'],
    ]);
    expect(source.calls.filter(c => c.startsWith('create:'))).toHaveLength(1);
  });

  test('submitReview writes the status before logging, so a failed log does not leave a logged review', async () => {
    const app = flaky('append', 0);
    const fx = await makeProject({ approved: true, store: app.store });
    const { id } = await deliverArt(fx);
    app.arm(1);
    await expect(fx.p.submitReview(id, { by: 'pm', passed: true, notes: '' })).rejects.toThrow('append failed');
    expect((await fx.p.board()).workstreams.find(w => w.id === 'art')!.status).toBe('delivered');
    await fx.p.submitReview(id, { by: 'pm', passed: true, notes: '' });
    const logged = (await fx.store.read(fx.projectId, 1)).filter(e => e.body.type === 'event' && e.body.event.kind === 'reviewPassed');
    expect(logged).toHaveLength(1);
  });

  test('a replan that adds or drops a contract between existing workstreams wakes both endpoint owners', async () => {
    const fx = await makeProject({ approved: true });
    const c2 = { id: 'c2', from: 'audio', to: 'logic', spec: 'OGG cues' };
    const add = await fx.p.proposePlan({ ...FIXTURE_PLAN, contracts: [...FIXTURE_PLAN.contracts, c2] }, { by: 'pm' });
    expect(pairs(await fx.p.approvePlan(add.proposalId, { by: 'alice' }))).toEqual([
      ['audio', 'contractChanged'],
      ['logic', 'contractChanged'],
    ]);
    const drop = await fx.p.proposePlan({ ...FIXTURE_PLAN, contracts: [c2] }, { by: 'pm' });
    expect(pairs(await fx.p.approvePlan(drop.proposalId, { by: 'alice' }))).toEqual([
      ['art', 'contractChanged'],
      ['logic', 'contractChanged'],
    ]);
    expect((await fx.p.board()).contracts.map(c => c.id)).toEqual(['c2']);
  });

  test('R22: with an external source a replan may not change host-owned fields; brief-only changes proceed', async () => {
    const source = fakeSource();
    const fx = await makeProject({ approved: true, workstreams: source });
    const [art, audio, logic] = FIXTURE_PLAN.workstreams;
    const bad = { ...FIXTURE_PLAN, workstreams: [art!, { ...audio!, title: 'Music' }, { ...logic!, owner: 'audio', dependsOn: [] }] };
    const { proposalId } = await fx.p.proposePlan(bad, { by: 'pm' });
    const err = await fx.p.approvePlan(proposalId, { by: 'alice' }).catch(e => e);
    expect(err.code).toBe('INVALID_PLAN');
    const reasons: string[] = err.details.reasons;
    expect(reasons).toHaveLength(3);
    expect(reasons.some(r => r.includes('"audio"') && r.includes('title'))).toBe(true);
    expect(reasons.some(r => r.includes('"logic"') && r.includes('owner'))).toBe(true);
    expect(reasons.some(r => r.includes('"logic"') && r.includes('dependsOn'))).toBe(true);
    expect(source.calls.filter(c => c.startsWith('create:'))).toHaveLength(1);

    const ok = await fx.p.proposePlan({ ...FIXTURE_PLAN, workstreams: [art!, { ...audio!, brief: 'Chiptune.' }, logic!] }, { by: 'pm' });
    const w = await fx.p.approvePlan(ok.proposalId, { by: 'alice' });
    expect(w).toEqual([{ botId: 'audio', reason: 'contractChanged', detail: 'brief of audio changed' }]);
    expect((await fx.p.board()).workstreams.find(x => x.id === 'audio')!.brief).toBe('Chiptune.');
  });

  test('R20: a non-lead bot cannot mark a workstream delivered through a proposal', async () => {
    const fx = await makeProject({ approved: true });
    const op: BoardOp = { op: 'setWorkstreamStatus', id: 'art', status: 'delivered' };
    await expect(fx.p.submit('art', { type: 'proposal', ops: [op] })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect((await fx.p.board()).workstreams.find(w => w.id === 'art')!.status).toBe('active');
    expect(await fx.store.drainProposals(fx.projectId)).toEqual([]);
  });

  test('R21: a new plan proposal supersedes the earlier pending one', async () => {
    const fx = await startOnly();
    const first = await fx.p.proposePlan(FIXTURE_PLAN, { by: 'pm' });
    const second = await fx.p.proposePlan(FIXTURE_PLAN, { by: 'pm' });
    expect((await fx.store.getPlanProposal(first.proposalId))!.status).toBe('rejected');
    await expect(fx.p.approvePlan(first.proposalId, { by: 'alice' })).rejects.toMatchObject({ code: 'INVALID_OP' });
    await expect(fx.p.approvePlan(second.proposalId, { by: 'alice' })).resolves.toHaveLength(2);
  });

  test('a failing local status write is retried by the store only (no nested retries)', async () => {
    const sb = flaky('saveBoard', 0);
    const fx = await makeProject({ approved: true, store: sb.store });
    sb.arm(100);
    await expect(fx.p.submit('audio', { type: 'blocked', workstreamId: 'audio', reason: 'r' })).rejects.toThrow('saveBoard failed');
    expect(sb.calls()).toBe(3);
    expect(fx.eventsOf('needsHuman').filter(e => e.ref === 'audio')).toHaveLength(1);
  });

  test('a rejected operation does not wedge the serial queue', async () => {
    const fx = await makeProject({ approved: true });
    const [bad, good] = await Promise.allSettled([
      fx.p.submit('ghost', { type: 'notes', text: 'x' }),
      fx.p.submit('art', { type: 'notes', text: 'still works' }),
    ]);
    expect(bad).toMatchObject({ status: 'rejected', reason: { code: 'NOT_A_MEMBER' } });
    expect(good.status).toBe('fulfilled');
  });
});

/** A memoryStore whose `method` waits at a gate the test opens; `reached` resolves when it is hit. */
function gated(method: keyof Store) {
  const inner = memoryStore();
  let open!: () => void;
  let hit!: () => void;
  const gate = new Promise<void>(r => (open = r));
  const reached = new Promise<void>(r => (hit = r));
  let armed = false;
  const store = new Proxy(inner, {
    get(t, k, r) {
      const v = Reflect.get(t, k, r);
      if (k !== method || typeof v !== 'function') return v;
      return async (...args: unknown[]) => {
        if (armed) {
          armed = false;
          hit();
          await gate;
        }
        return (v as (...a: unknown[]) => unknown).apply(t, args);
      };
    },
  });
  return { store, reached, arm: () => (armed = true), open: () => open() };
}

/** A memoryStore whose `append` of the given event kind fails `times` times. */
function failingEvent(kind: string, times: number): Store {
  const inner = memoryStore();
  let left = times;
  return new Proxy(inner, {
    get(t, k, r) {
      const v = Reflect.get(t, k, r);
      if (k !== 'append') return v;
      return async (e: Parameters<Store['append']>[0]) => {
        if (left > 0 && e.body.type === 'event' && e.body.event.kind === kind) {
          left--;
          throw new Error(`append ${kind} failed`);
        }
        return inner.append(e);
      };
    },
  });
}

const eventCount = async (fx: FacadeProject, kind: string) =>
  (await fx.store.read(fx.projectId, 1)).filter(e => e.body.type === 'event' && e.body.event.kind === kind).length;

describe('fix round 2', () => {
  test('R24: after a restart, a host change is acted on (logic activated with upstreamDelivered)', async () => {
    const source = fakeSource();
    const fx = await makeProject({ approved: true, workstreams: source });
    fx.p.dispose(); // the old process goes away
    const p2 = createProject({ projectId: fx.projectId, store: fx.store, employees: createEmployeeRegistry({ store: fx.store }), clock: fx.clock, workstreams: source });
    const wakes: Wake[] = [];
    p2.on('wake', e => wakes.push(...e.wakes));
    source.rows.find(r => r.id === 'art')!.status = 'delivered'; // host flips it right away
    source.fire(['art']);
    await p2.merge(); // queued behind init and the change handling
    expect(pairs(wakes)).toEqual([['logic', 'upstreamDelivered']]);
    expect(source.rows.find(r => r.id === 'logic')!.status).toBe('active');
    p2.dispose();
  });

  test('R24: a host change fired while a slow core operation runs still produces its wake', async () => {
    const source = fakeSource();
    const g = gated('saveWorkspace');
    const fx = await makeProject({ approved: true, workstreams: source, store: g.store });
    fx.events.length = 0;
    g.arm();
    const slow = fx.p.submit('art', { type: 'notes', text: 'working' });
    await g.reached;
    source.rows.find(r => r.id === 'art')!.status = 'delivered';
    source.fire(['art']);
    g.open();
    await slow;
    await fx.p.merge();
    expect(fx.eventsOf('wake').flatMap(e => pairs(e.wakes))).toEqual([['logic', 'upstreamDelivered']]);
    expect(source.rows.find(r => r.id === 'logic')!.status).toBe('active');
  });

  test('a non-peek buildBrief is queued: a concurrent note for the same bot survives', async () => {
    const fx = await makeProject({ approved: true });
    await Promise.all([
      fx.p.buildBrief('art', { maxTokens: 100_000 }),
      fx.p.submit('art', { type: 'notes', text: 'keep me' }),
    ]);
    expect((await fx.store.getWorkspace(fx.projectId, 'art'))!.notes).toBe('keep me');
  });

  test('route is queued: two concurrent routes at the limit emit wakeLimitReached once', async () => {
    const fx = await makeProject({ approved: true, options: { maxBotTurnsPerHumanMessage: 1 } });
    const h = await fx.p.ingest({ author: { kind: 'human', id: 'alice' }, text: 'go' });
    const bot = (text: string) => fx.p.ingest({ author: { kind: 'bot', id: 'art' }, text, mentions: ['logic'], act: 'request' });
    await bot('1');
    const [b2, b3] = [await bot('2'), await bot('3')];
    await Promise.all([fx.p.route(b2), fx.p.route(b3)]);
    expect(fx.eventsOf('wakeLimitReached')).toEqual([{ afterSeq: h.seq }]);
  });

  test('R25/R26: pass review retried after the dependent activation failed → dependent activated, one upstreamDelivered', async () => {
    const source = fakeSource();
    const fx = await makeProject({ approved: true, workstreams: source });
    const { id } = await deliverArt(fx);
    fx.events.length = 0;
    source.failOn = 'logic';
    source.failSetStatus = 3;
    await expect(fx.p.submitReview(id, { by: 'pm', passed: true, notes: 'ok' })).rejects.toThrow('host write failed');
    expect(source.rows.find(r => r.id === 'art')!.status).toBe('delivered');
    expect(source.rows.find(r => r.id === 'logic')!.status).toBe('pending');
    const w = await fx.p.submitReview(id, { by: 'pm', passed: true, notes: 'ok' });
    expect(pairs(w)).toEqual([['logic', 'upstreamDelivered']]);
    expect(source.rows.find(r => r.id === 'logic')!.status).toBe('active');
    expect(fx.eventsOf('wake').flatMap(e => e.wakes).filter(x => x.reason === 'upstreamDelivered')).toHaveLength(1);
    expect(source.calls.filter(c => c === 'setStatus:art:delivered')).toHaveLength(1);
    expect(await eventCount(fx, 'reviewPassed')).toBe(1);
  });

  test('R26: failed review retried after its event failed → rounds once, one reviewFailed event, conventions once', async () => {
    const fx = await makeProject({ approved: true, store: failingEvent('reviewFailed', 1) });
    const { id } = await deliverArt(fx);
    const r = { by: 'pm', passed: false, notes: 'naming', conventions: ['Use snake_case file names'] };
    await expect(fx.p.submitReview(id, r)).rejects.toThrow('append reviewFailed failed');
    const w = await fx.p.submitReview(id, r);
    expect(pairs(w)).toEqual([['art', 'reviewFailed']]);
    const b = await fx.p.board();
    expect(b.workstreams.find(x => x.id === 'art')!.reviewRounds).toBe(1);
    expect(b.conventions).toHaveLength(1);
    expect(await eventCount(fx, 'reviewFailed')).toBe(1);
  });

  test('replan compares dependsOn and writeScopes as sets (host may reorder them)', async () => {
    const source = fakeSource();
    const fx = await startOnly({ workstreams: source });
    const [art, audio, logic] = FIXTURE_PLAN.workstreams;
    const plan = { ...FIXTURE_PLAN, workstreams: [{ ...art!, writeScopes: ['src/a', 'src/b'] }, audio!, logic!] };
    const first = await fx.p.proposePlan(plan, { by: 'pm' });
    await fx.p.approvePlan(first.proposalId, { by: 'alice' });
    source.rows.find(r => r.id === 'art')!.writeScopes.reverse();
    const again = await fx.p.proposePlan(plan, { by: 'pm' });
    await expect(fx.p.approvePlan(again.proposalId, { by: 'alice' })).resolves.toEqual([]);
  });

  test('a local replan that reassigns an active workstream wakes the new owner with assigned', async () => {
    const fx = await makeProject({ approved: true });
    const [art, audio, logic] = FIXTURE_PLAN.workstreams;
    const { proposalId } = await fx.p.proposePlan({ ...FIXTURE_PLAN, workstreams: [art!, { ...audio!, owner: 'pm' }, logic!] }, { by: 'pm' });
    const w = await fx.p.approvePlan(proposalId, { by: 'alice' });
    expect(w).toEqual([{ botId: 'pm', reason: 'assigned', detail: 'workstream audio was reassigned to you' }]);
    expect((await fx.p.board()).workstreams.find(x => x.id === 'audio')!.owner).toBe('pm');
  });
});

/** A memoryStore whose setMeta for `key` fails while `fail` is true. */
function failingMeta(key: string) {
  const inner = memoryStore();
  const ctl = { fail: false };
  const store = new Proxy(inner, {
    get(t, k, r) {
      const v = Reflect.get(t, k, r);
      if (k !== 'setMeta') return v;
      return async (projectId: string, metaKey: string, value: unknown) => {
        if (ctl.fail && metaKey === key) throw new Error(`setMeta ${key} failed`);
        return inner.setMeta(projectId, metaKey, value);
      };
    },
  });
  return { store, ctl };
}

describe('fix round 3', () => {
  const twoDependents = {
    workstreams: [
      FIXTURE_PLAN.workstreams[0]!,
      { ...FIXTURE_PLAN.workstreams[1]!, dependsOn: ['art'] },
      FIXTURE_PLAN.workstreams[2]!,
    ],
    contracts: [],
  };

  test('R27: when the second dependent fails to activate, both owners still get upstreamDelivered exactly once', async () => {
    const source = fakeSource();
    const fx = await startOnly({ workstreams: source });
    const { proposalId } = await fx.p.proposePlan(twoDependents, { by: 'pm' });
    await fx.p.approvePlan(proposalId, { by: 'alice' });
    const { id } = await deliverArt(fx);
    fx.events.length = 0;
    source.failOn = 'logic';
    source.failSetStatus = 3;
    await expect(fx.p.submitReview(id, { by: 'pm', passed: true, notes: '' })).rejects.toThrow('host write failed');
    await fx.p.submitReview(id, { by: 'pm', passed: true, notes: '' });
    const delivered = fx.eventsOf('wake').flatMap(e => e.wakes).filter(w => w.reason === 'upstreamDelivered');
    expect(delivered.map(w => w.botId).sort()).toEqual(['audio', 'logic']);
    expect(source.rows.filter(r => r.status === 'active').map(r => r.id).sort()).toEqual(['audio', 'logic']);
  });

  test('R27: a failed status bookkeeping write asks a human but keeps the activation and its wake', async () => {
    const source = fakeSource();
    const m = failingMeta('hostStatus');
    const fx = await makeProject({ approved: true, workstreams: source, store: m.store });
    const { id } = await deliverArt(fx);
    fx.events.length = 0;
    m.ctl.fail = true;
    const w = await fx.p.submitReview(id, { by: 'pm', passed: true, notes: '' });
    m.ctl.fail = false;
    expect(pairs(w)).toEqual([['logic', 'upstreamDelivered']]);
    expect(source.rows.find(r => r.id === 'logic')!.status).toBe('active');
    expect(fx.eventsOf('needsHuman').map(e => e.ref).sort()).toEqual(['art', 'logic']);
  });

  test('R27: reconcile records a host change only after acting, so a failed activation is retried', async () => {
    const source = fakeSource();
    const fx = await makeProject({ approved: true, workstreams: source });
    fx.events.length = 0;
    source.failOn = 'logic';
    source.failSetStatus = 3;
    source.rows.find(r => r.id === 'art')!.status = 'delivered';
    source.fire(['art']);
    await fx.p.merge();
    expect(source.rows.find(r => r.id === 'logic')!.status).toBe('pending');
    expect(fx.eventsOf('wake')).toHaveLength(0);
    source.fire([]); // the next notification retries
    await fx.p.merge();
    expect(source.rows.find(r => r.id === 'logic')!.status).toBe('active');
    expect(fx.eventsOf('wake').flatMap(e => pairs(e.wakes))).toEqual([['logic', 'upstreamDelivered']]);
    expect(await fx.store.getMeta(fx.projectId, 'hostStatus')).toMatchObject({ art: 'delivered', logic: 'active' });
  });

  test('R27: a second failed review with different conventions is a new review round', async () => {
    const fx = await makeProject({ approved: true });
    const { id } = await deliverArt(fx);
    await fx.p.submitReview(id, { by: 'pm', passed: false, notes: 'one', conventions: ['a'] });
    await fx.p.submitReview(id, { by: 'pm', passed: false, notes: 'two', conventions: ['b'] });
    // the same review again is a no-op
    await fx.p.submitReview(id, { by: 'pm', passed: false, notes: 'two', conventions: ['b'] });
    const b = await fx.p.board();
    expect(b.conventions.map(c => c.text)).toEqual(['a', 'b']);
    expect(b.workstreams.find(x => x.id === 'art')!.reviewRounds).toBe(2);
    expect(await eventCount(fx, 'reviewFailed')).toBe(2);
  });
});
