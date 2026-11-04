import { beforeEach, describe, expect, test } from 'vitest';
import { buildBrief, confirmSeen, selectProjection } from '../src/brief.js';
import { BudgetTooSmallError } from '../src/errors.js';
import { splitParagraphs } from '../src/render.js';
import { defaultCountTokens } from '../src/tokens.js';
import type { ContextBundle, SegmentKind, WakeReason } from '../src/types.js';
import { makeProject, seedProject, TEST_TOOLS, type FacadeProject, type SeededProject } from './helpers.js';

let p: SeededProject;

type BriefOpts = { maxTokens?: number; peek?: boolean; trigger?: { reason: WakeReason | 'manual'; detail: string } };
const brief = (botId: string, o: BriefOpts = {}) => buildBrief(p.deps, botId, { maxTokens: 100_000, ...o });
const seg = (b: ContextBundle, kind: SegmentKind) => b.segments.find(s => s.kind === kind)!.text;
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

beforeEach(async () => {
  p = await seedProject();
});

describe('buildBrief', () => {
  test('brief segments are ordered stable-first and the first four are cacheable', async () => {
    const b = await brief('art');
    expect(b.segments.map(s => s.kind)).toEqual(['common', 'memory', 'workspace', 'board', 'projection', 'delta', 'trigger']);
    expect(b.segments.map(s => s.cacheable)).toEqual([true, true, true, true, false, false, false]);
  });

  test('common and board segments are byte-identical across bots at the same version', async () => {
    const [a, l] = [await brief('art', { peek: true }), await brief('logic', { peek: true })];
    expect(seg(a, 'common')).toBe(seg(l, 'common'));
    expect(seg(a, 'board')).toBe(seg(l, 'board'));
  });

  test('common lists the human owner and bot members with the first persona line as role', async () => {
    const common = seg(await brief('art'), 'common');
    expect(common).toContain('- alice (human): owner');
    expect(common).toContain('- pm (bot): Project lead');
    expect(common).toContain('- art (bot): Pixel artist');
    expect(common).toContain('- logic (bot): Gameplay programmer');
    expect(common).toContain('- audio (bot): Sound designer');
    expect(common).not.toContain('Draws sprites');
    expect(seg(await brief('art'), 'board')).toContain('art | Sprites | art | active');
  });

  test('projection only includes decisions affecting own workstreams', async () => {
    await p.decide({ affects: ['logic'], text: 'gravity 9.8' });
    expect(seg(await brief('logic'), 'projection')).toContain('gravity 9.8');
    expect(seg(await brief('audio'), 'projection')).not.toContain('gravity 9.8');
  });

  test('projection selects own contracts, facts, failures, upstream deliverables', async () => {
    await p.apply([
      { op: 'addFact', fact: { text: 'tiles are 16px', affects: ['art'], source: { entryIds: [], by: 'alice' } } },
      {
        op: 'addFailure',
        failure: { text: 'tried WAV', reason: 'too large', affects: ['audio'], source: { entryIds: [], by: 'alice' } },
      },
      { op: 'addDeliverable', workstreamId: 'art', summary: 'hero sprite sheet', ref: 'ref-hero' },
    ]);
    const logic = seg(await brief('logic'), 'projection');
    expect(logic).toContain('[c1@v1] art -> logic: PNG sprite sheets');
    expect(logic).toContain('art delivered v1: hero sprite sheet (ref: ref-hero)');
    expect(logic).not.toContain('tiles are 16px');
    expect(logic).not.toContain('tried WAV');
    const art = seg(await brief('art'), 'projection');
    expect(art).toContain('tiles are 16px');
    expect(art).toContain('[c1@v1]');
    expect(art).toContain('## Upstream deliverables\n(nothing yet)');
    const audio = seg(await brief('audio'), 'projection');
    expect(audio).toContain('tried: tried WAV');
    expect(audio).not.toContain('c1@v1');
  });

  test('selectProjection picks the bot workstream items; null workstream for a bot owning none', async () => {
    await p.decide({ affects: ['art', 'logic'], text: 'shared decision' });
    const board = await p.store.getBoard(p.projectId);
    const pr = selectProjection(board, board.workstreams, 'logic', []);
    expect(pr.workstream?.id).toBe('logic');
    expect(pr.contracts.map(c => c.id)).toEqual(['c1']);
    expect(pr.decisions.map(d => d.text)).toEqual(['shared decision']);
    expect(pr.upstream).toEqual([]);
    expect(selectProjection(board, board.workstreams, 'pm', []).workstream).toBeNull();
  });

  test('second brief shows a seen decision compactly; superseding it shows the new one in full', async () => {
    const id = await p.decide({ affects: ['art'], text: 'Use a 16-color palette', rationale: 'keeps the look coherent' });
    const first = seg(await brief('art'), 'projection');
    expect(first).toContain(`[${id}] Use a 16-color palette`);
    expect(first).toContain('why: keeps the look coherent');
    expect(first).toContain('[c1@v1] art -> logic: PNG sprite sheets');
    await confirmSeen(p.store, p.projectId, 'art'); // what callTool does: the bot acted on the brief

    const second = seg(await brief('art'), 'projection');
    expect(second).toContain(`[${id}] Use a 16-color palette (seen)`);
    expect(second).not.toContain('keeps the look coherent');
    expect(second).toContain('[c1@v1] art -> logic (seen)');

    const [newId] = await p.apply([
      { op: 'supersede', section: 'decisions', id, item: { text: 'Use a 32-color palette', rationale: 'more shading', source: { entryIds: [], by: 'alice' } } },
      { op: 'updateContract', id: 'c1', spec: 'PNG sprite sheets, 32x32 tiles' },
    ]);
    const third = seg(await brief('art'), 'projection');
    expect(third).toContain(`[${newId}] Use a 32-color palette`);
    expect(third).toContain('why: more shading');
    expect(third).not.toContain(`[${id}]`);
    expect(third).toContain('[c1@v2] art -> logic: PNG sprite sheets, 32x32 tiles');
    await confirmSeen(p.store, p.projectId, 'art');

    const ws = (await p.store.getWorkspace(p.projectId, 'art'))!;
    expect(ws.seenItemIds).toContain(newId);
    expect(ws.seenItemIds).toContain('c1@2');
  });

  test('peek does not mark anything as seen or advance pointers', async () => {
    await p.decide({ affects: ['art'], text: 'palette decision', rationale: 'R1' });
    await brief('art', { peek: true });
    expect(await p.store.getWorkspace(p.projectId, 'art')).toBeNull();
    expect(seg(await brief('art', { peek: true }), 'projection')).toContain('why: R1');

    await brief('art'); // creates the workspace and marks the decision pending
    await p.chat({ author: { kind: 'human', id: 'alice' }, text: 'hero should be blue', mentions: ['art'] });
    await p.decide({ affects: ['art'], text: 'second decision', rationale: 'R2' });
    const before = await p.store.getWorkspace(p.projectId, 'art');
    for (let i = 0; i < 2; i++) {
      const b = await brief('art', { peek: true });
      expect(seg(b, 'delta')).toContain('hero should be blue');
      expect(seg(b, 'delta')).toContain('board: addDecision');
      expect(seg(b, 'projection')).toContain('why: R2');
    }
    expect(await p.store.getWorkspace(p.projectId, 'art')).toEqual(before);
  });

  test('a new member starts from the latest seq and gets no board-change history', async () => {
    await p.chat({ author: { kind: 'human', id: 'alice' }, text: 'old news for art', mentions: ['art'] });
    await p.decide({ affects: ['art'], text: 'early decision' });
    const b = await brief('art');
    expect(seg(b, 'delta')).toBe('# Since you last looked\n\n(nothing yet)');
    expect(seg(b, 'projection')).toContain('early decision');
    const ws = (await p.store.getWorkspace(p.projectId, 'art'))!;
    expect(ws.lastSeenSeq).toBe(await p.store.latestSeq(p.projectId));
    expect(ws.lastSeenBoardVersion).toBe((await p.store.getBoard(p.projectId)).version);
  });

  test('delta lists only relevant entries since the last brief', async () => {
    await brief('art');
    await brief('audio');
    const own = await p.chat({ author: { kind: 'bot', id: 'art' }, text: 'drafting the Sprites for the hero now', act: 'inform' });
    const blue = await p.chat({ author: { kind: 'human', id: 'alice' }, text: 'hero should be blue', mentions: ['art'] });
    await p.chat({ author: { kind: 'human', id: 'alice' }, text: 'looks great so far', replyTo: own.id });
    await p.chat({ author: { kind: 'human', id: 'alice' }, text: 'the Sound needs more bass' });
    await p.event({ kind: 'deliverableSubmitted', workstreamId: 'art', deliverableId: 'dv1' });
    await p.event({ kind: 'boardMerged', version: 9 });
    await p.decide({ affects: ['audio'], text: 'mono only' });

    const art = seg(await brief('art'), 'delta');
    expect(art).toContain(`- #${blue.seq} alice (id: ${blue.id}): hero should be blue`); // R39b
    expect(art).toContain('looks great so far');
    expect(art).toContain('[deliverableSubmitted]');
    expect(art).not.toContain('drafting the Sprites'); // own message, even though it matches the workstream title
    expect(art).not.toContain('more bass');
    expect(art).not.toContain('boardMerged');
    expect(art).not.toContain('board: addDecision');

    const audio = seg(await brief('audio'), 'delta');
    expect(audio).not.toContain('hero should be blue');
    expect(audio).not.toContain('looks great so far');
    expect(audio).not.toContain('deliverableSubmitted');
    expect(audio).toContain('the Sound needs more bass');
    expect(audio).toContain('board: addDecision by alice');

    expect(seg(await brief('art'), 'delta')).toBe('# Since you last looked\n\n(nothing yet)');
  });

  test('the lead sees every human chat message in its delta, even unmentioned and unmatched', async () => {
    await brief('pm');
    const plain = await p.chat({ author: { kind: 'human', id: 'alice' }, text: 'unrelated musing about lunch' });
    const snd = await p.chat({ author: { kind: 'human', id: 'alice' }, text: 'the Sound needs a rethink' });
    const d = seg(await brief('pm'), 'delta');
    expect(d).toContain('unrelated musing about lunch');
    expect(d).toContain('the Sound needs a rethink');
    expect(d).toContain(`#${plain.seq}`);
    expect(d).toContain(`#${snd.seq}`);
  });

  test('non-lead bots still see only mentioned, replied or matching human messages', async () => {
    await brief('art');
    await p.chat({ author: { kind: 'human', id: 'alice' }, text: 'unrelated musing about lunch' });
    await p.chat({ author: { kind: 'human', id: 'alice' }, text: 'ping', mentions: ['art'] });
    const d = seg(await brief('art'), 'delta');
    expect(d).not.toContain('unrelated musing about lunch');
    expect(d).toContain('ping');
  });

  test('the lead does not see its own messages and does not see a human message twice', async () => {
    await brief('pm');
    await p.chat({ author: { kind: 'bot', id: 'pm' }, text: 'lead says something odd', act: 'inform' });
    await p.chat({ author: { kind: 'human', id: 'alice' }, text: 'unrelated musing about lunch' });
    const first = seg(await brief('pm'), 'delta');
    expect(first).toContain('unrelated musing about lunch');
    expect(first).not.toContain('lead says something odd');
    expect(seg(await brief('pm'), 'delta')).not.toContain('unrelated musing about lunch');
  });

  test('delta board changes: contract ends and workstream touches are relevant', async () => {
    await brief('logic');
    await brief('audio');
    await p.apply([{ op: 'updateContract', id: 'c1', spec: 'PNG v2' }]);
    await p.apply([{ op: 'setWorkstreamStatus', id: 'logic', status: 'active' }]);
    const logic = seg(await brief('logic'), 'delta');
    expect(logic).toContain('board: updateContract by alice (c1)');
    expect(logic).toContain('board: setWorkstreamStatus by alice (logic)');
    const audio = seg(await brief('audio'), 'delta');
    expect(audio).not.toContain('board:');
  });

  test('budget trimming order: oldest delta, then recent notes, then recent memories', async () => {
    await brief('art');
    const ws = (await p.store.getWorkspace(p.projectId, 'art'))!;
    await p.store.saveWorkspace({
      ...ws,
      notes: ['NOTE-1 aaaa aaaa', 'NOTE-2 bbbb bbbb', 'NOTE-3 cccc cccc'].join('\n\n'),
      pinnedNotes: ['PINNED-NOTE'],
    });
    const mem = (await p.store.getMemory('art'))!;
    await p.store.saveMemory({
      ...mem,
      memories: [
        { id: 'm0', text: 'PINNED-MEM', fromProject: 'p0', createdAt: 1, pinned: true },
        { id: 'm1', text: 'MEM-1 dddd dddd', fromProject: 'p0', createdAt: 2, pinned: false },
        { id: 'm2', text: 'MEM-2 eeee eeee', fromProject: 'p0', createdAt: 3, pinned: false },
      ],
    });
    for (let i = 1; i <= 3; i++) {
      await p.chat({ author: { kind: 'human', id: 'alice' }, text: `DELTA-${i} ffff ffff`, mentions: ['art'] });
    }
    await p.decide({ affects: ['art'], text: 'CHANGE decision' });

    const full = await brief('art', { peek: true });
    const present = (b: ContextBundle) => {
      const all = b.segments.map(s => s.text).join('\n');
      return {
        delta: [1, 2, 3].filter(i => all.includes(`DELTA-${i}`)),
        change: all.includes('board: addDecision'),
        notes: [1, 2, 3].filter(i => all.includes(`NOTE-${i}`)),
        mems: [1, 2].filter(i => all.includes(`MEM-${i}`)),
      };
    };
    expect(present(full)).toEqual({ delta: [1, 2, 3], change: true, notes: [1, 2, 3], mems: [1, 2] });

    const seen: string[] = [];
    let budget = full.stats.total;
    for (; ; budget--) {
      let b: ContextBundle;
      try {
        b = await brief('art', { peek: true, maxTokens: budget });
      } catch (e) {
        expect(e).toBeInstanceOf(BudgetTooSmallError);
        expect((e as BudgetTooSmallError).details).toEqual({ required: budget + 1, budget });
        break;
      }
      expect(b.stats.total).toBeLessThanOrEqual(budget);
      const s = present(b);
      // Kept items are always the most recent ones (suffixes).
      expect(s.delta).toEqual([1, 2, 3].slice(3 - s.delta.length));
      expect(s.notes).toEqual([1, 2, 3].slice(3 - s.notes.length));
      expect(s.mems).toEqual([1, 2].slice(2 - s.mems.length));
      // Order: delta entries go before the board change, notes only once the delta is empty, memories last.
      if (!s.change) expect(s.delta).toEqual([]);
      if (s.notes.length < 3) expect(s.change).toBe(false);
      if (s.mems.length < 2) expect(s.notes).toEqual([]);
      const all = b.segments.map(x => x.text).join('\n');
      expect(all).toContain('PINNED-NOTE');
      expect(all).toContain('PINNED-MEM');
      expect(seg(b, 'projection')).toBe(seg(full, 'projection'));
      seen.push(JSON.stringify(s));
    }
    // Every stage was reached, ending with everything trimmable gone.
    expect(seen.at(-1)).toBe(JSON.stringify({ delta: [], change: false, notes: [], mems: [] }));
    expect(seen.some(x => x.includes('"delta":[3],"change":true'))).toBe(true);
    expect(seen.some(x => x.includes('"change":false,"notes":[3],"mems":[1,2]'))).toBe(true);
    expect(seen.some(x => x.includes('"notes":[],"mems":[2]'))).toBe(true);
  });

  test('trimmed delta says how much was left out when the note still fits', async () => {
    await brief('art');
    for (let i = 1; i <= 3; i++) {
      await p.chat({ author: { kind: 'human', id: 'alice' }, text: `DELTA-${i} ${'x'.repeat(200)}`, mentions: ['art'] });
    }
    const full = await brief('art', { peek: true });
    const b = await brief('art', { peek: true, maxTokens: full.stats.total - 1 });
    expect(seg(b, 'delta')).not.toContain('DELTA-1');
    expect(seg(b, 'delta')).toContain('DELTA-3');
    expect(seg(b, 'delta')).toContain('1 older item omitted');
    expect(b.stats.total).toBeLessThanOrEqual(full.stats.total - 1);
  });

  // R18: the omission note must never make trimming fail or `required` grow.
  describe('omission note never makes the budget worse', () => {
    const chars = (s: string) => s.length; // exact control over the arithmetic

    test('the note is left out when only the note-less trim fits', async () => {
      p.deps.count = chars;
      await brief('art');
      await p.chat({ author: { kind: 'human', id: 'alice' }, text: 'hi', mentions: ['art'] });
      const full = await brief('art', { peek: true });
      const b = await brief('art', { peek: true, maxTokens: full.stats.total - 1 });
      expect(seg(b, 'delta')).toBe('# Since you last looked\n\n(nothing yet)');
      expect(b.stats.total).toBeLessThanOrEqual(full.stats.total - 1);
    });

    test('(a) one very short delta item and two notes, budget = full - 1: trims instead of throwing', async () => {
      await brief('art');
      const ws = (await p.store.getWorkspace(p.projectId, 'art'))!;
      await p.store.saveWorkspace({ ...ws, notes: 'note one\n\nnote two' });
      await p.chat({ author: { kind: 'human', id: 'alice' }, text: 'hi', mentions: ['art'] });
      const full = await brief('art', { peek: true });
      const b = await brief('art', { peek: true, maxTokens: full.stats.total - 1 });
      expect(b.stats.total).toBeLessThanOrEqual(full.stats.total - 1);
      const trimmedNote = !seg(b, 'workspace').includes('note one');
      const trimmedDelta = !seg(b, 'delta').includes(': hi');
      expect(trimmedNote || trimmedDelta).toBe(true);
    });

    test('(b)+(c) no notes, one short chat: every budget either fits or throws a retryable minimal required', async () => {
      await brief('art');
      await p.chat({ author: { kind: 'human', id: 'alice' }, text: 'hi', mentions: ['art'] });
      const full = await brief('art', { peek: true });
      let threw = false;
      for (let budget = full.stats.total; budget >= full.stats.total - 15; budget--) {
        const r = await brief('art', { peek: true, maxTokens: budget }).catch(e => e as BudgetTooSmallError);
        if (r instanceof BudgetTooSmallError) {
          threw = true;
          expect(r.details.budget).toBe(budget);
          expect(r.details.required).toBeGreaterThan(budget);
          expect(r.details.required).toBeLessThanOrEqual(full.stats.total);
          const retry = await brief('art', { peek: true, maxTokens: r.details.required });
          expect(retry.stats.total).toBeLessThanOrEqual(r.details.required);
        } else {
          expect(threw).toBe(false); // once it throws, smaller budgets throw too
          expect(r.stats.total).toBeLessThanOrEqual(budget);
        }
      }
      expect(threw).toBe(true);
    });
  });

  test('throws BudgetTooSmallError when fixed segments alone exceed the budget', async () => {
    await expect(brief('art', { maxTokens: 10 })).rejects.toMatchObject({ code: 'BUDGET_TOO_SMALL', details: { budget: 10 } });
    const full = (await brief('art', { peek: true })).stats.total;
    const err = (await brief('art', { maxTokens: 10 }).catch(e => e)) as BudgetTooSmallError;
    expect(err.details.required).toBeGreaterThan(10);
    expect(err.details.required).toBeLessThanOrEqual(full);
    await expect(brief('art', { maxTokens: err.details.required })).resolves.toBeDefined();
    // A failed brief saves nothing.
    const p2 = await seedProject();
    await expect(buildBrief(p2.deps, 'art', { maxTokens: 10 })).rejects.toBeInstanceOf(BudgetTooSmallError);
    expect(await p2.store.getWorkspace(p2.projectId, 'art')).toBeNull();
  });

  test('brief before any plan is approved works and says no part assigned yet', async () => {
    p = await seedProject({ plan: false });
    const b = await brief('pm');
    expect(b.segments).toHaveLength(7);
    expect(seg(b, 'projection')).toContain('No part assigned yet.');
    expect(seg(b, 'board')).toContain('## Workstreams\n(nothing yet)');
    expect(seg(b, 'common')).toContain('- pm (bot): Project lead');
    expect(seg(b, 'common')).not.toContain('- art (bot)');
  });

  test('the lead owning no workstream gets "no part assigned yet"', async () => {
    expect(seg(await brief('pm'), 'projection')).toContain('No part assigned yet.');
  });

  test('non-member gets NOT_A_MEMBER', async () => {
    await expect(brief('ghost')).rejects.toMatchObject({ code: 'NOT_A_MEMBER' });
    await expect(brief('ghost', { peek: true })).rejects.toMatchObject({ code: 'NOT_A_MEMBER' });
    // A registered employee who owns nothing in this project is not a member either.
    await p.employees.upsert({ botId: 'qa', persona: 'Tester', skills: [] });
    await expect(brief('qa')).rejects.toMatchObject({ code: 'NOT_A_MEMBER' });
    expect(await p.store.getWorkspace(p.projectId, 'ghost')).toBeNull();
  });

  test('write-scope overlap is mentioned in both projections', async () => {
    await p.patchBoard(b => {
      b.workstreams.find(w => w.id === 'art')!.writeScopes = ['assets'];
      b.workstreams.find(w => w.id === 'audio')!.writeScopes = ['assets/sfx'];
    });
    expect(seg(await brief('art'), 'projection')).toContain('- overlaps with audio (audio) on assets');
    expect(seg(await brief('audio'), 'projection')).toContain('- overlaps with art (art) on assets');
    expect(seg(await brief('logic'), 'projection')).toContain('## Overlaps\n(nothing yet)');
  });

  test('a bot owning several workstreams gets one block each; a shared item is shown in full once', async () => {
    await p.patchBoard(b => {
      b.workstreams.push({ ...b.workstreams[0]!, id: 'ui', title: 'Menus', brief: 'Menu screens.' });
    });
    const id = await p.decide({ affects: ['art', 'ui'], text: 'flat colors', rationale: 'SHARED-WHY' });
    const proj = seg(await brief('art'), 'projection');
    expect(proj).toContain('art | Sprites | art | active');
    expect(proj).toContain('ui | Menus | art | active');
    expect(proj.split('SHARED-WHY')).toHaveLength(2);
    expect(proj).toContain(`[${id}] flat colors (seen)`);
  });

  test('promotionsThisTurn resets on brief', async () => {
    await brief('art');
    const ws = (await p.store.getWorkspace(p.projectId, 'art'))!;
    await p.store.saveWorkspace({ ...ws, promotionsThisTurn: 3 });
    await brief('art', { peek: true });
    expect((await p.store.getWorkspace(p.projectId, 'art'))!.promotionsThisTurn).toBe(3);
    await brief('art');
    expect((await p.store.getWorkspace(p.projectId, 'art'))!.promotionsThisTurn).toBe(0);
  });

  test('trigger, tools and stats', async () => {
    const b = await brief('art', { trigger: { reason: 'mentioned', detail: 'mentioned in a chat message' } });
    expect(seg(b, 'trigger')).toBe('# Why you are awake\n\nreason: mentioned\nmentioned in a chat message');
    expect(seg(await brief('art'), 'trigger')).toBe('# Why you are awake\n\nreason: manual');
    expect(b.tools).toEqual(TEST_TOOLS);
    for (const s of b.segments) expect(b.stats.bySegment[s.kind]).toBe(defaultCountTokens(s.text));
    expect(b.stats.total).toBe(b.segments.reduce((n, s) => n + defaultCountTokens(s.text), 0));
  });

  test('CJK and emoji content in notes is trimmed without broken characters', async () => {
    await brief('art');
    const paras = ['第一段：角色设计稿已完成😀', '第二段：🎉🎉 调色板定为十六色', '第三段：下一步画敌人👾和道具'];
    const ws = (await p.store.getWorkspace(p.projectId, 'art'))!;
    await p.store.saveWorkspace({ ...ws, notes: paras.join('\n\n') });
    const full = await brief('art', { peek: true });
    // CJK characters count one token each.
    expect(full.stats.bySegment.workspace).toBe(defaultCountTokens(seg(full, 'workspace')));
    expect(defaultCountTokens('角色设计')).toBe(4);
    let kept = 3;
    for (let budget = full.stats.total - 1; kept > 0; budget--) {
      const b = await brief('art', { peek: true, maxTokens: budget });
      const text = seg(b, 'workspace');
      for (const s of b.segments) expect(LONE_SURROGATE.test(s.text)).toBe(false);
      const shown = paras.filter(x => text.includes(x));
      // Whole paragraphs only: every recent line is one of the original paragraphs.
      const recent = text.split('\n').filter(l => l.startsWith('- ')).map(l => l.slice(2));
      expect(recent).toEqual(shown);
      expect(shown).toEqual(paras.slice(3 - shown.length));
      expect(splitParagraphs(paras.join('\n\n'))).toEqual(paras);
      kept = shown.length;
    }
  });
});

describe('two-phase seen (spec 2026-11-02 section 2.2)', () => {
  const BUDGET = { maxTokens: 100_000 };
  const FULL = '[c1@v1] art -> logic: PNG sprite sheets, 16x16 tiles';
  const COMPACT = '[c1@v1] art -> logic (seen)';
  let f: FacadeProject;
  const proj = async (botId: string, o: { peek?: boolean } = {}) => seg(await f.p.buildBrief(botId, { ...BUDGET, ...o }), 'projection');
  const workspace = async (botId: string) => (await f.store.getWorkspace(f.projectId, botId))!;

  beforeEach(async () => {
    f = await makeProject({ approved: true });
  });

  test('an item shown in a brief with no tool call afterwards is shown in full again', async () => {
    expect(await proj('art')).toContain(FULL);
    expect(await proj('art')).toContain(FULL);
    const ws = await workspace('art');
    expect(ws.seenItemIds).toEqual([]);
    expect(ws.pendingSeenItemIds).toEqual(['c1@1']);
  });

  test('after the bot calls any tool, the item is compacted in the next brief', async () => {
    expect(await proj('art')).toContain(FULL);
    await f.p.callTool('art', 'updateNotes', { text: 'started on the hero' });
    const ws = await workspace('art');
    expect(ws.seenItemIds).toEqual(['c1@1']);
    expect(ws.pendingSeenItemIds).toEqual([]);
    const next = await proj('art');
    expect(next).toContain(COMPACT);
    expect(next).not.toContain(FULL);
    // another bot's tool call confirms nothing for art
    await f.p.callTool('logic', 'updateNotes', { text: 'waiting on art' });
    expect((await workspace('logic')).seenItemIds).toEqual([]);
  });

  test('a second consecutive tool call changes nothing more', async () => {
    expect(await proj('art')).toContain(FULL);
    await f.p.callTool('art', 'updateNotes', { text: 'one' });
    const after = await workspace('art');
    expect(after.seenItemIds).toEqual(['c1@1']);
    expect(after.pendingSeenItemIds).toEqual([]);
    await f.p.callTool('art', 'updateNotes', { text: 'two' });
    const again = await workspace('art');
    expect(again.seenItemIds).toEqual(after.seenItemIds);
    expect(again.pendingSeenItemIds).toEqual([]);
  });

  // The fixture lead owns no workstream, so its brief shows no board item; give it a pending one directly.
  const withPending = async () => {
    await proj('pm');
    await f.store.saveWorkspace({ ...(await workspace('pm')), pendingSeenItemIds: ['c1@1'] });
  };

  test('building a planning context discards the lead pending items; the next tool call confirms nothing (R-G1)', async () => {
    await withPending();
    await f.p.buildPlanningContext();
    expect((await workspace('pm')).pendingSeenItemIds).toEqual([]);
    await f.p.callTool('pm', 'updateNotes', { text: 'noted' });
    expect((await workspace('pm')).seenItemIds).toEqual([]);
  });

  test('building a review context discards the lead pending items (R-G1)', async () => {
    await f.p.callTool('art', 'submitDeliverable', { workstreamId: 'art', summary: 's', content: 'sprites v1' });
    const dv = (await f.p.board()).workstreams.find(w => w.id === 'art')!.deliverables[0]!;
    await withPending();
    await f.p.buildReviewContext(dv.id);
    expect((await workspace('pm')).pendingSeenItemIds).toEqual([]);
    await f.p.callTool('pm', 'updateNotes', { text: 'noted' });
    expect((await workspace('pm')).seenItemIds).toEqual([]);
  });

  test('a context for a lead without a workspace creates none', async () => {
    await f.p.buildPlanningContext();
    expect(await f.store.getWorkspace(f.projectId, 'pm')).toBeNull();
  });

  test('a failing tool call still confirms the pending items', async () => {
    expect(await proj('art')).toContain(FULL);
    await expect(f.p.callTool('art', 'updateNotes', {})).rejects.toMatchObject({ code: 'INVALID_OP' });
    expect(await proj('art')).toContain(COMPACT);
  });

  test('pending keys for items removed from the board are dropped on confirm', async () => {
    expect(await proj('art')).toContain(FULL);
    const b = await f.store.getBoard(f.projectId);
    const c1 = b.contracts.find(c => c.id === 'c1')!;
    c1.version = 2;
    c1.spec = 'PNG sprite sheets, 32x32 tiles';
    const v = b.version;
    b.version = v + 1;
    await f.store.saveBoard(b, v, { version: b.version, mergedAt: f.clock.now(), ops: [] });
    await f.p.callTool('art', 'updateNotes', { text: 'noted' });
    const ws = await workspace('art');
    expect(ws.seenItemIds).toEqual([]);
    expect(ws.pendingSeenItemIds).toEqual([]);
    expect(await proj('art')).toContain('[c1@v2] art -> logic: PNG sprite sheets, 32x32 tiles');
  });

  test('peek briefs neither set nor confirm pending items', async () => {
    await proj('art', { peek: true });
    expect(await f.store.getWorkspace(f.projectId, 'art')).toBeNull();
    await proj('art');
    const before = await workspace('art');
    expect(before.pendingSeenItemIds).toEqual(['c1@1']);
    await proj('art', { peek: true });
    expect(await workspace('art')).toEqual(before);
    await f.p.callTool('art', 'updateNotes', { text: 'noted' });
    expect(await proj('art', { peek: true })).toContain(COMPACT);
  });

  test('a new brief overwrites the pending set instead of adding to it', async () => {
    await proj('art');
    const b = await f.store.getBoard(f.projectId);
    b.contracts.find(c => c.id === 'c1')!.version = 2;
    const v = b.version;
    b.version = v + 1;
    await f.store.saveBoard(b, v, { version: b.version, mergedAt: f.clock.now(), ops: [] });
    await proj('art');
    expect((await workspace('art')).pendingSeenItemIds).toEqual(['c1@2']);
  });

  test('a tool call by a bot without a workspace creates none; a non-member is still refused', async () => {
    await f.p.callTool('audio', 'updateNotes', { text: 'hi' }); // updateNotes itself saves a workspace
    expect((await workspace('audio')).seenItemIds).toEqual([]);
    await f.p.callTool('logic', 'getBoardItem', { id: 'c1' });
    expect(await f.store.getWorkspace(f.projectId, 'logic')).toBeNull();
    await expect(f.p.callTool('ghost', 'updateNotes', { text: 'x' })).rejects.toMatchObject({ code: 'NOT_A_MEMBER' });
    expect(await f.store.getWorkspace(f.projectId, 'ghost')).toBeNull();
  });
});

describe('public board directives (spec 2026-11-04 section 2.1)', () => {
  const BUDGET = { maxTokens: 1_000_000 };
  const say = (f: FacadeProject, text: string, mentions?: string[]) =>
    f.p.ingest({ author: { kind: 'human', id: 'alice' }, text, ...(mentions ? { mentions } : {}) });
  const wakePairs = (w: { botId: string; reason: string }[]) => w.map(x => [x.botId, x.reason]).sort();

  test('directives off: board text and briefs are unchanged', async () => {
    const run = async (publicBoard?: { directives?: boolean; contracts?: boolean; failures?: boolean }) => {
      let n = 0;
      const f = await makeProject({ approved: true, publicBoard, newId: prefix => `${prefix}-${++n}` });
      const out: string[] = [];
      for (const id of ['pm', 'art', 'logic', 'audio']) await f.p.buildBrief(id, BUDGET);
      await say(f, 'Make it cute.');
      await say(f, 'art, use pastel colours', ['art']);
      for (const id of ['pm', 'art', 'logic', 'audio']) {
        const b = await f.p.buildBrief(id, BUDGET);
        out.push(...b.segments.map(s => s.text));
      }
      out.push(await f.p.exportMarkdown());
      return out;
    };
    const base = await run({ directives: false, contracts: false, failures: false });
    expect(await run()).toEqual(base); // the helper's default is directives off
    expect(await run({ directives: false })).toEqual(base);
    expect((await run({})).join('\n')).toContain('## Directives'); // the core default is on
    expect(base.join('\n')).not.toContain('## Directives');
  });

  test('default (publicBoard omitted): the Directives section is present and human chat is not in deltas', async () => {
    const f = await makeProject({ approved: true, coreDefaultBoard: true });
    for (const id of ['pm', 'art']) await f.p.buildBrief(id, BUDGET);
    const a = await say(f, 'Make it cute.');
    const board = seg(await f.p.buildBrief('art', BUDGET), 'board');
    expect(board).toContain(`## Directives\n- [#${a.seq} alice] Make it cute.`);
    expect(board).not.toContain('## Contracts');
    expect(board).not.toContain('## Failures');
    expect(seg(await f.p.buildBrief('art', BUDGET), 'delta')).not.toContain('Make it cute.');
  });

  test('default: an empty publicBoard object and omitted directives key also mean directives on', async () => {
    for (const publicBoard of [{}, { contracts: true }, { failures: true }]) {
      const f = await makeProject({ approved: true, publicBoard });
      expect(seg(await f.p.buildBrief('art', BUDGET), 'board'), JSON.stringify(publicBoard)).toContain('## Directives');
    }
    const f = await makeProject({ approved: true, publicBoard: { contracts: true, directives: false } });
    expect(seg(await f.p.buildBrief('art', BUDGET), 'board')).not.toContain('## Directives');
  });

  test('directives on: every human chat message appears on the board in order', async () => {
    const f = await makeProject({ approved: true, publicBoard: { directives: true } });
    const a = await say(f, 'Make it cute.');
    await f.p.ingest({ author: { kind: 'bot', id: 'art' }, text: 'on it' });
    const b = await say(f, 'Use pastel colours\nand round shapes.');
    const board = seg(await f.p.buildBrief('art', BUDGET), 'board');
    expect(board).toContain(
      ['## Constraints', '- Runs in the browser', '', '## Directives', `- [#${a.seq} alice] Make it cute.`,
        `- [#${b.seq} alice] Use pastel colours\nand round shapes.`, '', '## Conventions'].join('\n'),
    );
    expect(board).not.toContain('on it');
  });

  test('directives on with no human message yet: the section shows nothing yet', async () => {
    const f = await makeProject({ approved: true, publicBoard: { directives: true } });
    expect(seg(await f.p.buildBrief('art', BUDGET), 'board')).toContain('## Directives\n(nothing yet)\n\n## Conventions');
  });

  test('directives on: only the newest directivesKeep are shown with an omitted count', async () => {
    const f = await makeProject({ approved: true, publicBoard: { directives: true }, options: { directivesKeep: 2 } });
    await say(f, 'one');
    const two = await say(f, 'two');
    const three = await say(f, 'three');
    const board = seg(await f.p.buildBrief('art', BUDGET), 'board');
    expect(board).toContain(
      ['## Directives', '(1 earlier directives omitted)', `- [#${two.seq} alice] two`, `- [#${three.seq} alice] three`, '', '## Conventions'].join('\n'),
    );
    expect(board).not.toContain('] one');
  });

  test('directives on: human chat is left out of every bot delta but still wakes the same bots', async () => {
    const run = async (directives: boolean) => {
      const f = await makeProject({ approved: true, publicBoard: { directives } });
      for (const id of ['pm', 'art', 'logic', 'audio']) await f.p.buildBrief(id, BUDGET);
      const wakes: string[][][] = [];
      wakes.push(wakePairs(await f.p.route(await say(f, 'art, the hero needs a hat', ['art']))));
      wakes.push(wakePairs(await f.p.route(await say(f, 'how is the Gameplay going?'))));
      const botMsg = await f.p.ingest({ author: { kind: 'bot', id: 'logic' }, text: 'art, ping', mentions: ['art'] });
      wakes.push(wakePairs(await f.p.route(botMsg)));
      const deltas = new Map<string, string>();
      for (const id of ['pm', 'art', 'logic', 'audio']) deltas.set(id, seg(await f.p.buildBrief(id, BUDGET), 'delta'));
      return { wakes, deltas };
    };
    const off = await run(false);
    const on = await run(true);
    expect(on.wakes).toEqual(off.wakes);
    expect(off.deltas.get('art')).toContain('the hero needs a hat');
    expect(off.deltas.get('pm')).toContain('how is the Gameplay going?');
    for (const d of on.deltas.values()) {
      expect(d).not.toContain('the hero needs a hat');
      expect(d).not.toContain('how is the Gameplay going?');
    }
    // bot chat still reaches the delta
    expect(on.deltas.get('art')).toContain('art, ping');
  });
});

describe('public board contracts and failures (spec 2026-11-04 sections 2.2-2.4)', () => {
  const BUDGET = { maxTokens: 1_000_000 };
  type Switches = { directives?: boolean; contracts?: boolean; failures?: boolean };
  const failureOp = (affects: string[], text: string, reason: string) => ({
    op: 'addFailure' as const,
    failure: { text, reason, affects, source: { entryIds: [], by: 'art' } },
  });
  const CONTRACT_LINE = '- [c1@1] art → logic: PNG sprite sheets, 16x16 tiles';

  /** An approved project with two failures and one art deliverable; returns its review context too. */
  async function setup(publicBoard?: Switches) {
    let n = 0;
    const f = await makeProject({ approved: true, publicBoard, newId: prefix => `${prefix}-${++n}` });
    await f.p.submit('art', {
      type: 'proposal',
      ops: [failureOp(['art'], 'Tried SVG sprites', 'Renderer blurs them'), failureOp(['audio'], 'Tried WAV', 'Too large')],
    });
    await f.p.submit('art', { type: 'deliverable', workstreamId: 'art', summary: 'sprite sheet', content: 'sprites.png' });
    const deliverableId = (await f.p.board()).workstreams.find(w => w.id === 'art')!.deliverables.at(-1)!.id;
    return { f, deliverableId };
  }

  test('contracts on: every contract is on the board with its spec, and the projection no longer repeats it', async () => {
    const { f, deliverableId } = await setup({ contracts: true });
    const art = await f.p.buildBrief('art', BUDGET);
    const logic = await f.p.buildBrief('logic', BUDGET);
    for (const b of [art, logic]) {
      expect(seg(b, 'board')).toContain(['## Conventions', '(nothing yet)', '', '## Contracts', CONTRACT_LINE, '', '## Workstreams'].join('\n'));
      expect(seg(b, 'projection')).not.toContain('## Contracts');
      expect(seg(b, 'projection')).not.toContain('PNG sprite sheets');
      // failures stay in the projection while their switch is off
      expect(seg(b, 'projection')).toContain('## Failures');
    }
    expect(seg(art, 'board')).not.toContain('## Failures');
    // audio has no contract in its projection, but the board lists every contract
    expect(seg(await f.p.buildBrief('audio', BUDGET), 'board')).toContain(CONTRACT_LINE);
    const review = await f.p.buildReviewContext(deliverableId);
    expect(seg(review, 'board')).toBe(seg(await f.p.buildBrief('pm', { ...BUDGET, peek: true }), 'board'));
    expect(seg(review, 'projection')).not.toContain('## Contracts');
    expect(seg(review, 'projection')).not.toContain('PNG sprite sheets');
    expect(seg(review, 'projection')).toContain('## Failures');
  });

  test('failures on: every failure is on the board, and projection and review body no longer repeat it', async () => {
    const { f, deliverableId } = await setup({ failures: true });
    const art = await f.p.buildBrief('art', BUDGET);
    const [svg, wav] = (await f.p.board()).failures.map(x => x.id);
    const blocks = [
      `- [${svg}] tried: Tried SVG sprites\n  why it failed: Renderer blurs them\n  affects: art`,
      `- [${wav}] tried: Tried WAV\n  why it failed: Too large\n  affects: audio`,
    ];
    const board = seg(art, 'board');
    expect(board).toContain(['## Conventions', '(nothing yet)', '', '## Failures', ...blocks, '', '## Workstreams'].join('\n'));
    expect(board).not.toContain('## Contracts');
    for (const id of ['art', 'audio', 'logic', 'pm']) {
      const proj = seg(await f.p.buildBrief(id, BUDGET), 'projection');
      expect(proj).not.toContain('## Failures');
      expect(proj).not.toContain('Tried SVG sprites');
      expect(proj).not.toContain('Tried WAV');
    }
    expect(seg(art, 'projection')).toContain('## Contracts');
    const review = await f.p.buildReviewContext(deliverableId);
    expect(seg(review, 'board')).toBe(seg(await f.p.buildBrief('pm', { ...BUDGET, peek: true }), 'board'));
    expect(seg(review, 'projection')).not.toContain('## Failures');
    expect(seg(review, 'projection')).not.toContain('Tried SVG sprites');
    expect(seg(review, 'projection')).toContain('## Contracts');
  });

  test('all on: sections follow Goal, Constraints, Directives, Conventions, Contracts, Failures, Workstreams', async () => {
    const { f, deliverableId } = await setup({ directives: true, contracts: true, failures: true });
    await f.p.ingest({ author: { kind: 'human', id: 'alice' }, text: 'Make it cute.' });
    const board = seg(await f.p.buildBrief('art', BUDGET), 'board');
    const headings = board.split('\n').filter(l => l.startsWith('## '));
    expect(headings).toEqual(['## Goal', '## Constraints', '## Directives', '## Conventions', '## Contracts', '## Failures', '## Workstreams']);
    for (const ctx of [await f.p.buildPlanningContext(), await f.p.buildReviewContext(deliverableId)]) {
      expect(seg(ctx, 'board')).toBe(seg(await f.p.buildBrief('pm', { ...BUDGET, peek: true }), 'board'));
    }
  });

  test('contracts/failures off: projection and review text are unchanged', async () => {
    const run = async (publicBoard?: Switches) => {
      const { f, deliverableId } = await setup(publicBoard);
      const out: string[] = [];
      for (const id of ['pm', 'art', 'logic', 'audio']) out.push(seg(await f.p.buildBrief(id, BUDGET), 'projection'));
      out.push(seg(await f.p.buildReviewContext(deliverableId), 'projection'));
      return out;
    };
    const base = await run();
    expect(await run({ contracts: false, failures: false })).toEqual(base);
    // directives alone do not touch the projection or the review body
    expect(await run({ directives: true })).toEqual(base);
    const all = base.join('\n');
    expect(all).toContain('[c1@v1] art -> logic: PNG sprite sheets');
    expect(all).toContain('tried: Tried SVG sprites');
  });

  test('contracts off: the review body keeps the original instruction', async () => {
    const { f, deliverableId } = await setup({ failures: true });
    const body = seg(await f.p.buildReviewContext(deliverableId), 'projection');
    expect(body.startsWith(
      'Check only whether the content violates the conventions and contracts listed below. ' +
        'Do not judge style, quality or anything else. ' +
        'Reply with a pass, or with the specific conventions or contracts that are violated.\n\n## Workstream',
    )).toBe(true);
  });

  test('contracts on: the review instruction points to the board Contracts section for this workstream', async () => {
    const { f, deliverableId } = await setup({ contracts: true });
    const body = seg(await f.p.buildReviewContext(deliverableId), 'projection');
    const instruction = body.split('\n\n')[0]!;
    expect(instruction).not.toContain('contracts listed below');
    expect(instruction).toContain('conventions listed below');
    expect(instruction).toContain("Contracts section of the project board above");
    expect(instruction).toContain('"art"');
  });

  test('board items on the public board are never compacted as seen', async () => {
    const { f } = await setup({ contracts: true, failures: true });
    const first = await f.p.buildBrief('art', BUDGET);
    await f.p.callTool('art', 'updateNotes', { text: 'started' }); // confirms what the brief showed
    const ws = await f.store.getWorkspace(f.projectId, 'art');
    const failureIds = (await f.p.board()).failures.map(x => x.id);
    expect(failureIds).toHaveLength(2);
    expect(ws!.seenItemIds).not.toContain('c1@1');
    for (const id of failureIds) expect(ws!.seenItemIds).not.toContain(id);
    const again = seg(await f.p.buildBrief('art', BUDGET), 'board');
    expect(again).toBe(seg(first, 'board'));
    expect(again).toContain(CONTRACT_LINE);
    expect(again).toContain('why it failed: Renderer blurs them');
    expect(again).not.toContain('(seen)');
  });
});
