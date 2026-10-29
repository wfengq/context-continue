import { beforeEach, describe, expect, test } from 'vitest';
import { buildBrief, selectProjection } from '../src/brief.js';
import { BudgetTooSmallError } from '../src/errors.js';
import { splitParagraphs } from '../src/render.js';
import { defaultCountTokens } from '../src/tokens.js';
import type { ContextBundle, SegmentKind, WakeReason } from '../src/types.js';
import { seedProject, TEST_TOOLS, type SeededProject } from './helpers.js';

let p: SeededProject;

type BriefOpts = { maxTokens?: number; peek?: boolean; trigger?: { reason: WakeReason | 'manual'; detail: string } };
const brief = (botId: string, o: BriefOpts = {}) => buildBrief(p.deps, botId, { maxTokens: 100_000, ...o });
const seg = (b: ContextBundle, kind: SegmentKind) => b.segments.find(s => s.kind === kind)!.text;
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

beforeEach(async () => {
  p = await seedProject();
});

describe('buildBrief', () => {
  test('segments come in spec order with spec cacheability', async () => {
    const b = await brief('art');
    expect(b.segments.map(s => [s.kind, s.cacheable])).toEqual([
      ['common', true],
      ['board', true],
      ['memory', true],
      ['projection', false],
      ['workspace', false],
      ['delta', false],
      ['trigger', false],
    ]);
  });

  test('common and board segments are byte-identical across bots at the same version', async () => {
    const [a, l] = [await brief('art', { peek: true }), await brief('logic', { peek: true })];
    expect(a.segments[0]!.text).toBe(l.segments[0]!.text);
    expect(a.segments[1]!.text).toBe(l.segments[1]!.text);
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

    const ws = (await p.store.getWorkspace(p.projectId, 'art'))!;
    expect(ws.seenItemIds).toContain(newId);
    expect(ws.seenItemIds).toContain('c1@2');
  });

  test('peek does not mark anything as seen or advance pointers', async () => {
    await p.decide({ affects: ['art'], text: 'palette decision', rationale: 'R1' });
    await brief('art', { peek: true });
    expect(await p.store.getWorkspace(p.projectId, 'art')).toBeNull();
    expect(seg(await brief('art', { peek: true }), 'projection')).toContain('why: R1');

    await brief('art'); // creates the workspace and marks the decision seen
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
