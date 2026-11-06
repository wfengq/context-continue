import type { Contract, Decision, Failure, Item, LedgerEntry, ProjectBoard, Workstream } from '@context-continue/core';

/**
 * Prototype (`--c-stream on`, spec 2026-11-05 §2): group C's request text as one append-only stream
 * per bot, with project-wide information routed to every bot. The core is driven as usual; only the
 * text sent to the model is reorganised here, from the core's own segments, the board and the ledger.
 */

/** Default budget of tokens appended after a snapshot before the next request restreams. */
export const DEFAULT_RESTREAM_TOKENS = 8000;

/** A segment the core built for this request (a brief, or a review/planning context). */
export interface CoreSegment {
  kind: string;
  text: string;
}

/** A stream segment: every one is flagged cacheable, so the R-B19 prefix rule alone decides. */
export interface StreamSegment {
  kind: string;
  text: string;
  cacheable: true;
}

export interface StreamInput {
  /** The core's segments for this request. */
  core: readonly CoreSegment[];
  /**
   * `brief`: a buildBrief — its projection belongs to a snapshot; delta and trigger are appended.
   * `context`: a review or planning context — its body (the projection segment) and trigger are appended.
   */
  shape: 'brief' | 'context';
  board: ProjectBoard;
  /** Every human chat entry so far, in ledger order. */
  humans: readonly LedgerEntry[];
  /**
   * `context` shape only: the bot's projection from a peek brief, for a snapshot (the core builds no
   * projection for a review or planning context). See `needsSnapshot`.
   */
  projection?: string;
}

/** The bot's own segments: whole in a snapshot; afterwards their changed lines are appended (R-S1, R-S2). */
const OWN = ['memory', 'workspace', 'projection'] as const;

const NOTHING = '(nothing yet)';
const DELTA_HEADING = '# Since you last looked';

// Field layouts as the core renders them (render.ts), so markers in item text survive unchanged.
const itemLine = (x: Item): string => `- [${x.id}] ${x.text}`;
const contractLine = (c: Contract): string => `- [${c.id}@v${c.version}] ${c.from} -> ${c.to}: ${c.spec}`;
function decisionBlock(d: Decision): string {
  const lines = [`- [${d.id}] ${d.text}`, `  why: ${d.rationale}`];
  if (d.rejected.length > 0) lines.push(`  rejected: ${d.rejected.join('; ')}`);
  lines.push(`  affects: ${d.affects.join(', ')}`);
  return lines.join('\n');
}
const failureBlock = (f: Failure): string =>
  [`- [${f.id}] tried: ${f.text}`, `  why it failed: ${f.reason}`, `  affects: ${f.affects.join(', ')}`].join('\n');
const workstreamLine = (w: Workstream): string => `- ${w.id} | ${w.title} | ${w.owner} | ${w.status}`;
/** A human message, verbatim, in the core's directive layout. */
const humanLine = (e: LedgerEntry): string => `- [#${e.seq} ${e.author.id}] ${e.body.type === 'chat' ? e.body.text : ''}`;
/** The core's delta line for a chat entry (R39b). */
const deltaLine = (e: LedgerEntry): string => `- #${e.seq} ${e.author.id} (id: ${e.id}): ${e.body.type === 'chat' ? e.body.text : ''}`;

/** The project-wide sections, in render order. Each entry: tracking key → rendered text. */
const SECTIONS = ['Goal', 'Constraints', 'Conventions', 'Contracts', 'Decisions', 'Failures', 'Workstreams'] as const;
type Section = (typeof SECTIONS)[number];

function projectWide(b: ProjectBoard): Map<Section, Map<string, string>> {
  const m = (xs: [string, string][]) => new Map(xs);
  return new Map<Section, Map<string, string>>([
    ['Goal', m([['goal', b.goal.trim().length > 0 ? b.goal : NOTHING]])],
    ['Constraints', m([['constraints', b.constraints.length > 0 ? b.constraints.map(c => `- ${c}`).join('\n') : NOTHING]])],
    ['Conventions', m(b.conventions.map(x => [x.id, itemLine(x)]))],
    ['Contracts', m(b.contracts.map(c => [c.id, contractLine(c)]))],
    ['Decisions', m(b.decisions.map(d => [d.id, decisionBlock(d)]))],
    ['Failures', m(b.failures.map(f => [f.id, failureBlock(f)]))],
    ['Workstreams', m(b.workstreams.map(w => [w.id, workstreamLine(w)]))],
  ]);
}

/** The snapshot's board: goal, constraints, every project-wide item and every human message, in full. */
function renderSnapshotBoard(items: Map<Section, Map<string, string>>, humans: readonly LedgerEntry[]): string {
  const out = ['# Project'];
  for (const s of SECTIONS) {
    const lines = [...items.get(s)!.values()];
    out.push('', `## ${s}`, ...(lines.length > 0 ? lines : [NOTHING]));
  }
  out.push('', '## Human messages', ...(humans.length > 0 ? humans.map(humanLine) : [NOTHING]));
  return out.join('\n');
}

interface BotStream {
  segments: StreamSegment[];
  /** Tokens appended since the latest snapshot (the snapshot's own delta and trigger included). */
  appended: number;
  /** Per section: key → text as last put in this stream. */
  known: Map<Section, Map<string, string>>;
  /** Ids of human chat entries in this stream. */
  humans: Set<string>;
  /** The latest text of each own segment in this stream. */
  own: Map<string, string>;
}

const seg = (kind: string, text: string): StreamSegment => ({ kind, text, cacheable: true });

/** One unit of a section's text: a line plus its indented continuation lines, under its `##` heading. */
interface Unit {
  heading: string | null;
  text: string;
}

/** The units of a rendered section, its first (`#`) line and blank lines left out. */
function unitsOf(text: string): Unit[] {
  const out: Unit[] = [];
  let heading: string | null = null;
  for (const line of text.split('\n').slice(1)) {
    if (line.trim() === '') continue;
    if (line.startsWith('## ')) heading = line;
    else if (line.startsWith('  ') && out.length > 0 && out[out.length - 1]!.heading === heading) out[out.length - 1]!.text += `\n${line}`;
    else out.push({ heading, text: line });
  }
  return out;
}

const SEEN = ' (seen)';
/** `- [key]` of a list item, or null. */
const itemKeyOf = (u: string): string | null => /^- \[[^\]]+\]/.exec(u)?.[0] ?? null;

/**
 * R-S2: what changed in one of the bot's own sections since the version this stream last showed, as
 * a `<heading> — updates` segment text, or null when nothing worth appending changed. New units are
 * listed under their `##` heading; a list item that disappeared gets `no longer: <item>`. Seen
 * compaction (an item replaced by its `(seen)` form) is not a change, and `(nothing yet)` carries nothing.
 */
export function sectionUpdate(before: string, now: string): string | null {
  const was = unitsOf(before);
  const is = unitsOf(now);
  const key = (u: Unit) => `${u.heading ?? ''}\u0000${u.text}`;
  const wasKeys = new Set(was.map(key));
  const isKeys = new Set(is.map(key));
  const added = is.filter(u => !wasKeys.has(key(u)) && u.text !== NOTHING);
  const removed = was.filter(u => !isKeys.has(key(u)));
  // An item that became its "(seen)" form: drop both sides.
  const compacted = new Set(
    added.filter(u => u.text.endsWith(SEEN)).flatMap(u => {
      const k = itemKeyOf(u.text);
      return k !== null && removed.some(r => r.heading === u.heading && itemKeyOf(r.text) === k) ? [`${u.heading ?? ''}\u0000${k}`] : [];
    }),
  );
  const isCompacted = (u: Unit) => {
    const k = itemKeyOf(u.text);
    return k !== null && compacted.has(`${u.heading ?? ''}\u0000${k}`);
  };
  const groups = new Map<string | null, string[]>();
  const put = (h: string | null, t: string) => groups.set(h, [...(groups.get(h) ?? []), t]);
  for (const u of added) if (!isCompacted(u)) put(u.heading, u.text);
  for (const u of removed) if (u.text.startsWith('- ') && !isCompacted(u)) put(u.heading, `no longer: ${u.text}`);
  if (groups.size === 0) return null;
  const title = `${now.split('\n')[0]} — updates`;
  const blocks = [...groups].map(([h, lines]) => (h === null ? lines : [h, ...lines]).join('\n'));
  // Headless lines first, then the `##` groups in order of first appearance.
  const top = groups.has(null) ? [blocks[[...groups.keys()].indexOf(null)]!] : [];
  return [title, ...top, ...blocks.filter((_, i) => [...groups.keys()][i] !== null)].join('\n\n');
}

/**
 * The core's delta without the human chat lines this stream already carries (each message reaches a
 * bot once); null when nothing is left.
 */
function trimDelta(text: string, carried: readonly LedgerEntry[]): string | null {
  let t = text;
  for (const e of carried) {
    const line = deltaLine(e);
    t = t.split(`\n${line}\n`).join('\n');
    if (t.endsWith(`\n${line}`)) t = t.slice(0, -line.length - 1);
  }
  const body = t.startsWith(DELTA_HEADING) ? t.slice(DELTA_HEADING.length).trim() : t.trim();
  return body === '' || body === NOTHING ? null : t;
}

export function briefStream(opts: { restreamTokens: number; count: (text: string) => number }) {
  const streams = new Map<string, BotStream>();

  const needsSnapshot = (botId: string): boolean => {
    const st = streams.get(botId);
    return st === undefined || st.appended > opts.restreamTokens;
  };

  return {
    /** True when `botId`'s next request is a snapshot (the host then passes a peeked projection for a context request). */
    needsSnapshot,
    /**
     * The segments of `botId`'s request: its stream so far, unchanged, plus what this request appends;
     * or, on its first request and once more than `restreamTokens` were appended since its snapshot, a
     * new snapshot followed by this request's own part.
     */
    request(botId: string, r: StreamInput): { segments: StreamSegment[]; snapshot: boolean } {
      const byKind = (k: string) => r.core.find(s => s.kind === k);
      const items = projectWide(r.board);
      // The bot's own segments in this request: a context's projection segment is its body, not a projection.
      const own = new Map<string, string>();
      for (const k of OWN) {
        const text = k === 'projection' && r.shape === 'context' ? r.projection : byKind(k)?.text;
        if (text !== undefined) own.set(k, text);
      }
      let st = streams.get(botId);
      const snapshot = needsSnapshot(botId);
      const added: StreamSegment[] = [];
      if (snapshot) {
        const head = ['common', 'memory', 'workspace'].flatMap(k => {
          const s = byKind(k);
          return s ? [seg(k, s.text)] : [];
        });
        head.push(seg('board', renderSnapshotBoard(items, r.humans)));
        const projection = own.get('projection');
        if (projection !== undefined) head.push(seg('projection', projection));
        st = { segments: head, appended: 0, known: items, humans: new Set(r.humans.map(h => h.id)), own };
        streams.set(botId, st);
      } else {
        const s = st!;
        const lines: string[] = [];
        const fresh = r.humans.filter(h => !s.humans.has(h.id));
        if (fresh.length > 0) lines.push('## Human messages', ...fresh.map(humanLine));
        for (const sec of SECTIONS) {
          const now = items.get(sec)!;
          const before = s.known.get(sec)!;
          const changed = [...now].filter(([k, t]) => before.get(k) !== t).map(([, t]) => t);
          const gone = [...before.keys()].filter(k => !now.has(k));
          const removed = gone.map(k => (sec === 'Workstreams' ? `- workstream ${k} removed from the board` : `- [${k}] removed from the board`));
          if (changed.length + removed.length > 0) lines.push(`## ${sec}`, ...changed, ...removed);
        }
        if (lines.length > 0) added.push(seg('updates', ['# Project updates', '', ...lines].join('\n')));
        for (const h of fresh) s.humans.add(h.id);
        s.known = items;
        for (const [k, text] of own) {
          const before = s.own.get(k);
          if (before === text) continue;
          const update = before === undefined ? text : sectionUpdate(before, text);
          if (update !== null) added.push(seg(k, update));
          // The next diff is against what the stream has now effectively shown.
          s.own.set(k, text);
        }
      }
      const s = st!;
      if (r.shape === 'brief') {
        const delta = byKind('delta');
        const carried = r.humans.filter(h => s.humans.has(h.id));
        const kept = delta ? trimDelta(delta.text, carried) : null;
        if (kept !== null) added.push(seg('delta', kept));
      } else {
        const body = byKind('projection');
        if (body) added.push(seg('projection', body.text));
      }
      const trigger = byKind('trigger');
      if (trigger) added.push(seg('trigger', trigger.text));
      s.segments = [...s.segments, ...added];
      s.appended += added.reduce((n, x) => n + opts.count(x.text), 0);
      return { segments: s.segments, snapshot };
    },
  };
}
