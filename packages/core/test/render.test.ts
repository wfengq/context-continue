import { describe, expect, test } from 'vitest';
import {
  itemKey,
  renderBoardPublic,
  renderCommon,
  renderDelta,
  renderMemory,
  renderPlanning,
  renderProjection,
  renderRetro,
  renderReview,
  renderTrigger,
  renderWorkspace,
  type Projection,
} from '../src/render.js';
import type {
  AppliedOp,
  Contract,
  Decision,
  EmployeeMemory,
  Fact,
  Failure,
  Item,
  LedgerEntry,
  PlanProposal,
  ProjectBoard,
  Workspace,
  Workstream,
} from '../src/types.js';

const src = { entryIds: ['e1'], by: 'alice' };
const item = (id: string, text: string): Item => ({ id, text, source: src, authority: 'human' });
const ws = (id: string, title: string, owner: string, over: Partial<Workstream> = {}): Workstream => ({
  id,
  title,
  brief: `brief of ${id}`,
  owner,
  dependsOn: [],
  writeScopes: [],
  status: 'active',
  reviewRounds: 0,
  deliverables: [],
  ...over,
});
const dec = (id: string, text: string, rationale: string, over: Partial<Decision> = {}): Decision => ({
  ...item(id, text),
  rationale,
  rejected: [],
  affects: ['art'],
  ...over,
});

const art = ws('art', 'Art', 'art-bot');
const code = ws('code', 'Code', 'code-bot', { status: 'pending', dependsOn: ['art'] });
const c: Contract = { id: 'c1', from: 'art', to: 'code', spec: 'PNG sprites 64x64', version: 1 };
const d1 = dec('d1', 'Use pixel art style for every sprite in the whole game', 'Matches the brief', {
  rejected: ['vector', 'photo'],
  affects: ['art', 'code'],
});
const d2 = dec('d2', 'Palette is limited to 16 colors', 'Keeps files small');
const board: ProjectBoard = {
  projectId: 'p',
  version: 7,
  updatedAt: 1700000000000,
  status: 'active',
  owner: 'alice',
  lead: 'lead-bot',
  goal: 'Ship a tiny platformer',
  constraints: ['No network', 'Under 5MB'],
  planStatus: 'approved',
  conventions: [item('k1', 'snake_case file names')],
  workstreams: [art, code],
  contracts: [c],
  decisions: [d1, d2],
  facts: [],
  failures: [],
  openQuestions: [],
};
const fact: Fact = { ...item('f1', 'Engine is Phaser'), affects: ['art'] };
const failure: Failure = { ...item('x1', 'Tried SVG sprites'), reason: 'Renderer blurs them', affects: ['art'] };

const proj: Projection = {
  workstream: art,
  contracts: [c],
  decisions: [d1, d2],
  facts: [fact],
  failures: [failure],
  upstream: [
    {
      workstream: ws('concept', 'Concept', 'c-bot'),
      deliverable: { id: 'dv1', summary: 'Mood board', ref: 'store://dv1', version: 2 },
    },
  ],
  overlaps: [{ other: ws('ui', 'UI', 'ui-bot'), prefix: 'assets/' }],
};

const memory: EmployeeMemory = {
  botId: 'art-bot',
  persona: 'A careful pixel artist.\nLikes order.',
  skills: ['sprites', 'palettes'],
  memories: [
    { id: 'm1', text: 'old pinned lesson', fromProject: 'p0', createdAt: 1700000000000, pinned: true },
    { id: 'm2', text: 'recent one', fromProject: 'p0', createdAt: 1700000000001, pinned: false },
    { id: 'm3', text: 'recent two', fromProject: 'p0', createdAt: 1700000000002, pinned: false },
    { id: 'm4', text: 'recent three', fromProject: 'p0', createdAt: 1700000000003, pinned: false },
  ],
  condensed: 'Rolling summary of old work.',
};

const workspace: Workspace = {
  projectId: 'p',
  botId: 'art-bot',
  notes: 'first\n\nsecond\n\n\n  third  \n\nfourth',
  pinnedNotes: ['PIN A'],
  condensed: 'Condensed notes.',
  seenItemIds: [],
  lastSeenSeq: 0,
  lastSeenBoardVersion: 0,
  promotionsThisTurn: 0,
};

const chat = (seq: number, authorId: string, text: string, kind: 'human' | 'bot' = 'human'): LedgerEntry => ({
  id: `e${seq}`,
  projectId: 'p',
  seq,
  createdAt: 1700000000000 + seq,
  author: { kind, id: authorId },
  body: { type: 'chat', text, mentions: [], hops: 0 },
});

describe('renderCommon', () => {
  const members = [
    { id: 'alice', kind: 'human' as const, role: 'owner' },
    { id: 'art-bot', kind: 'bot' as const, role: 'artist' },
  ];
  test('lists members one per line under the Team heading', () => {
    const t = renderCommon(members);
    expect(t.startsWith('# Team\n')).toBe(true);
    expect(t).toContain('- alice (human): owner');
    expect(t).toContain('- art-bot (bot): artist');
  });
  test('is deterministic and empty roster says nothing yet', () => {
    expect(renderCommon(structuredClone(members))).toBe(renderCommon(members));
    expect(renderCommon([])).toContain('(nothing yet)');
  });
});

describe('renderBoardPublic', () => {
  test('byte-identical for the same board regardless of input array identity', () => {
    expect(renderBoardPublic(structuredClone(board), structuredClone(board.workstreams))).toBe(
      renderBoardPublic(board, board.workstreams),
    );
  });
  test('contains goal, constraints, conventions and the workstream list only', () => {
    const t = renderBoardPublic(board, board.workstreams);
    expect(t.startsWith('# Project\n')).toBe(true);
    expect(t).toContain(board.goal);
    expect(t).toContain('No network');
    expect(t).toContain('- [k1] snake_case file names');
    expect(t).toContain('art | Art | art-bot | active');
    expect(t).toContain('code | Code | code-bot | pending');
    expect(t).not.toContain(d1.rationale);
    expect(t).not.toContain('PNG sprites');
  });
  test('empty lists render nothing yet', () => {
    const t = renderBoardPublic({ ...board, constraints: [], conventions: [] }, []);
    expect(t.match(/\(nothing yet\)/g)?.length).toBe(3);
  });
});

describe('itemKey', () => {
  test('contract key changes when version changes', () => {
    expect(itemKey({ ...c, version: 2 })).not.toBe(itemKey(c));
    expect(itemKey(c)).toBe('c1@1');
  });
  test('plain items use id', () => {
    expect(itemKey(d1)).toBe('d1');
  });
});

describe('renderProjection', () => {
  test('shows unseen items in full and seen items compactly', () => {
    const { text, shownKeys } = renderProjection(proj, new Set(['d1']));
    expect(text).toMatch(/\[d1\] .{1,40} \(seen\)/);
    expect(text).toContain(`- [d1] ${Array.from(d1.text).slice(0, 40).join('')} (seen)`);
    expect(text).toContain(d2.rationale);
    expect(shownKeys).toContain('d2');
    expect(shownKeys).not.toContain('d1');
    expect(shownKeys).toContain('c1@1');
    expect(shownKeys).toContain('f1');
    expect(shownKeys).toContain('x1');
  });
  test('compact line takes the first 40 code points of the first line', () => {
    const long = dec('d9', `${'😀'.repeat(45)}\nsecond line`, 'r');
    const { text } = renderProjection({ ...proj, decisions: [long] }, new Set(['d9']));
    expect(text).toContain(`- [d9] ${'😀'.repeat(40)} (seen)`);
    expect(text).not.toContain('second line');
  });
  test('full decision format', () => {
    const { text } = renderProjection(proj, new Set());
    expect(text).toContain(
      '- [d1] Use pixel art style for every sprite in the whole game\n  why: Matches the brief\n  rejected: vector; photo\n  affects: art, code',
    );
    expect(text).toContain('- [d2] Palette is limited to 16 colors\n  why: Keeps files small\n  affects: art');
    expect(text).not.toContain('rejected: \n');
  });
  test('failure, fact and contract formats', () => {
    const { text } = renderProjection(proj, new Set());
    expect(text).toContain('- [f1] Engine is Phaser');
    expect(text).toContain('- [x1] tried: Tried SVG sprites\n  why it failed: Renderer blurs them\n  affects: art');
    expect(text).toContain('- [c1@v1] art -> code: PNG sprites 64x64');
  });
  test('a changed contract version is shown in full again', () => {
    const seen = new Set([itemKey(c)]);
    expect(renderProjection(proj, seen).text).toContain('- [c1@v1] art -> code (seen)');
    const { text, shownKeys } = renderProjection({ ...proj, contracts: [{ ...c, version: 2 }] }, seen);
    expect(text).toContain('- [c1@v2] art -> code: PNG sprites 64x64');
    expect(shownKeys).toContain('c1@2');
  });
  test('upstream deliverables appear as summary and ref, never full content', () => {
    const { text } = renderProjection(proj, new Set());
    expect(text).toContain('- concept delivered v2: Mood board (ref: store://dv1)');
  });
  test('overlaps', () => {
    const { text } = renderProjection(proj, new Set());
    expect(text).toContain('- overlaps with ui (ui-bot) on assets/');
  });
  test('null workstream renders the no-part line', () => {
    const r = renderProjection({ ...proj, workstream: null }, new Set());
    expect(r.text).toBe('# Your part\n\nNo part assigned yet.');
    expect(r.shownKeys).toEqual([]);
  });
  test('empty subsections say nothing yet', () => {
    const { text } = renderProjection(
      { workstream: art, contracts: [], decisions: [], facts: [], failures: [], upstream: [], overlaps: [] },
      new Set(),
    );
    expect(text.match(/\(nothing yet\)/g)?.length).toBe(6);
  });
  test('deterministic', () => {
    expect(renderProjection(structuredClone(proj), new Set(['d1'])).text).toBe(renderProjection(proj, new Set(['d1'])).text);
  });
});

describe('renderMemory', () => {
  test('renders pinned, condensed, then the last recentKeep non-pinned memories', () => {
    const t = renderMemory(memory, 2);
    expect(t.startsWith('# Your memory\n')).toBe(true);
    const iPin = t.indexOf('old pinned lesson');
    const iSum = t.indexOf('Summary:');
    const iCond = t.indexOf('Rolling summary of old work.');
    const iTwo = t.indexOf('recent two');
    const iThree = t.indexOf('recent three');
    expect(iPin).toBeGreaterThan(-1);
    expect(iPin).toBeLessThan(iSum);
    expect(iSum).toBeLessThan(iCond);
    expect(iCond).toBeLessThan(iTwo);
    expect(iTwo).toBeLessThan(iThree);
    expect(t).not.toContain('recent one');
    expect(t).toContain('- sprites');
    expect(t).toContain('A careful pixel artist.');
  });
  test('recentKeep 0 keeps no recent memories; empty memory says nothing yet', () => {
    expect(renderMemory(memory, 0)).not.toContain('recent three');
    expect(renderMemory({ botId: 'b', persona: '', skills: [], memories: [], condensed: '' }, 5)).toBe(
      '# Your memory\n\n(nothing yet)',
    );
  });
});

describe('renderWorkspace', () => {
  test('pinned, summary, then the last recentKeep paragraphs', () => {
    const t = renderWorkspace(workspace, 2);
    expect(t.startsWith('# Your notes\n')).toBe(true);
    expect(t.indexOf('PIN A')).toBeLessThan(t.indexOf('Summary:'));
    expect(t.indexOf('Summary:')).toBeLessThan(t.indexOf('Condensed notes.'));
    expect(t.indexOf('Condensed notes.')).toBeLessThan(t.indexOf('third'));
    expect(t.indexOf('third')).toBeLessThan(t.indexOf('fourth'));
    expect(t).not.toContain('first');
    expect(t).not.toContain('second');
    expect(t).toContain('- third');
  });
  test('empty condensed omits Summary; fully empty says nothing yet', () => {
    expect(renderWorkspace({ ...workspace, condensed: '' }, 5)).not.toContain('Summary:');
    expect(renderWorkspace({ ...workspace, notes: '', pinnedNotes: [], condensed: '' }, 5)).toBe(
      '# Your notes\n\n(nothing yet)',
    );
  });
});

describe('renderDelta', () => {
  const ev: LedgerEntry = {
    id: 'e5',
    projectId: 'p',
    seq: 5,
    createdAt: 1,
    author: { kind: 'system', id: 'system' },
    body: { type: 'event', event: { kind: 'blocked', workstreamId: 'art', reason: 'no palette' } },
  };
  const change: AppliedOp = {
    op: { op: 'setGoal', goal: 'x' },
    by: 'alice',
    authority: 'human',
    touched: ['goal', 'k1'],
  };
  test('chat, event and change lines', () => {
    const t = renderDelta([chat(4, 'alice', 'hi there'), ev], [change]);
    expect(t.startsWith('# Since you last looked\n')).toBe(true);
    expect(t).toContain('- #4 alice: hi there');
    expect(t).toContain('- #5 [blocked] {"workstreamId":"art","reason":"no palette"}');
    expect(t).toContain('- board: setGoal by alice (goal, k1)');
    expect(t.indexOf('#5')).toBeLessThan(t.indexOf('- board:'));
  });
  test('empty says nothing yet', () => {
    expect(renderDelta([], [])).toBe('# Since you last looked\n\n(nothing yet)');
  });
});

describe('renderTrigger', () => {
  test('reason then detail', () => {
    expect(renderTrigger('mentioned', 'alice asked: status?')).toBe(
      '# Why you are awake\n\nreason: mentioned\nalice asked: status?',
    );
    expect(renderTrigger('manual', '')).toBe('# Why you are awake\n\nreason: manual');
  });
});

describe('renderPlanning', () => {
  const plan: PlanProposal = {
    id: 'pp1',
    projectId: 'p',
    by: 'lead-bot',
    workstreams: [{ id: 'art', title: 'Art', brief: 'b', owner: 'art-bot', dependsOn: [], writeScopes: [] }],
    contracts: [{ id: 'c1', from: 'art', to: 'code', spec: 'PNG' }],
    status: 'rejected',
    rejectCount: 1,
  };
  const roster = [
    { botId: 'art-bot', persona: 'Pixel artist\nsecond line', skills: ['sprites'] },
    { botId: 'code-bot', persona: 'Coder', skills: [] },
  ];
  test('lists every roster member (persona first line) and the previous plan feedback', () => {
    const t = renderPlanning({
      board,
      roster,
      humanMessages: [chat(1, 'alice', 'Make a platformer')],
      previous: { plan, feedback: 'Split art into two parts' },
    });
    expect(t).toContain(board.goal);
    expect(t).toContain('- art-bot: Pixel artist (skills: sprites)');
    expect(t).not.toContain('second line');
    expect(t).toContain('- code-bot: Coder');
    expect(t).toContain('- #1 alice: Make a platformer');
    expect(t).toContain('Split art into two parts');
    expect(t).toContain('- [c1] art -> code: PNG');
  });
  test('without previous plan there is no feedback section', () => {
    const t = renderPlanning({ board, roster, humanMessages: [] });
    expect(t).not.toContain('Previous plan');
    expect(t).toContain('(nothing yet)');
  });
});

describe('renderReview', () => {
  test('starts with the conventions-and-contracts-only instruction and includes the full content', () => {
    const content = 'FULL DELIVERABLE TEXT\nline two';
    const t = renderReview({
      content,
      workstream: art,
      contracts: [c],
      conventions: board.conventions,
      decisions: [d1],
    });
    expect(t.startsWith('Check only whether the content violates')).toBe(true);
    expect(t).toContain(content);
    expect(t).toContain('- [k1] snake_case file names');
    expect(t).toContain('- [c1@v1] art -> code: PNG sprites 64x64');
    expect(t).toContain(d1.rationale);
  });
});

describe('renderRetro', () => {
  test('includes workspace, memory, reviews and workstream', () => {
    const rv: LedgerEntry = {
      id: 'e9',
      projectId: 'p',
      seq: 9,
      createdAt: 1,
      author: { kind: 'system', id: 'system' },
      body: { type: 'event', event: { kind: 'reviewFailed', deliverableId: 'dv1', notes: 'wrong size' } },
    };
    const t = renderRetro({ workspace, workstream: art, reviews: [rv], memory });
    expect(t.startsWith('# Retrospective\n')).toBe(true);
    expect(t).toContain('PIN A');
    expect(t).toContain('first');
    expect(t).toContain('old pinned lesson');
    expect(t).toContain('[reviewFailed]');
    expect(t).toContain('art | Art | art-bot | active');
  });
  test('null workstream and no reviews', () => {
    const t = renderRetro({ workspace, workstream: null, reviews: [], memory });
    expect(t).toContain('No part assigned yet.');
    expect(t).toContain('(nothing yet)');
  });
});

describe('volatile content', () => {
  test('no timestamps in common, board or memory sections', () => {
    const t = [
      renderCommon([{ id: 'a', kind: 'bot', role: 'r' }]),
      renderBoardPublic(board, board.workstreams),
      renderMemory(memory, 5),
    ].join('\n');
    expect(t).not.toMatch(/\d{10,}/);
  });
});
