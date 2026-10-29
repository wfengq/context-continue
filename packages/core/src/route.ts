import type { Options } from './options.js';
import type { ChatInput, LedgerEntry, SpeechAct, Wake, Workstream } from './types.js';

type ChatBody = Extract<LedgerEntry['body'], { type: 'chat' }>;

/** Input handed to the optional routing model (`models.route`). */
export interface RouteInput {
  boardPublic: string;
  recent: LedgerEntry[];
  candidates: { botId: string; workstreams: string[] }[];
  message: LedgerEntry;
}

export interface RouteContext {
  lead: string;
  members: Set<string>;
  workstreams: Workstream[];
  /**
   * R32: bot chat entries (before this one) in the reply tree of the human chat message this entry
   * descends from through `replyTo`; null when its chain has no human root (only maxHops applies).
   */
  botTurnsUnderHuman: number | null;
  parent: LedgerEntry | null;
  options: Required<Options>;
  route?: (i: RouteInput) => Promise<string[]>;
  /** Lazy: only called when the routing model is about to be invoked. */
  routeInput: () => Promise<RouteInput>;
}

const WAKING_ACTS: ReadonlySet<SpeechAct> = new Set(['request', 'query', 'propose']);

function chatBody(entry: LedgerEntry | null): ChatBody | null {
  return entry && entry.body.type === 'chat' ? entry.body : null;
}

export function toLedgerEntry(
  input: ChatInput,
  parent: LedgerEntry | null,
): Omit<LedgerEntry, 'seq' | 'id' | 'createdAt' | 'projectId'> {
  const parentBody = chatBody(parent);
  const act = input.act ?? (input.author.kind === 'bot' ? 'inform' : undefined);
  return {
    author: { kind: input.author.kind, id: input.author.id },
    body: {
      type: 'chat',
      text: input.text,
      mentions: input.mentions ?? [],
      replyTo: input.replyTo,
      act,
      hops: parentBody ? parentBody.hops + 1 : 0,
    },
  };
}

const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function occurs(needle: string, text: string): boolean {
  if (needle === '') return false;
  if (CJK.test(needle)) return text.toLowerCase().includes(needle.toLowerCase());
  return new RegExp(`(?<![A-Za-z0-9_])${escapeRegExp(needle)}(?![A-Za-z0-9_])`, 'i').test(text);
}

/** Ids of workstreams whose id or title occurs in the text, in workstream order. */
export function matchWorkstreams(text: string, workstreams: Workstream[]): string[] {
  const out: string[] = [];
  for (const w of workstreams) {
    if (out.includes(w.id)) continue;
    if (occurs(w.id, text) || occurs(w.title, text)) out.push(w.id);
  }
  return out;
}

/** Mentioned members plus the parent's author when that is a bot member; deduped, first-seen order. */
function addressed(body: ChatBody, ctx: RouteContext): Wake[] {
  const wakes: Wake[] = [];
  const seen = new Set<string>();
  const add = (botId: string, detail: string) => {
    if (!ctx.members.has(botId) || seen.has(botId)) return;
    seen.add(botId);
    wakes.push({ botId, reason: 'mentioned', detail });
  };
  for (const id of body.mentions) add(id, 'mentioned in a chat message');
  if (ctx.parent && ctx.parent.author.kind === 'bot') add(ctx.parent.author.id, 'replied to in a chat message');
  return wakes;
}

/**
 * R32: the nearest human chat ancestor of `entry` along its `replyTo` chain (the entry itself when it
 * is human chat), and how many bot chat entries before `entry` descend from that same human message.
 * `turns` is null when the chain has no human root.
 */
export function humanChain(
  entry: LedgerEntry,
  ledger: LedgerEntry[],
): { root: LedgerEntry; turns: number } | { root: null; turns: null } {
  const byId = new Map(ledger.map((e) => [e.id, e]));
  const roots = new Map<string, LedgerEntry | null>();
  const rootOf = (start: LedgerEntry): LedgerEntry | null => {
    const path: LedgerEntry[] = [];
    let cur: LedgerEntry | undefined = start;
    let found: LedgerEntry | null = null;
    while (cur) {
      const known = roots.get(cur.id);
      if (known !== undefined) {
        found = known;
        break;
      }
      const body = chatBody(cur);
      if (!body) break;
      if (cur.author.kind === 'human') {
        found = cur;
        break;
      }
      path.push(cur);
      const parent: LedgerEntry | undefined = body.replyTo === undefined ? undefined : byId.get(body.replyTo);
      // replies point at earlier entries; anything else is treated as the end of the chain
      cur = parent && parent.seq < cur.seq ? parent : undefined;
    }
    for (const e of path) roots.set(e.id, found);
    return found;
  };
  const root = rootOf(entry);
  if (!root) return { root: null, turns: null };
  const turns = ledger.filter(
    (e) => e.seq < entry.seq && e.author.kind === 'bot' && chatBody(e) !== null && rootOf(e)?.id === root.id,
  ).length;
  return { root, turns };
}

function dedupe(wakes: Wake[]): Wake[] {
  const seen = new Set<string>();
  return wakes.filter((w) => !seen.has(w.botId) && !!seen.add(w.botId));
}

/** Wakes for a bot chat message before the per-human-message cap: speech act, targets, hop cap. */
function botWakes(entry: LedgerEntry, body: ChatBody, ctx: RouteContext): Wake[] {
  if (!body.act || !WAKING_ACTS.has(body.act)) return [];
  const targets = addressed(body, ctx).filter((w) => w.botId !== entry.author.id);
  if (targets.length === 0) return [];
  if (body.hops >= ctx.options.maxHops) {
    if (entry.author.id === ctx.lead) return [];
    return [
      {
        botId: ctx.lead,
        reason: 'needsLead',
        detail: `reply chain reached the hops limit (${ctx.options.maxHops}); lead to decide`,
      },
    ];
  }
  return dedupe(targets);
}

export async function routeChat(
  entry: LedgerEntry,
  ctx: RouteContext,
): Promise<{ wakes: Wake[]; limitReached: boolean }> {
  const body = chatBody(entry);
  if (!body) return { wakes: [], limitReached: false };

  if (entry.author.kind === 'bot') {
    const wakes = botWakes(entry, body, ctx);
    // R32: the cap only stops an entry that would otherwise have woken someone.
    const capped = ctx.botTurnsUnderHuman !== null && ctx.botTurnsUnderHuman >= ctx.options.maxBotTurnsPerHumanMessage;
    if (capped && wakes.length > 0) return { wakes: [], limitReached: true };
    return { wakes, limitReached: false };
  }

  // Human-authored (or system) message: never limited.
  const mentioned = addressed(body, ctx);
  if (mentioned.length > 0) return { wakes: mentioned, limitReached: false };

  const wakes: Wake[] = [];
  const matched = matchWorkstreams(body.text, ctx.workstreams);
  for (const id of matched) {
    const w = ctx.workstreams.find((x) => x.id === id);
    if (w && w.status !== 'blocked' && ctx.members.has(w.owner)) {
      wakes.push({ botId: w.owner, reason: 'routed', detail: `message matches workstream "${w.title}"` });
    }
  }
  if (wakes.length > 0) return { wakes: dedupe(wakes), limitReached: false };

  if (ctx.route) {
    try {
      const ids = await ctx.route(await ctx.routeInput());
      const routed = ids
        .filter((id) => ctx.members.has(id))
        .map((botId): Wake => ({ botId, reason: 'routed', detail: 'selected by the routing model' }));
      return { wakes: dedupe(routed), limitReached: false };
    } catch {
      return {
        wakes: [{ botId: ctx.lead, reason: 'routed', detail: 'routing model failed; falling back to the lead' }],
        limitReached: false,
      };
    }
  }
  return {
    wakes: [{ botId: ctx.lead, reason: 'routed', detail: 'no workstream matched and no routing model; asking the lead' }],
    limitReached: false,
  };
}
