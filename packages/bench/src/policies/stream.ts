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
}

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
}

const seg = (kind: string, text: string): StreamSegment => ({ kind, text, cacheable: true });

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

  return {
    /**
     * The segments of `botId`'s request: its stream so far, unchanged, plus what this request appends;
     * or, on its first request and once more than `restreamTokens` were appended since its snapshot, a
     * new snapshot followed by this request's own part.
     */
    request(botId: string, r: StreamInput): { segments: StreamSegment[]; snapshot: boolean } {
      const byKind = (k: string) => r.core.find(s => s.kind === k);
      const items = projectWide(r.board);
      let st = streams.get(botId);
      const snapshot = st === undefined || st.appended > opts.restreamTokens;
      const added: StreamSegment[] = [];
      if (snapshot) {
        const head = ['common', 'memory', 'workspace'].flatMap(k => {
          const s = byKind(k);
          return s ? [seg(k, s.text)] : [];
        });
        head.push(seg('board', renderSnapshotBoard(items, r.humans)));
        const projection = byKind('projection');
        if (r.shape === 'brief' && projection) head.push(seg('projection', projection.text));
        st = { segments: head, appended: 0, known: items, humans: new Set(r.humans.map(h => h.id)) };
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
