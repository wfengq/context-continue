import { BASE_TEMPLATE, type Policy, type RunContext, type Segment } from '../runner.js';
import { fmtBot, fmtHuman, fmtOps, fmtTask } from '../text.js';
import { prefixCacheable } from './history.js';
import type { Scenario } from '../types.js';

/** Room lines a member sees at its first wake. */
export const FIRST_LOOK = 12;
/** At most this many unseen room lines at later wakes. */
export const DELTA_MAX = 24;
/** Of those, at most this many from before the latest human message (DS Bot ROOM_EARLIER_MAX, R-B8). */
export const EARLIER_MAX = 8;
/** Group memory is cut to this many characters. */
export const MEMORY_MAX_CHARS = 8000;
/** Relay limit = members × this. */
export const RELAYS_PER_MEMBER = 3;

export interface DsBotOptions {
  window: number;
  compactRatio: number;
  summaryTokens: number;
}

interface RoomLine {
  seq: number;
  /** Author bot, or null for a human message. */
  botId: string | null;
  text: string;
}

interface Session {
  /** Append-only session history (until compaction): room lines shown, task lines, own replies, tool lines, deliverables. */
  history: string[];
  /** Segment texts of the previous request, or null before the first (R-B19). */
  prev: string[] | null;
  /** Seq of the newest room line shown so far; undefined before the first wake. */
  seen: number | undefined;
  /** Group memory text, fixed at the first wake. */
  memory: string;
}

/** The group memory text: goal, constraints and the conventions that have appeared so far, cut to 8000 chars. */
export function groupMemory(s: Scenario, conventions: string[]): string {
  const list = (xs: string[]) => (xs.length > 0 ? xs.join('; ') : 'none');
  const text = `[group memory] goal: ${s.goal} | constraints: ${list(s.constraints)} | conventions: ${list(conventions)}`;
  return text.slice(0, MEMORY_MAX_CHARS);
}

/**
 * A deterministic summary line of exactly `tokens` tokens under `defaultCountTokens`: ASCII only
 * (no bot id, which may contain wide characters), 4 × tokens characters → ceil(chars / 4) = tokens.
 * `markers` (ASCII fact markers) come first, in order, while they fit; the rest are dropped.
 */
export function summaryLine(tokens: number, markers: string[] = []): string {
  const head = '[summary] Earlier conversation condensed.';
  const len = tokens * 4;
  // Markers first, in the given order, while they fit the budget; the rest are dropped.
  const kept: string[] = [];
  let used = 0;
  for (const m of markers) {
    const next = used + (kept.length > 0 ? 1 : 0) + m.length;
    if (next > len) break;
    kept.push(m);
    used = next;
  }
  const text = kept.length > 0 ? `${kept.join(' ')} ${head}` : head;
  return text.length >= len ? text.slice(0, len) : text + '.'.repeat(len - text.length);
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Group E (DS Bot-style group chat, approximating DS Bot `f823773`).
 *
 * The room log holds human messages and scripted bot replies. Each member has a group session: its
 * append-only history plus a group-memory segment (goal, constraints, conventions so far) frozen at
 * its first wake. When woken, a member is shown the room lines it has not seen: the last 12 lines at
 * its first wake; later, the lines from others since its last wake, of which those before the latest
 * human message are cut to the newest 8 (R-B8), and then all to the newest 24 (its own lines are
 * already in its session). Its scripted reply goes to the room and its own history; tool lines and
 * deliverables stay in its own history. Extra requests are answered with `idleReply`, which is a
 * pass (R-B10): it costs the request but is posted nowhere (room or own history) and wakes nobody.
 *
 * Request = template + memory + history. Cacheable (R-B19): the leading run identical to the
 * member's previous request — template, frozen memory and the history it sent then; on its first
 * request only the template. When history exceeds window × ratio,
 * everything but the newest shown lines / trigger is replaced by one summary line of summaryTokens
 * tokens (keeping the markers of scenario facts seen in the compacted content, first; the favourable
 * assumption of spec §5); that request is entirely uncacheable.
 *
 * Wakes: a human message with mentions wakes the mentioned members, without mentions every member
 * (lead first, then scenario order). `@<id>` in a bot reply wakes that member. Bot-triggered wakes
 * since the last human message are limited to members × 3; past it they are parked (one pause
 * counted per pause) and, after the next human message and its own wakes, resume in order as
 * bot-triggered wakes of the new relay window (R-B9). A wake is an extra request unless merged.
 */
export function dsBotPolicy(opts: DsBotOptions): Policy {
  if (opts.summaryTokens >= opts.window * opts.compactRatio) {
    throw new Error(`group E: summaryTokens (${opts.summaryTokens}) must be below window × compactRatio (${opts.window * opts.compactRatio})`);
  }
  const room: RoomLine[] = [];
  const sessions = new Map<string, Session>();
  const versions = new Map<string, number>();
  const conventions: string[] = [];
  /** Bot @ wakes dropped at the relay limit, in order, each member once. */
  const parked: string[] = [];
  let relays = 0;
  let paused = false;
  let pauses = 0;
  let compactions = 0;

  const roster = (s: Scenario): string[] => {
    const ids = s.employees.map(e => e.botId);
    return ids.includes(s.lead) ? [s.lead, ...ids.filter(b => b !== s.lead)] : ids;
  };

  const post = (botId: string | null, text: string) => room.push({ seq: room.length + 1, botId, text });

  const unseen = (memberId: string, seen: number | undefined): string[] => {
    if (seen === undefined) return room.slice(-FIRST_LOOK).map(l => l.text);
    const lines = room.filter(l => l.seq > seen && l.botId !== memberId);
    const latestHuman = room.findLast(l => l.botId === null)?.seq ?? 0;
    const earlier = lines.filter(l => l.seq < latestHuman).slice(-EARLIER_MAX);
    const current = lines.filter(l => l.seq >= latestHuman);
    return [...earlier, ...current].slice(-DELTA_MAX).map(l => l.text);
  };

  const request = async (ctx: RunContext, botId: string, step: number, kind: 'scripted' | 'extra', task: string | null) => {
    let s = sessions.get(botId);
    if (!s) {
      s = { history: [], prev: null, seen: undefined, memory: groupMemory(ctx.scenario, conventions) };
      sessions.set(botId, s);
    }
    const fresh = unseen(botId, s.seen);
    s.seen = room.length;
    if (task !== null) fresh.push(task);

    const historyTokens = [...s.history, ...fresh].reduce((n, t) => n + ctx.count(t), 0);
    const compact = s.history.length > 0 && historyTokens > opts.window * opts.compactRatio;
    if (compact) {
      // The summary keeps the markers of scenario facts that appeared in the compacted content (spec §5).
      const compacted = s.history.join('\n');
      const markers = (ctx.scenario.facts ?? []).map(f => f.marker).filter(m => compacted.includes(m));
      s.history = [summaryLine(opts.summaryTokens, markers)];
      compactions++;
    }
    s.history.push(...fresh);
    // R-B19: identical leading run vs the previous request; first request: template only (so the
    // frozen memory counts from the second request); a compacting request caches nothing (spec §5 E).
    const texts = [BASE_TEMPLATE, s.memory, ...s.history];
    const cacheable = compact ? texts.map(() => false) : prefixCacheable(s.prev, texts, 1);
    const segments: Segment[] = texts.map((text, i) => ({ text, cacheable: cacheable[i]! }));
    s.prev = texts;
    const out = await ctx.call({ botId, step, kind, segments });
    return { session: s, out };
  };

  /** An extra request; its idle reply is a pass, posted nowhere (R-B10). */
  const wake = async (ctx: RunContext, botId: string, index: number) => {
    if (!ctx.isMerged(botId, index)) await request(ctx, botId, index, 'extra', null);
  };

  /** One bot-triggered wake: counted against the relay limit, parked past it. */
  const relayWake = async (ctx: RunContext, target: string, index: number) => {
    if (relays >= ctx.scenario.employees.length * RELAYS_PER_MEMBER) {
      if (!paused) {
        paused = true;
        pauses++;
      }
      if (!parked.includes(target)) parked.push(target);
      return;
    }
    relays++;
    await wake(ctx, target, index);
  };

  const mentionsIn = (ctx: RunContext, author: string, reply: string): string[] =>
    roster(ctx.scenario).filter(id => id !== author && new RegExp(`@${escapeRe(id)}(?![\\w-])`).test(reply));

  return {
    group: 'E',
    async onStep(step, index, ctx) {
      if (step.kind === 'human') {
        post(null, fmtHuman(ctx.scenario.owner, step.text));
        relays = 0;
        paused = false;
        const mentioned = step.mentions;
        const everyone = roster(ctx.scenario);
        const targets = mentioned && mentioned.length > 0 ? everyone.filter(b => mentioned.includes(b)) : everyone;
        for (const botId of targets) await wake(ctx, botId, index);
        // Parked wakes resume after the human's own wakes, skipping members it already woke (R-B9).
        const resumed = parked.splice(0).filter(b => !targets.includes(b));
        for (const botId of resumed) await relayWake(ctx, botId, index);
        return;
      }
      const actor = ctx.actorOf(step);
      const { session, out } = await request(ctx, actor, index, 'scripted', fmtTask(actor, step));
      session.history.push(fmtBot(actor, out.reply), ...fmtOps(actor, out.ops, versions, false));
      post(actor, fmtBot(actor, out.reply));
      if (step.kind === 'review') conventions.push(...(step.conventions ?? []));
      for (const target of mentionsIn(ctx, actor, out.reply)) await relayWake(ctx, target, index);
    },
    async finish() {
      return { compactions, pauses, coreErrors: 0 };
    },
  };
}
