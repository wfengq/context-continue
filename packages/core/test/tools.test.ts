import { describe, expect, test } from 'vitest';
import { ContextError } from '../src/errors.js';
import { proposalOutcome, toolDefinitions } from '../src/tools.js';
import { createEmployeeRegistry } from '../src/employees.js';
import { createProject } from '../src/project.js';
import { FIXTURE_PLAN, makeProject, type FacadeProject } from './helpers.js';

const MEMBER_TOOLS = [
  'getBoardItem',
  'getDeliverable',
  'promote',
  'proposeDecision',
  'recordFailure',
  'reportBlocked',
  'searchLedger',
  'sendMessage',
  'submitDeliverable',
  'updateNotes',
];
const LEAD_ONLY = ['listPending', 'proposePlan', 'resolveProposal', 'submitReview', 'unblockWorkstream'];

const names = (tools: { name: string }[]) => tools.map(t => t.name).sort();

async function approved(opts: Parameters<typeof makeProject>[0] = {}): Promise<FacadeProject> {
  return makeProject({ approved: true, ...opts });
}

const promoteArgs = (n: number) => ({ kind: 'fact', text: `Fact number ${n}`, affects: ['art'] });

describe('tool definitions', () => {
  test('member and lead tool lists match spec 6.2', () => {
    expect(names(toolDefinitions('member'))).toEqual(MEMBER_TOOLS);
    expect(names(toolDefinitions('lead'))).toEqual([...MEMBER_TOOLS, ...LEAD_ONLY].sort());
  });

  test('every definition has a description and an object JSON Schema', () => {
    for (const role of ['member', 'lead'] as const) {
      for (const t of toolDefinitions(role)) {
        expect(t.description.length).toBeGreaterThan(10);
        expect(t.parameters).toMatchObject({ type: 'object' });
        expect(Object.keys(t.parameters)).toContain('properties');
      }
    }
  });

  test('required parameters are visible in the schema: sendMessage act, promote affects', () => {
    const send = toolDefinitions('member').find(t => t.name === 'sendMessage')!;
    expect(send.parameters.required).toEqual(expect.arrayContaining(['text', 'act']));
    const promote = toolDefinitions('member').find(t => t.name === 'promote')!;
    expect(promote.parameters.required).toEqual(expect.arrayContaining(['kind', 'text', 'affects']));
  });

  test('no definition carries a top-level $schema key', () => {
    for (const t of toolDefinitions('lead')) expect(Object.keys(t.parameters)).not.toContain('$schema');
  });

  test('definitions are fresh copies', () => {
    const a = toolDefinitions('member');
    a[0]!.description = 'changed';
    expect(toolDefinitions('member')[0]!.description).not.toBe('changed');
  });

  test('briefs, planning, review and retro contexts carry the role tool list', async () => {
    const fx = await approved();
    const lead = await fx.p.buildBrief('pm', { maxTokens: 20_000, peek: true });
    expect(names(lead.tools)).toEqual(names(toolDefinitions('lead')));
    const art = await fx.p.buildBrief('art', { maxTokens: 20_000, peek: true });
    expect(names(art.tools)).toEqual(MEMBER_TOOLS);
    expect(names((await fx.p.buildPlanningContext()).tools)).toEqual(names(toolDefinitions('lead')));
    await fx.p.submit('art', { type: 'deliverable', workstreamId: 'art', summary: 's', content: 'c' });
    const d = (await fx.p.board()).workstreams.find(w => w.id === 'art')!.deliverables[0]!;
    expect(names((await fx.p.buildReviewContext(d.id)).tools)).toEqual(names(toolDefinitions('lead')));
    expect(names((await fx.p.buildRetroContext('art')).tools)).toEqual(MEMBER_TOOLS);
  });
});

describe('callTool permissions and validation', () => {
  test('non-member is NOT_A_MEMBER for any tool, before the lead check and validation', async () => {
    const fx = await approved();
    for (const name of [...MEMBER_TOOLS, ...LEAD_ONLY, 'noSuchTool']) {
      await expect(fx.p.callTool('ghost', name, {})).rejects.toMatchObject({ code: 'NOT_A_MEMBER' });
    }
  });

  test('member calling a lead tool is FORBIDDEN, even with invalid arguments', async () => {
    const fx = await approved();
    for (const name of LEAD_ONLY) {
      await expect(fx.p.callTool('art', name, {})).rejects.toMatchObject({ code: 'FORBIDDEN' });
    }
    await expect(fx.p.callTool('art', 'submitReview', { deliverableId: 'x', passed: true, notes: 'ok' })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
  });

  test('unknown tool is NOT_FOUND', async () => {
    const fx = await approved();
    await expect(fx.p.callTool('art', 'noSuchTool', {})).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  test('invalid arguments are INVALID_OP with zod issues in details', async () => {
    const fx = await approved();
    const err = (await fx.p.callTool('art', 'updateNotes', { text: 42 }).catch((e: unknown) => e)) as ContextError & {
      details: { issues: { path: unknown[] }[] };
    };
    expect(err).toBeInstanceOf(ContextError);
    expect(err.code).toBe('INVALID_OP');
    expect(Array.isArray(err.details.issues)).toBe(true);
    expect(err.details.issues[0]?.path).toEqual(['text']);
    await expect(fx.p.callTool('art', 'updateNotes', undefined)).rejects.toMatchObject({ code: 'INVALID_OP' });
  });

  test('the caller identity cannot be spoofed through arguments', async () => {
    const fx = await approved();
    // `by` is ignored: it is always the calling bot, so art cannot review as the lead
    await expect(fx.p.callTool('art', 'submitReview', { by: 'pm', deliverableId: 'x', passed: true, notes: 'n' })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
  });
});

describe('sendMessage', () => {
  test('without act is INVALID_OP; an unknown act is INVALID_OP', async () => {
    const fx = await approved();
    await expect(fx.p.callTool('art', 'sendMessage', { text: 'hello' })).rejects.toMatchObject({ code: 'INVALID_OP' });
    await expect(fx.p.callTool('art', 'sendMessage', { text: 'hello', act: 'shout' })).rejects.toMatchObject({ code: 'INVALID_OP' });
  });

  test('appends a bot chat entry, routes it and returns entryId and wakes', async () => {
    const fx = await approved();
    const r = (await fx.p.callTool('art', 'sendMessage', { text: '@logic please check the tile size', act: 'request', mentions: ['logic'] })) as {
      entryId: string;
      wakes: { botId: string; reason: string }[];
    };
    expect(r.wakes).toEqual([expect.objectContaining({ botId: 'logic', reason: 'mentioned' })]);
    const entry = (await fx.store.read(fx.projectId, 1)).find(e => e.id === r.entryId)!;
    expect(entry.author).toEqual({ kind: 'bot', id: 'art' });
    expect(entry.body).toMatchObject({ type: 'chat', act: 'request', mentions: ['logic'], hops: 0 });
  });

  test('replyTo extends the hop chain; a terminal act wakes nobody', async () => {
    const fx = await approved();
    const first = (await fx.p.callTool('art', 'sendMessage', { text: 'question?', act: 'query', mentions: ['logic'] })) as { entryId: string };
    const second = (await fx.p.callTool('logic', 'sendMessage', { text: 'answer', act: 'inform', replyTo: first.entryId, mentions: ['art'] })) as {
      entryId: string;
      wakes: unknown[];
    };
    expect(second.wakes).toEqual([]);
    const entry = (await fx.store.read(fx.projectId, 1)).find(e => e.id === second.entryId)!;
    expect(entry.body).toMatchObject({ replyTo: first.entryId, hops: 1 });
  });
});

describe('board proposal tools return the merge outcome (R30)', () => {
  test('proposeDecision on an own workstream applies', async () => {
    const fx = await approved();
    const r = await fx.p.callTool('art', 'proposeDecision', {
      text: 'Use 16x16 tiles',
      rationale: 'Fits the contract',
      rejected: ['32x32'],
      affects: ['art'],
    });
    expect(r).toEqual({ applied: true, pending: [], rejected: [] });
    const d = (await fx.p.board()).decisions;
    expect(d).toEqual([expect.objectContaining({ text: 'Use 16x16 tiles', authority: 'bot', affects: ['art'], source: { entryIds: [], by: 'art' } })]);
  });

  test('proposeDecision reaching beyond own workstreams waits for the lead', async () => {
    const fx = await approved();
    const r = (await fx.p.callTool('art', 'proposeDecision', {
      text: 'Palette is fixed',
      rationale: 'Consistency',
      affects: ['art', 'logic'],
    })) as { applied: boolean; pending: { id: string; needs: string }[]; rejected: unknown[] };
    expect(r.applied).toBe(false);
    expect(r.pending).toEqual([{ id: expect.any(String), needs: 'lead' }]);
    expect(r.rejected).toEqual([]);
    expect((await fx.p.board()).decisions).toEqual([]);

    // the lead resolves it through the tool, as itself
    const wakes = await fx.p.callTool('pm', 'resolveProposal', { pendingId: r.pending[0]!.id, accept: true });
    expect(wakes).toEqual({ wakes: expect.any(Array) });
    expect((await fx.p.board()).decisions).toHaveLength(1);
  });

  test('the lead cannot resolve as someone else; a member cannot resolve at all', async () => {
    const fx = await approved();
    const r = (await fx.p.callTool('art', 'proposeDecision', { text: 'T', rationale: 'R', affects: ['logic'] })) as {
      pending: { id: string }[];
    };
    await expect(fx.p.callTool('logic', 'resolveProposal', { pendingId: r.pending[0]!.id, accept: true })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
  });

  test('recordFailure applies and requires a reason and non-empty affects', async () => {
    const fx = await approved();
    expect(await fx.p.callTool('art', 'recordFailure', { text: 'Dithering', reason: 'Looks muddy', affects: ['art'] })).toEqual({
      applied: true,
      pending: [],
      rejected: [],
    });
    expect((await fx.p.board()).failures).toEqual([expect.objectContaining({ text: 'Dithering', reason: 'Looks muddy', affects: ['art'] })]);
    await expect(fx.p.callTool('art', 'recordFailure', { text: 'x', reason: 'y', affects: [] })).rejects.toMatchObject({ code: 'INVALID_OP' });
    await expect(fx.p.callTool('art', 'recordFailure', { text: 'x', affects: ['art'] })).rejects.toMatchObject({ code: 'INVALID_OP' });
  });

  test('proposalOutcome keeps only the proposal\'s own pending items and rejections', () => {
    const pend = (id: string, proposalId: string, needs: 'lead' | 'human', n: number) =>
      ({ id, proposalId, needs, ops: Array.from({ length: n }, () => ({})) }) as never;
    const merge = {
      pending: [pend('p1', 'prop-1', 'lead', 1), pend('p2', 'prop-2', 'human', 1)],
      rejected: [
        { proposalId: 'prop-1', index: 2, reason: 'Unknown workstream' },
        { proposalId: 'prop-2', index: 0, reason: 'other' },
      ],
    };
    expect(proposalOutcome('prop-1', 4, merge)).toEqual({
      applied: true,
      pending: [{ id: 'p1', needs: 'lead' }],
      rejected: [{ index: 2, reason: 'Unknown workstream' }],
    });
    expect(proposalOutcome('prop-1', 2, merge).applied).toBe(false);
    expect(proposalOutcome('prop-3', 1, merge)).toEqual({ applied: true, pending: [], rejected: [] });
    expect(proposalOutcome('prop-3', 1, null)).toEqual({ applied: false, pending: [], rejected: [] });
  });
});

describe('promote', () => {
  test('lands on the matching board section for each kind', async () => {
    const fx = await approved();
    expect(await fx.p.callTool('art', 'promote', { kind: 'fact', text: 'Sprites are PNG', affects: ['art'] })).toEqual({
      applied: true,
      pending: [],
      rejected: [],
    });
    await fx.p.callTool('art', 'promote', { kind: 'decision', text: 'Use PNG', rationale: 'Lossless', rejected: ['JPEG'], affects: ['art'] });
    await fx.p.callTool('art', 'promote', { kind: 'failure', text: 'Tried SVG', reason: 'Too slow', affects: ['art'] });
    const b = await fx.p.board();
    expect(b.facts.map(f => f.text)).toEqual(['Sprites are PNG']);
    expect(b.decisions.map(f => f.text)).toEqual(['Use PNG']);
    expect(b.failures.map(f => f.text)).toEqual(['Tried SVG']);
  });

  test('a decision needs a rationale and a failure needs a reason', async () => {
    const fx = await approved();
    await expect(fx.p.callTool('art', 'promote', { kind: 'decision', text: 'x', affects: ['art'] })).rejects.toMatchObject({ code: 'INVALID_OP' });
    await expect(fx.p.callTool('art', 'promote', { kind: 'failure', text: 'x', affects: ['art'] })).rejects.toMatchObject({ code: 'INVALID_OP' });
  });

  test('empty affects is rejected and does not count as a promotion', async () => {
    const fx = await approved();
    await expect(fx.p.callTool('art', 'promote', { kind: 'fact', text: 'x', affects: [] })).rejects.toMatchObject({ code: 'INVALID_OP' });
    await expect(fx.p.callTool('art', 'promote', { kind: 'fact', text: 'x' })).rejects.toMatchObject({ code: 'INVALID_OP' });
    for (let i = 1; i <= 3; i++) await fx.p.callTool('art', 'promote', promoteArgs(i));
  });

  test('the fourth promotion in a turn is FORBIDDEN; the next brief starts a new turn', async () => {
    const fx = await approved();
    for (let i = 1; i <= 3; i++) await fx.p.callTool('art', 'promote', promoteArgs(i));
    const err = await fx.p.callTool('art', 'promote', promoteArgs(4)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ContextError);
    expect((err as ContextError).code).toBe('FORBIDDEN');
    expect((await fx.p.board()).facts).toHaveLength(3);
    // the count is per bot
    await fx.p.callTool('audio', 'promote', { kind: 'fact', text: 'Audio fact', affects: ['audio'] });
    // a peek does not start a new turn, a real brief does
    await fx.p.buildBrief('art', { maxTokens: 20_000, peek: true });
    await expect(fx.p.callTool('art', 'promote', promoteArgs(5))).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await fx.p.buildBrief('art', { maxTokens: 20_000 });
    await fx.p.callTool('art', 'promote', promoteArgs(6));
    expect((await fx.store.getWorkspace(fx.projectId, 'art'))!.promotionsThisTurn).toBe(1);
  });

  test('maxPromotionsPerTurn option is honoured', async () => {
    const fx = await approved({ options: { maxPromotionsPerTurn: 1 } });
    await fx.p.callTool('art', 'promote', promoteArgs(1));
    await expect(fx.p.callTool('art', 'promote', promoteArgs(2))).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  test('parallel promotions cannot exceed the limit', async () => {
    const fx = await approved();
    const results = await Promise.allSettled([1, 2, 3, 4, 5].map(i => fx.p.callTool('art', 'promote', promoteArgs(i))));
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(3);
    expect(results.filter(r => r.status === 'rejected')).toHaveLength(2);
  });
});

describe('deliverables, blocked and review', () => {
  test('submitDeliverable then getDeliverable round-trips the content', async () => {
    const fx = await approved();
    const r = (await fx.p.callTool('art', 'submitDeliverable', { workstreamId: 'art', summary: 'sprite sheet', content: 'PNG-DATA' })) as {
      wakes: { botId: string; reason: string }[];
    };
    expect(r.wakes).toEqual(expect.arrayContaining([expect.objectContaining({ botId: 'pm', reason: 'needsLead' })]));
    const d = (await fx.p.board()).workstreams.find(w => w.id === 'art')!.deliverables[0]!;
    expect(await fx.p.callTool('logic', 'getDeliverable', { ref: d.ref })).toBe('PNG-DATA');
    await expect(fx.p.callTool('logic', 'getDeliverable', { ref: 'missing' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    // submitting for a workstream you do not own is rejected by the facade
    await expect(fx.p.callTool('logic', 'submitDeliverable', { workstreamId: 'art', summary: 's', content: 'c' })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
  });

  test('reportBlocked blocks the workstream and wakes the lead', async () => {
    const fx = await approved();
    const r = (await fx.p.callTool('art', 'reportBlocked', { workstreamId: 'art', reason: 'No palette' })) as { wakes: unknown[] };
    expect(r.wakes).toEqual([expect.objectContaining({ botId: 'pm', reason: 'needsLead' })]);
    expect((await fx.p.board()).workstreams.find(w => w.id === 'art')!.status).toBe('blocked');
  });

  test('the lead reviews through submitReview, as itself', async () => {
    const fx = await approved();
    await fx.p.callTool('art', 'submitDeliverable', { workstreamId: 'art', summary: 's', content: 'c' });
    const d = (await fx.p.board()).workstreams.find(w => w.id === 'art')!.deliverables[0]!;
    const r = (await fx.p.callTool('pm', 'submitReview', { deliverableId: d.id, passed: true, notes: 'good', conventions: ['Snake case names'] })) as {
      wakes: { botId: string; reason: string }[];
    };
    expect(r.wakes).toEqual(expect.arrayContaining([expect.objectContaining({ botId: 'logic', reason: 'upstreamDelivered' })]));
    const b = await fx.p.board();
    expect(b.workstreams.find(w => w.id === 'art')!.status).toBe('delivered');
    expect(b.conventions.map(c => c.text)).toEqual(['Snake case names']);
  });

  test('the lead proposes a plan through proposePlan', async () => {
    const fx = await makeProject();
    await fx.p.start({ goal: 'g', constraints: [], lead: 'pm', by: 'alice' });
    const r = (await fx.p.callTool('pm', 'proposePlan', FIXTURE_PLAN)) as { proposalId: string };
    expect(r.proposalId).toEqual(expect.any(String));
    expect((await fx.p.board()).planStatus).toBe('draft');
    // plan errors surface as INVALID_PLAN from the facade; shape errors as INVALID_OP
    await expect(fx.p.callTool('pm', 'proposePlan', { workstreams: [{ id: 'x', title: 'X', brief: 'b', owner: 'ghost', dependsOn: [] }], contracts: [] })).rejects.toMatchObject({ code: 'INVALID_PLAN' });
    await expect(fx.p.callTool('pm', 'proposePlan', { workstreams: 'x' })).rejects.toMatchObject({ code: 'INVALID_OP' });
  });
});

describe('reading tools', () => {
  test('getBoardItem returns the full item from any section, contracts by id', async () => {
    const fx = await approved();
    await fx.p.callTool('art', 'promote', { kind: 'fact', text: 'Sprites are PNG', affects: ['art'] });
    await fx.p.callTool('art', 'proposeDecision', { text: 'Use 16px', rationale: 'Contract', rejected: ['32px'], affects: ['art'] });
    await fx.p.callTool('art', 'recordFailure', { text: 'Tried SVG', reason: 'Too slow', affects: ['art'] });
    const b = await fx.p.board();
    expect(await fx.p.callTool('logic', 'getBoardItem', { id: b.facts[0]!.id })).toEqual(b.facts[0]);
    expect(await fx.p.callTool('logic', 'getBoardItem', { id: b.decisions[0]!.id })).toEqual(b.decisions[0]);
    expect(await fx.p.callTool('logic', 'getBoardItem', { id: b.failures[0]!.id })).toEqual(b.failures[0]);
    expect(await fx.p.callTool('logic', 'getBoardItem', { id: 'c1' })).toEqual(b.contracts[0]);
    // the interface key shown in briefs also works
    expect(await fx.p.callTool('logic', 'getBoardItem', { id: 'c1@1' })).toEqual(b.contracts[0]);
    expect(await fx.p.callTool('logic', 'getBoardItem', { id: 'art' })).toMatchObject({ id: 'art', title: 'Sprites' });
    await expect(fx.p.callTool('logic', 'getBoardItem', { id: 'nope' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  test('searchLedger finds chat messages and respects limit', async () => {
    const fx = await approved();
    await fx.p.ingest({ author: { kind: 'human', id: 'alice' }, text: 'We want a pastel palette' });
    await fx.p.ingest({ author: { kind: 'human', id: 'alice' }, text: 'Pastel again, softer' });
    const hits = (await fx.p.callTool('art', 'searchLedger', { query: 'pastel' })) as { body: { text: string } }[];
    expect(hits.map(h => h.body.text)).toEqual(['We want a pastel palette', 'Pastel again, softer']);
    expect(await fx.p.callTool('art', 'searchLedger', { query: 'pastel', limit: 1 })).toHaveLength(1);
    await expect(fx.p.callTool('art', 'searchLedger', { query: '' })).rejects.toMatchObject({ code: 'INVALID_OP' });
  });
});

describe('private notes stay private', () => {
  test('searchLedger never returns workspace notes or memories', async () => {
    const fx = await approved();
    await fx.p.callTool('art', 'updateNotes', { text: 'secret sauce' });
    await fx.p.callTool('art', 'updateNotes', { text: 'secret pinned sauce', pinned: true });
    await fx.p.commitRetro('art', [{ text: 'secret memory sauce' }]);
    for (const q of ['secret sauce', 'sauce', 'secret pinned', 'memory']) {
      expect(await fx.p.callTool('logic', 'searchLedger', { query: q })).toEqual([]);
      expect(await fx.p.callTool('art', 'searchLedger', { query: q })).toEqual([]);
    }
  });

  test('updateNotes pinned:true adds a pinned note; otherwise it appends to the notes', async () => {
    const fx = await approved();
    expect(await fx.p.callTool('art', 'updateNotes', { text: 'remember the palette', pinned: true })).toEqual({ wakes: [] });
    await fx.p.callTool('art', 'updateNotes', { text: 'draft idea' });
    const ws = (await fx.store.getWorkspace(fx.projectId, 'art'))!;
    expect(ws.pinnedNotes).toEqual(['remember the palette']);
    expect(ws.notes).toBe('draft idea');
    const brief = await fx.p.buildBrief('art', { maxTokens: 20_000, peek: true });
    expect(brief.segments.find(s => s.kind === 'workspace')!.text).toContain('remember the palette');
  });

  test('one bot cannot read another bot workspace through any tool', async () => {
    const fx = await approved();
    const SECRET = 'zebra-secret-notes';
    await fx.p.callTool('art', 'updateNotes', { text: SECRET });
    await fx.p.callTool('art', 'updateNotes', { text: `${SECRET} pinned`, pinned: true });
    const board = await fx.p.board();
    const attempts: [string, unknown][] = [
      ['searchLedger', { query: SECRET }],
      ['searchLedger', { query: 'zebra' }],
      ['getBoardItem', { id: 'art' }],
      ['getBoardItem', { id: 'c1' }],
      ['getBoardItem', { id: board.workstreams[0]!.id }],
      ['getDeliverable', { ref: 'x' }],
      ['submitDeliverable', { workstreamId: 'logic', summary: 's', content: 'c' }],
      ['proposeDecision', { text: 'd', rationale: 'r', affects: ['logic'] }],
      ['recordFailure', { text: 'f', reason: 'r', affects: ['logic'] }],
      ['promote', { kind: 'fact', text: 'f', affects: ['logic'] }],
      ['reportBlocked', { workstreamId: 'logic', reason: 'r' }],
      ['updateNotes', { text: 'logic note' }],
      ['sendMessage', { text: 'hi', act: 'inform' }],
    ];
    for (const [name, args] of attempts) {
      const out = await fx.p.callTool('logic', name, args).then(
        v => JSON.stringify(v),
        (e: unknown) => String(e instanceof ContextError ? `${e.message} ${JSON.stringify(e.details)}` : e),
      );
      expect(out, name).not.toContain('zebra');
    }
    // nor does the ledger or the board
    expect(JSON.stringify(await fx.store.read(fx.projectId, 1))).not.toContain('zebra');
    expect(JSON.stringify(await fx.p.board())).not.toContain('zebra');
    // and logic's own notes are its own
    expect((await fx.store.getWorkspace(fx.projectId, 'logic'))!.notes).toBe('logic note');
  });
});

describe('closed project', () => {
  test('write tools fail with PROJECT_CLOSED while read tools still work', async () => {
    const fx = await approved();
    await fx.p.close({ by: 'alice', force: true });
    await expect(fx.p.callTool('art', 'updateNotes', { text: 'n' })).rejects.toMatchObject({ code: 'PROJECT_CLOSED' });
    await expect(fx.p.callTool('art', 'sendMessage', { text: 'n', act: 'inform' })).rejects.toMatchObject({ code: 'PROJECT_CLOSED' });
    expect(await fx.p.callTool('art', 'searchLedger', { query: 'zzz' })).toEqual([]);
  });
});

describe('lead coordination tools (R33, R35)', () => {
  test('listPending returns the items waiting for the lead only', async () => {
    const fx = await approved();
    expect(await fx.p.callTool('pm', 'listPending', {})).toEqual([]);
    await fx.p.callTool('art', 'proposeDecision', { text: 'Palette is fixed', rationale: 'Consistency', affects: ['logic'] });
    await fx.p.submit('art', { type: 'proposal', ops: [{ op: 'setGoal', goal: 'Ship a big game' }] });
    const list = (await fx.p.callTool('pm', 'listPending', {})) as Record<string, unknown>[];
    expect(list).toEqual([
      {
        id: expect.any(String),
        by: 'art',
        needs: 'lead',
        ops: [expect.objectContaining({ op: 'addDecision' })],
        createdAt: expect.any(Number),
      },
    ]);
    await expect(fx.p.callTool('art', 'listPending', {})).rejects.toMatchObject({ code: 'FORBIDDEN' });
    // the lead resolves what it listed
    await fx.p.callTool('pm', 'resolveProposal', { pendingId: list[0]!.id, accept: true });
    expect(await fx.p.callTool('pm', 'listPending', {})).toEqual([]);
  });

  test('unblockWorkstream returns a blocked workstream to pending and activates it when ready', async () => {
    const fx = await approved();
    await fx.p.callTool('audio', 'reportBlocked', { workstreamId: 'audio', reason: 'No samples' });
    await expect(fx.p.callTool('audio', 'unblockWorkstream', { workstreamId: 'audio' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    const r = (await fx.p.callTool('pm', 'unblockWorkstream', { workstreamId: 'audio' })) as { wakes: { botId: string; reason: string }[] };
    expect(r.wakes).toEqual([expect.objectContaining({ botId: 'audio', reason: 'assigned' })]);
    expect((await fx.p.board()).workstreams.find(w => w.id === 'audio')!.status).toBe('active');
    // not blocked any more, or unknown
    await expect(fx.p.callTool('pm', 'unblockWorkstream', { workstreamId: 'audio' })).rejects.toMatchObject({ code: 'INVALID_OP' });
    await expect(fx.p.callTool('pm', 'unblockWorkstream', { workstreamId: 'nope' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  test('unblockWorkstream leaves a workstream with undelivered dependencies pending until they are delivered', async () => {
    const fx = await approved();
    await fx.p.callTool('logic', 'reportBlocked', { workstreamId: 'logic', reason: 'Rules unclear' });
    const r = (await fx.p.callTool('pm', 'unblockWorkstream', { workstreamId: 'logic' })) as { wakes: unknown[] };
    expect(r.wakes).toEqual([]);
    expect((await fx.p.board()).workstreams.find(w => w.id === 'logic')!.status).toBe('pending');
    await fx.p.callTool('art', 'submitDeliverable', { workstreamId: 'art', summary: 's', content: 'c' });
    const d = (await fx.p.board()).workstreams.find(w => w.id === 'art')!.deliverables[0]!;
    const review = (await fx.p.callTool('pm', 'submitReview', { deliverableId: d.id, passed: true, notes: 'ok' })) as {
      wakes: { botId: string; reason: string }[];
    };
    expect(review.wakes).toEqual(expect.arrayContaining([expect.objectContaining({ botId: 'logic', reason: 'upstreamDelivered' })]));
    expect((await fx.p.board()).workstreams.find(w => w.id === 'logic')!.status).toBe('active');
  });
});

describe('sendMessage default threading (R39a)', () => {
  type Sent = { entryId: string; wakes: { botId: string; reason: string }[] };
  const send = async (fx: FacadeProject, botId: string, args: Record<string, unknown>) =>
    (await fx.p.callTool(botId, 'sendMessage', args)) as Sent;
  const entryOf = async (fx: FacadeProject, id: string) => (await fx.store.read(fx.projectId, 1)).find(e => e.id === id)!;

  test('two bots ping-ponging requests without replyTo are threaded and stop at maxHops with needsLead', async () => {
    const fx = await approved();
    let prev = await send(fx, 'art', { text: 'can you check the tiles?', act: 'request', mentions: ['logic'] });
    expect(prev.wakes.map(w => [w.botId, w.reason])).toEqual([['logic', 'mentioned']]);
    for (let hop = 1; hop <= 3; hop++) {
      const [from, to] = hop % 2 === 1 ? ['logic', 'art'] : ['art', 'logic'];
      const next = await send(fx, from!, { text: `round ${hop}`, act: 'request', mentions: [to!] });
      expect((await entryOf(fx, next.entryId)).body).toMatchObject({ replyTo: prev.entryId, hops: hop });
      expect(next.wakes.map(w => [w.botId, w.reason])).toEqual([[to, 'mentioned']]);
      prev = next;
    }
    const last = await send(fx, 'art', { text: 'round 4', act: 'request', mentions: ['logic'] });
    expect((await entryOf(fx, last.entryId)).body).toMatchObject({ replyTo: prev.entryId, hops: 4 });
    expect(last.wakes.map(w => [w.botId, w.reason])).toEqual([['pm', 'needsLead']]);
  });

  test('an explicit replyTo wins over the default', async () => {
    const fx = await approved();
    await send(fx, 'art', { text: 'question?', act: 'query', mentions: ['logic'] });
    const h = await fx.p.ingest({ author: { kind: 'human', id: 'alice' }, text: 'context for everyone' });
    const r = await send(fx, 'logic', { text: 'answer', act: 'inform', replyTo: h.id });
    expect((await entryOf(fx, r.entryId)).body).toMatchObject({ replyTo: h.id, hops: 1 });
  });

  test('no default once the bot has spoken since the wake, or when it was never woken by chat', async () => {
    const fx = await approved();
    const q = await send(fx, 'art', { text: 'question?', act: 'query', mentions: ['logic'] });
    const a1 = await send(fx, 'logic', { text: 'answer', act: 'inform' });
    expect((await entryOf(fx, a1.entryId)).body).toMatchObject({ replyTo: q.entryId, hops: 1 });
    const a2 = await send(fx, 'logic', { text: 'one more thing', act: 'inform' });
    expect((await entryOf(fx, a2.entryId)).body).toMatchObject({ replyTo: undefined, hops: 0 });
    const loose = await send(fx, 'audio', { text: 'hello all', act: 'inform' });
    expect((await entryOf(fx, loose.entryId)).body).toMatchObject({ replyTo: undefined, hops: 0 });
  });

  test('the last wake entry survives a restart', async () => {
    const fx = await approved();
    const q = await send(fx, 'art', { text: 'question?', act: 'query', mentions: ['logic'] });
    fx.p.dispose();
    const p2 = createProject({ projectId: fx.projectId, store: fx.store, employees: createEmployeeRegistry({ store: fx.store }), clock: fx.clock });
    const r = (await p2.callTool('logic', 'sendMessage', { text: 'what size?', act: 'query' })) as Sent;
    const entry = (await fx.store.read(fx.projectId, 1)).find(e => e.id === r.entryId)!;
    expect(entry.body).toMatchObject({ replyTo: q.entryId, hops: 1 });
    expect(r.wakes.map(w => [w.botId, w.reason])).toEqual([['art', 'mentioned']]);
    p2.dispose();
  });
});
