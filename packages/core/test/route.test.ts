import { describe, expect, test } from 'vitest';
import { DEFAULT_OPTIONS } from '../src/options.js';
import { matchWorkstreams, routeChat, toLedgerEntry, type RouteContext, type RouteInput } from '../src/route.js';
import type { ChatInput, LedgerEntry, SpeechAct, Workstream } from '../src/types.js';

const ws = (id: string, title: string, over: Partial<Workstream> = {}): Workstream => ({
  id,
  title,
  brief: '',
  owner: 'art',
  dependsOn: [],
  writeScopes: [],
  status: 'active',
  reviewRounds: 0,
  deliverables: [],
  ...over,
});

let seq = 0;
function chat(
  author: LedgerEntry['author'],
  text: string,
  over: { mentions?: string[]; replyTo?: string; act?: SpeechAct; hops?: number } = {},
): LedgerEntry {
  seq += 1;
  return {
    id: `e${seq}`,
    projectId: 'p',
    seq,
    createdAt: seq,
    author,
    body: { type: 'chat', text, mentions: over.mentions ?? [], replyTo: over.replyTo, act: over.act, hops: over.hops ?? 0 },
  };
}
const botMsg = (over: { mentions?: string[]; replyTo?: string; act?: SpeechAct; hops?: number; author?: string } = {}) =>
  chat({ kind: 'bot', id: over.author ?? 'art' }, 'hello', { act: 'inform', ...over });
const humanMsg = (text: string, over: { mentions?: string[]; replyTo?: string } = {}) =>
  chat({ kind: 'human', id: 'alice' }, text, over);

const input: RouteInput = { boardPublic: 'board', recent: [], candidates: [], message: humanMsg('x') };

async function route(entry: LedgerEntry, over: Partial<RouteContext> = {}) {
  return routeChat(entry, {
    lead: 'pm',
    members: new Set(['pm', 'art', 'logic']),
    workstreams: [ws('ui', 'UI', { owner: 'art' }), ws('sfx', '音效', { owner: 'logic' })],
    botTurnsSinceHuman: 0,
    parent: null,
    options: DEFAULT_OPTIONS,
    routeInput: async () => input,
    ...over,
  });
}

describe('routeChat: human messages', () => {
  test('human @mention wakes the mentioned member with mentioned', async () => {
    const r = await route(humanMsg('hi', { mentions: ['logic'] }));
    expect(r).toEqual({ wakes: [{ botId: 'logic', reason: 'mentioned', detail: expect.any(String) }], limitReached: false });
  });

  test('non-members in mentions are ignored and wakes are deduped in first-seen order', async () => {
    const parent = botMsg({ author: 'art' });
    const r = await route(humanMsg('hi', { mentions: ['ghost', 'logic', 'art', 'logic'] }), { parent });
    expect(r.wakes.map((w) => w.botId)).toEqual(['logic', 'art']);
  });

  test('reply to a bot message counts as mention of that bot', async () => {
    const parent = botMsg({ author: 'logic' });
    const r = await route(humanMsg('thanks', { replyTo: parent.id }), { parent });
    expect(r.wakes).toEqual([{ botId: 'logic', reason: 'mentioned', detail: expect.any(String) }]);
  });

  test('human messages are never limited', async () => {
    const r = await route(humanMsg('hi', { mentions: ['logic'] }), { botTurnsSinceHuman: 99 });
    expect(r.limitReached).toBe(false);
    expect(r.wakes).toHaveLength(1);
  });

  test('unaddressed human message mentioning a workstream title wakes its owner with routed', async () => {
    const r = await route(humanMsg('the UI looks off'));
    expect(r.wakes).toEqual([{ botId: 'art', reason: 'routed', detail: expect.any(String) }]);
  });

  test('workstream id also matches', async () => {
    const r = await route(humanMsg('音效再大一点'));
    expect(r.wakes.map((w) => w.botId)).toEqual(['logic']);
  });

  test('blocked workstream owner is still woken by mentioned', async () => {
    const workstreams = [ws('ui', 'UI', { owner: 'art', status: 'blocked' })];
    const r = await route(humanMsg('hi', { mentions: ['art'] }), { workstreams });
    expect(r.wakes).toEqual([{ botId: 'art', reason: 'mentioned', detail: expect.any(String) }]);
  });

  test('blocked workstream owner is skipped for routed; falls through to lead when all blocked', async () => {
    const workstreams = [ws('ui', 'UI', { owner: 'art', status: 'blocked' })];
    const r = await route(humanMsg('the UI looks off'), { workstreams });
    expect(r.wakes).toEqual([{ botId: 'pm', reason: 'routed', detail: expect.any(String) }]);
  });

  test('blocked matches are skipped but other matched owners still wake', async () => {
    const workstreams = [ws('ui', 'UI', { owner: 'art', status: 'blocked' }), ws('sfx', 'sfx', { owner: 'logic' })];
    const r = await route(humanMsg('UI and sfx'), { workstreams });
    expect(r.wakes.map((w) => w.botId)).toEqual(['logic']);
  });

  test('all matched blocked falls back to models.route when provided', async () => {
    const workstreams = [ws('ui', 'UI', { owner: 'art', status: 'blocked' })];
    const r = await route(humanMsg('the UI looks off'), { workstreams, route: async () => ['logic'] });
    expect(r.wakes).toEqual([{ botId: 'logic', reason: 'routed', detail: expect.any(String) }]);
  });

  test('no match uses models.route, filtered to members; errors fall back to lead', async () => {
    expect((await route(humanMsg('hmm'), { route: async () => ['art', 'ghost'] })).wakes.map((w) => w.botId)).toEqual(['art']);
    expect(
      (
        await route(humanMsg('hmm'), {
          route: async () => {
            throw new Error('x');
          },
        })
      ).wakes,
    ).toEqual([{ botId: 'pm', reason: 'routed', detail: expect.stringContaining('failed') }]);
  });

  test('models.route returning [] wakes nobody', async () => {
    expect((await route(humanMsg('hmm'), { route: async () => [] })).wakes).toEqual([]);
  });

  test('routeInput is lazy: only built when the router is called', async () => {
    let calls = 0;
    const routeInput = async () => {
      calls += 1;
      return input;
    };
    await route(humanMsg('the UI looks off'), { routeInput, route: async () => [] });
    await route(humanMsg('hi', { mentions: ['art'] }), { routeInput, route: async () => [] });
    expect(calls).toBe(0);
    let got: RouteInput | undefined;
    await route(humanMsg('hmm'), { routeInput, route: async (i) => ((got = i), []) });
    expect(calls).toBe(1);
    expect(got).toBe(input);
  });

  test('no match and no model wakes lead', async () => {
    const r = await route(humanMsg('hmm'));
    expect(r.wakes).toEqual([{ botId: 'pm', reason: 'routed', detail: expect.any(String) }]);
  });
});

describe('routeChat: bot messages', () => {
  test('bot message wakes the mentioned bot only for request/query/propose', async () => {
    for (const act of ['request', 'query', 'propose'] as const) {
      expect((await route(botMsg({ act, mentions: ['logic'] }))).wakes).toEqual([
        { botId: 'logic', reason: 'mentioned', detail: expect.any(String) },
      ]);
    }
    for (const act of ['inform', 'agree', 'refuse', 'done'] as const) {
      expect((await route(botMsg({ act, mentions: ['logic'] }))).wakes).toEqual([]);
    }
  });

  test('bot reply to another bot wakes the parent author', async () => {
    const parent = botMsg({ author: 'logic' });
    const r = await route(botMsg({ act: 'query', replyTo: parent.id, hops: 1 }), { parent });
    expect(r.wakes.map((w) => w.botId)).toEqual(['logic']);
  });

  test('a bot never wakes itself', async () => {
    const r = await route(botMsg({ act: 'request', mentions: ['art', 'logic'] }));
    expect(r.wakes.map((w) => w.botId)).toEqual(['logic']);
  });

  test('hops at maxHops wakes lead with needsLead instead of the other bot', async () => {
    const r = await route(botMsg({ act: 'request', mentions: ['logic'], hops: 4 }));
    expect(r.wakes).toEqual([{ botId: 'pm', reason: 'needsLead', detail: expect.stringContaining('hops') }]);
  });

  test('hops below maxHops wake normally', async () => {
    const r = await route(botMsg({ act: 'request', mentions: ['logic'], hops: 3 }));
    expect(r.wakes.map((w) => w.botId)).toEqual(['logic']);
  });

  test('hop cap with the lead as author wakes nobody', async () => {
    const r = await route(botMsg({ author: 'pm', act: 'request', mentions: ['logic'], hops: 4 }));
    expect(r.wakes).toEqual([]);
  });

  test('hop cap with a non-waking act or no targets does not wake the lead', async () => {
    expect((await route(botMsg({ act: 'inform', mentions: ['logic'], hops: 4 }))).wakes).toEqual([]);
    expect((await route(botMsg({ act: 'request', hops: 4 }))).wakes).toEqual([]);
  });

  test('wake limit: after 6 bot turns since the last human message, nothing wakes', async () => {
    const r = await route(botMsg({ act: 'request', mentions: ['logic'] }), { botTurnsSinceHuman: 6 });
    expect(r).toEqual({ wakes: [], limitReached: true });
  });

  test('wake limit takes precedence over the hop cap', async () => {
    const r = await route(botMsg({ act: 'request', mentions: ['logic'], hops: 4 }), { botTurnsSinceHuman: 6 });
    expect(r).toEqual({ wakes: [], limitReached: true });
  });

  test('below the wake limit wakes still happen', async () => {
    const r = await route(botMsg({ act: 'request', mentions: ['logic'] }), { botTurnsSinceHuman: 5 });
    expect(r.limitReached).toBe(false);
    expect(r.wakes).toHaveLength(1);
  });

  test('bot messages never use routed', async () => {
    const r = await route(botMsg({ act: 'request' }), { route: async () => ['logic'] });
    expect(r).toEqual({ wakes: [], limitReached: false });
    const r2 = await route(botMsg({ act: 'request' }));
    expect(r2.wakes).toEqual([]);
  });
});

describe('matchWorkstreams', () => {
  test('ASCII titles match whole words only; CJK titles match substrings', () => {
    expect(matchWorkstreams('please build it', [ws('ui', 'UI')])).toEqual([]);
    expect(matchWorkstreams('the UI looks off', [ws('ui', 'UI')])).toEqual(['ui']);
    expect(matchWorkstreams('音效再大一点', [ws('sfx', '音效')])).toEqual(['sfx']);
  });

  test('whole-word boundaries: underscore and digits count as word characters', () => {
    expect(matchWorkstreams('the ui_kit', [ws('x', 'ui')])).toEqual([]);
    expect(matchWorkstreams('ui2', [ws('x', 'ui')])).toEqual([]);
    expect(matchWorkstreams('(ui), ok', [ws('x', 'ui')])).toEqual(['x']);
    expect(matchWorkstreams('UI', [ws('x', 'ui')])).toEqual(['x']);
  });

  test('regex metacharacters in titles are escaped', () => {
    expect(matchWorkstreams('use c++ here', [ws('cpp', 'c++')])).toEqual(['cpp']);
    expect(matchWorkstreams('what a.b?', [ws('q', 'a.b?')])).toEqual(['q']);
    expect(matchWorkstreams('axb', [ws('q', 'a.b')])).toEqual([]);
  });

  test('matches by id, in workstream order, deduped', () => {
    const list = [ws('alpha', 'First'), ws('beta', 'Second'), ws('gamma', 'alpha')];
    expect(matchWorkstreams('second then alpha', list)).toEqual(['alpha', 'beta', 'gamma']);
    expect(matchWorkstreams('nothing', list)).toEqual([]);
  });

  test('case-insensitive for CJK/kana/Hangul needles and mixed needles use substring', () => {
    expect(matchWorkstreams('ここでUIを直す', [ws('a', 'UIを')])).toEqual(['a']);
    expect(matchWorkstreams('한국어 테스트', [ws('k', '한국어')])).toEqual(['k']);
  });
});

describe('toLedgerEntry', () => {
  test('computes hops from the parent and defaults bot act to inform', () => {
    const parent = botMsg({ hops: 2 });
    const bot: ChatInput = { author: { kind: 'bot', id: 'art' }, text: 'hi', replyTo: parent.id };
    expect(toLedgerEntry(bot, parent)).toEqual({
      author: { kind: 'bot', id: 'art' },
      body: { type: 'chat', text: 'hi', mentions: [], replyTo: parent.id, act: 'inform', hops: 3 },
    });
    const first = toLedgerEntry(bot, null);
    expect(first.body).toMatchObject({ hops: 0, mentions: [] });
  });

  test('human act is kept as given, possibly undefined; non-chat parent counts as no parent', () => {
    const human: ChatInput = { author: { kind: 'human', id: 'alice' }, text: 'hi', mentions: ['art'] };
    const e = toLedgerEntry(human, null);
    expect(e.body).toMatchObject({ type: 'chat', mentions: ['art'], hops: 0 });
    expect((e.body as { act?: SpeechAct }).act).toBeUndefined();
    expect((toLedgerEntry({ ...human, act: 'request' }, null).body as { act?: SpeechAct }).act).toBe('request');
    const eventParent: LedgerEntry = { ...botMsg(), body: { type: 'event', event: { kind: 'projectStarted' } } };
    expect((toLedgerEntry(human, eventParent).body as { hops: number }).hops).toBe(0);
  });
});
