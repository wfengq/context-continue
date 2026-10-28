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
  /** Bot chat entries since the most recent human chat message. */
  botTurnsSinceHuman: number;
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

function dedupe(wakes: Wake[]): Wake[] {
  const seen = new Set<string>();
  return wakes.filter((w) => !seen.has(w.botId) && !!seen.add(w.botId));
}

export async function routeChat(
  entry: LedgerEntry,
  ctx: RouteContext,
): Promise<{ wakes: Wake[]; limitReached: boolean }> {
  const body = chatBody(entry);
  if (!body) return { wakes: [], limitReached: false };

  if (entry.author.kind === 'bot') {
    if (ctx.botTurnsSinceHuman >= ctx.options.maxBotTurnsPerHumanMessage) return { wakes: [], limitReached: true };
    if (!body.act || !WAKING_ACTS.has(body.act)) return { wakes: [], limitReached: false };
    const targets = addressed(body, ctx).filter((w) => w.botId !== entry.author.id);
    if (targets.length === 0) return { wakes: [], limitReached: false };
    if (body.hops >= ctx.options.maxHops) {
      if (entry.author.id === ctx.lead) return { wakes: [], limitReached: false };
      return {
        wakes: [
          {
            botId: ctx.lead,
            reason: 'needsLead',
            detail: `reply chain reached the hops limit (${ctx.options.maxHops}); lead to decide`,
          },
        ],
        limitReached: false,
      };
    }
    return { wakes: dedupe(targets), limitReached: false };
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
