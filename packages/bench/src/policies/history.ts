import { BASE_TEMPLATE, type Segment } from '../runner.js';

/**
 * The single cacheable rule every group uses (R-B19): the cacheable part of a request is the longest
 * leading run of its segments whose text is identical, segment by segment, to that bot's previous
 * request. On a bot's first request (`prev` is null) only the first `firstRequest` segments — the
 * shared fixed template — count, as in every group. Returns one flag per segment of `next`.
 */
export function prefixCacheable(prev: readonly string[] | null, next: readonly string[], firstRequest: number): boolean[] {
  if (prev === null) return next.map((_, i) => i < firstRequest);
  let run = 0;
  while (run < next.length && run < prev.length && next[run] === prev[run]) run++;
  return next.map((_, i) => i < run);
}

/**
 * Segments of an append-only history request: the template, then one segment per line. The first
 * `prevLen` lines were the bot's previous request, so with the template they are the identical
 * prefix (R-B5 / R-B19); lines appended since are not cacheable.
 */
export function historySegments(lines: readonly string[], prevLen: number): Segment[] {
  return [{ text: BASE_TEMPLATE, cacheable: true }, ...lines.map((text, i) => ({ text, cacheable: i < prevLen }))];
}

/** A shared-log entry: a plain string is read by everyone; `only` limits it to its author's own view. */
export type LogLine = string | { text: string; only: string };

interface BotView {
  /** The bot's own append-only history: shared-log entries it has read plus its private task lines. */
  lines: string[];
  /** Read cursor: how many shared-log entries are already in `lines`. */
  cursor: number;
  /** Length of `lines` at its previous request. */
  prevLen: number;
}

/**
 * Per-bot append-only readers of one shared log (groups B and D). On each request a bot appends the
 * log entries after its cursor (never twice), then its task line if any; the request is
 * `historySegments` over its lines.
 */
export function historyReader(): { segmentsFor(botId: string, log: readonly LogLine[], task: string | null): Segment[] } {
  const views = new Map<string, BotView>();
  return {
    segmentsFor(botId, log, task) {
      let v = views.get(botId);
      if (!v) views.set(botId, (v = { lines: [], cursor: 0, prevLen: 0 }));
      for (const l of log.slice(v.cursor)) {
        if (typeof l === 'string') v.lines.push(l);
        else if (l.only === botId) v.lines.push(l.text);
      }
      v.cursor = log.length;
      if (task !== null) v.lines.push(task);
      const segments = historySegments(v.lines, v.prevLen);
      v.prevLen = v.lines.length;
      return segments;
    },
  };
}
