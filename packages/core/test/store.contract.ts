import { expect, test } from 'vitest';
import type { Store } from '../src/store/store.js';
import type {
  BoardChange,
  EmployeeMemory,
  LedgerEntry,
  PendingProposal,
  PlanProposal,
  Proposal,
  ProjectBoard,
  Workspace,
} from '../src/types.js';

type NewEntry = Omit<LedgerEntry, 'seq'>;

let counter = 0;
const uid = (p: string) => `${p}-${++counter}`;

function chat(projectId: string, text: string): NewEntry {
  return {
    id: uid('e'),
    projectId,
    createdAt: 1000,
    author: { kind: 'human', id: 'alice' },
    body: { type: 'chat', text, mentions: [], hops: 0 },
  };
}

function archived(projectId: string, ref: string): NewEntry {
  return {
    id: uid('e'),
    projectId,
    createdAt: 1000,
    author: { kind: 'system', id: 'core' },
    body: { type: 'event', event: { kind: 'archived', what: 'decisions', ref } },
  };
}

function started(projectId: string): NewEntry {
  return {
    id: uid('e'),
    projectId,
    createdAt: 1000,
    author: { kind: 'system', id: 'core' },
    body: { type: 'event', event: { kind: 'projectStarted' } },
  };
}

function board(projectId: string): ProjectBoard {
  return {
    projectId,
    version: 0,
    updatedAt: 0,
    status: 'active',
    owner: 'alice',
    lead: 'lead-bot',
    goal: 'ship it',
    constraints: [],
    planStatus: 'none',
    conventions: [],
    workstreams: [],
    contracts: [],
    decisions: [],
    facts: [],
    failures: [],
    openQuestions: [],
  };
}

function change(version: number): BoardChange {
  return {
    version,
    mergedAt: 2000 + version,
    ops: [{ op: { op: 'setGoal', goal: `goal ${version}` }, by: 'alice', authority: 'human', touched: [] }],
  };
}

function ws(projectId: string, botId: string): Workspace {
  return {
    projectId,
    botId,
    notes: 'n',
    pinnedNotes: [],
    condensed: '',
    seenItemIds: [],
    lastSeenSeq: 0,
    lastSeenBoardVersion: 0,
    promotionsThisTurn: 0,
  };
}

function memory(botId: string): EmployeeMemory {
  return { botId, persona: 'p', skills: ['s'], memories: [], condensed: '' };
}

function proposal(projectId: string, id: string): Proposal {
  return {
    id,
    projectId,
    baseVersion: 0,
    by: 'bot-a',
    ops: [{ op: 'setGoal', goal: 'g' }],
  };
}

function pending(projectId: string, id: string, createdAt: number): PendingProposal {
  return {
    id,
    projectId,
    proposalId: `prop-${id}`,
    by: 'bot-a',
    ops: [{ op: 'setGoal', goal: 'g' }],
    needs: 'lead',
    createdAt,
  };
}

function plan(projectId: string, id: string): PlanProposal {
  return {
    id,
    projectId,
    by: 'lead-bot',
    workstreams: [{ id: 'w1', title: 'T', brief: 'B', owner: 'bot-a', dependsOn: [], writeScopes: [] }],
    contracts: [],
    status: 'pending',
    rejectCount: 0,
  };
}

export function runStoreContract(name: string, make: () => Promise<Store>): void {
  test(`[${name}] append assigns consecutive seq per project`, async () => {
    const s = await make();
    const a = await s.append(chat('p1', 'hi'));
    const b = await s.append(chat('p1', 'yo'));
    const c = await s.append(chat('p2', 'x'));
    expect([a.seq, b.seq, c.seq]).toEqual([1, 2, 1]);
    expect((await s.read('p1', 2)).map(e => e.seq)).toEqual([2]);
    expect(await s.latestSeq('p1')).toBe(2);
  });

  test(`[${name}] latestSeq of an unknown project is 0 and read honours fromSeq and limit`, async () => {
    const s = await make();
    expect(await s.latestSeq('nope')).toBe(0);
    expect(await s.read('nope', 0)).toEqual([]);
    for (const t of ['a', 'b', 'c', 'd']) await s.append(chat('p1', t));
    expect((await s.read('p1', 0)).map(e => e.seq)).toEqual([1, 2, 3, 4]);
    expect((await s.read('p1', 2, 2)).map(e => e.seq)).toEqual([2, 3]);
    expect((await s.read('p1', 5)).map(e => e.seq)).toEqual([]);
  });

  test(`[${name}] saveBoard rejects stale version and stores change atomically`, async () => {
    const s = await make();
    await s.createBoard(board('p1')); // version 0
    await s.saveBoard({ ...board('p1'), version: 1 }, 0, change(1));
    await expect(s.saveBoard({ ...board('p1'), version: 2 }, 0, change(2))).rejects.toMatchObject({
      code: 'STALE_VERSION',
    });
    expect((await s.getBoard('p1')).version).toBe(1);
    expect((await s.getBoardChanges('p1', 0)).map(c => c.version)).toEqual([1]);
  });

  test(`[${name}] getBoardChanges returns only versions after sinceVersion, in order`, async () => {
    const s = await make();
    await s.createBoard(board('p1'));
    for (let v = 1; v <= 3; v++) await s.saveBoard({ ...board('p1'), version: v }, v - 1, change(v));
    expect((await s.getBoardChanges('p1', 1)).map(c => c.version)).toEqual([2, 3]);
    expect(await s.getBoardChanges('p1', 3)).toEqual([]);
    expect(await s.getBoardChanges('p2', 0)).toEqual([]);
  });

  test(`[${name}] getBoard throws NOT_FOUND and createBoard twice throws INVALID_OP`, async () => {
    const s = await make();
    await expect(s.getBoard('p1')).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await s.createBoard(board('p1'));
    await expect(s.createBoard(board('p1'))).rejects.toMatchObject({ code: 'INVALID_OP' });
    expect((await s.getBoard('p1')).projectId).toBe('p1');
  });

  test(`[${name}] saveBoard on a missing board throws NOT_FOUND`, async () => {
    const s = await make();
    await expect(s.saveBoard({ ...board('p1'), version: 1 }, 0, change(1))).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  test(`[${name}] search finds chat text and archived refs, case-insensitive`, async () => {
    const s = await make();
    await s.append(chat('p1', 'We should use the Pixel font'));
    await s.append(chat('p1', 'unrelated'));
    await s.append(archived('p1', '{"text":"old PIXEL decision"}'));
    await s.append(started('p1'));
    await s.append(chat('p2', 'pixel in another project'));
    const hits = await s.search('p1', 'pixel');
    expect(hits).toHaveLength(2);
    expect(hits.map(h => h.body.type)).toEqual(['chat', 'event']);
    expect((await s.search('p1', 'PiXeL', 1)).length).toBe(1);
    expect(await s.search('p1', 'absent')).toEqual([]);
  });

  test(`[${name}] search requires every whitespace-separated word, in any order and position`, async () => {
    const s = await make();
    await s.append(chat('p1', 'the pixel art needs a bigger sound effect'));
    await s.append(chat('p1', 'only pixel here'));
    await s.append(chat('p1', 'only sound here'));
    const hits = await s.search('p1', '  SOUND   pixel ');
    expect(hits).toHaveLength(1);
    expect(hits[0]!.body.type === 'chat' && hits[0]!.body.text).toBe('the pixel art needs a bigger sound effect');
    // mixes a short (< 3 chars) word with a long one
    expect((await s.search('p1', 'o pixel')).map(h => h.seq)).toEqual([1, 2]);
  });

  test(`[${name}] search takes punctuation literally and never throws`, async () => {
    const s = await make();
    await s.append(chat('p1', 'we use C++ and "quoted" -x:y syntax'));
    await s.append(chat('p1', 'plain text'));
    expect((await s.search('p1', 'C++ "quoted" -x:y')).map(h => h.seq)).toEqual([1]);
    expect(await s.search('p1', '"nomatch')).toEqual([]);
    expect(await s.search('p1', 'NEAR( AND OR *')).toEqual([]);
    expect(await s.search('p1', '100% _ \\')).toEqual([]);
  });

  test(`[${name}] search treats LIKE wildcards in short words literally`, async () => {
    const s = await make();
    await s.append(chat('p1', 'progress 50% done'));
    await s.append(chat('p1', 'some_name here'));
    await s.append(chat('p1', 'abc'));
    expect((await s.search('p1', '0%')).map(h => h.seq)).toEqual([1]);
    expect((await s.search('p1', 'e_n')).map(h => h.seq)).toEqual([2]);
    expect(await s.search('p1', '%')).toHaveLength(1);
    expect(await s.search('p1', 'a_')).toEqual([]);
  });

  test(`[${name}] search finds a 2-character CJK word and returns hits oldest first`, async () => {
    const s = await make();
    await s.append(chat('p1', '音效再大一点'));
    await s.append(chat('p1', '无关'));
    await s.append(archived('p1', '{"text":"调整音效"}'));
    await s.append(chat('p1', '音效很好，背景音乐也不错'));
    expect((await s.search('p1', '音效')).map(h => h.seq)).toEqual([1, 3, 4]);
    expect((await s.search('p1', '音效 背景音乐')).map(h => h.seq)).toEqual([4]);
    expect((await s.search('p1', '音效', 2)).map(h => h.seq)).toEqual([1, 3]);
  });

  test(`[${name}] search with an empty or whitespace-only query returns nothing`, async () => {
    const s = await make();
    await s.append(chat('p1', 'something'));
    expect(await s.search('p1', '')).toEqual([]);
    expect(await s.search('p1', '   \t\n ')).toEqual([]);
  });

  test(`[${name}] drainProposals empties the queue`, async () => {
    const s = await make();
    await s.enqueueProposal(proposal('p1', 'a'));
    await s.enqueueProposal(proposal('p1', 'b'));
    await s.enqueueProposal(proposal('p2', 'c'));
    const first = await s.drainProposals('p1');
    expect(first.map(p => p.id)).toEqual(['a', 'b']);
    expect(await s.drainProposals('p1')).toEqual([]);
    expect((await s.drainProposals('p2')).map(p => p.id)).toEqual(['c']);
  });

  test(`[${name}] plan proposals round-trip`, async () => {
    const s = await make();
    expect(await s.getPlanProposal('x')).toBeNull();
    await s.savePlanProposal(plan('p1', 'x'));
    await s.savePlanProposal({ ...plan('p1', 'x'), status: 'rejected', rejectCount: 1 });
    expect(await s.getPlanProposal('x')).toMatchObject({ status: 'rejected', rejectCount: 1 });
  });

  test(`[${name}] pending list ordered by createdAt and deletable`, async () => {
    const s = await make();
    await s.savePending(pending('p1', 'late', 30));
    await s.savePending(pending('p1', 'early', 10));
    await s.savePending(pending('p1', 'mid', 20));
    await s.savePending(pending('p2', 'other', 5));
    expect((await s.listPending('p1')).map(p => p.id)).toEqual(['early', 'mid', 'late']);
    await s.deletePending('mid');
    expect((await s.listPending('p1')).map(p => p.id)).toEqual(['early', 'late']);
    await s.deletePending('does-not-exist');
    await s.savePending(pending('p1', 'tie-b', 40));
    await s.savePending(pending('p1', 'tie-a', 40));
    expect((await s.listPending('p1')).map(p => p.id)).toEqual(['early', 'late', 'tie-b', 'tie-a']);
    expect((await s.listPending('p2')).map(p => p.id)).toEqual(['other']);
  });

  test(`[${name}] workspace and memory are isolated by key`, async () => {
    const s = await make();
    await s.saveWorkspace(ws('p1', 'art'));
    expect(await s.getWorkspace('p1', 'logic')).toBeNull();
    expect(await s.getWorkspace('p2', 'art')).toBeNull();
    expect((await s.getWorkspace('p1', 'art'))?.notes).toBe('n');
    await s.saveMemory(memory('art'));
    expect(await s.getMemory('logic')).toBeNull();
    expect((await s.getMemory('art'))?.persona).toBe('p');
  });

  test(`[${name}] listMemories returns every saved memory`, async () => {
    const s = await make();
    expect(await s.listMemories()).toEqual([]);
    await s.saveMemory(memory('a'));
    await s.saveMemory(memory('b'));
    await s.saveMemory({ ...memory('a'), persona: 'updated' });
    const all = await s.listMemories();
    expect(all.map(m => m.botId).sort()).toEqual(['a', 'b']);
    expect(all.find(m => m.botId === 'a')?.persona).toBe('updated');
  });

  test(`[${name}] reads return copies`, async () => {
    const s = await make();
    await s.createBoard(board('p1'));
    const b = await s.getBoard('p1');
    b.goal = 'mutated';
    b.constraints.push('x');
    expect((await s.getBoard('p1')).goal).toBe('ship it');
    expect((await s.getBoard('p1')).constraints).toEqual([]);

    const e = await s.append(chat('p1', 'orig'));
    if (e.body.type === 'chat') e.body.text = 'mutated';
    const [read] = await s.read('p1', 1);
    expect(read!.body.type === 'chat' && read!.body.text).toBe('orig');

    await s.saveWorkspace(ws('p1', 'art'));
    const w = await s.getWorkspace('p1', 'art');
    w!.notes = 'mutated';
    expect((await s.getWorkspace('p1', 'art'))!.notes).toBe('n');

    // inputs are copied too
    const input = board('p2');
    await s.createBoard(input);
    input.goal = 'mutated after create';
    expect((await s.getBoard('p2')).goal).toBe('ship it');
  });

  test(`[${name}] deliverables round-trip by ref`, async () => {
    const s = await make();
    const r1 = await s.putDeliverable('p1', 'hello world');
    const r2 = await s.putDeliverable('p1', 'second');
    expect(r1).not.toBe(r2);
    expect(await s.getDeliverable('p1', r1)).toBe('hello world');
    expect(await s.getDeliverable('p1', r2)).toBe('second');
    await expect(s.getDeliverable('p2', r1)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(s.getDeliverable('p1', 'missing')).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  test(`[${name}] meta round-trip`, async () => {
    const s = await make();
    expect(await s.getMeta('p1', 'k')).toBeNull();
    await s.setMeta('p1', 'k', { a: [1, 2] });
    expect(await s.getMeta('p1', 'k')).toEqual({ a: [1, 2] });
    expect(await s.getMeta('p2', 'k')).toBeNull();
    await s.setMeta('p1', 'k', 5);
    expect(await s.getMeta<number>('p1', 'k')).toBe(5);
  });
}
