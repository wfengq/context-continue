// The append-only per-bot stream (spec 2026-11-06 §2.3): a snapshot, or the bot's previous stream
// unchanged plus what this request appends. Pure: everything comes from structured data (the
// board's items, the ledger's human messages, the brief's own segments) rendered with the core's
// single-item renderers, so marker text is the same as in a brief. Memory, notes and projection
// are compared item by item (diff.ts); the team segment is appended again whole when it changes.
import type { BriefDelta } from '../brief.js';
import { isHumanChat } from '../publicBoard.js';
import { contractLine, decisionBlock, directiveLine, failureBlock, itemLine, renderDelta, workstreamLine, type ItemPart } from '../render.js';
import type { LedgerEntry, ProjectBoard, StreamSegment, StreamSegmentKind } from '../types.js';
import { knownOf, sectionUpdate } from './diff.js';
import { BOARD_SECTIONS, ITEM_KINDS, type BoardSection, type ItemKind, type OwnKind, type Shown, type StreamState } from './state.js';

const NOTHING = '(nothing yet)';
/** Older human messages in a snapshot keep this many characters (code points). */
export const FOLDED_HUMAN_CHARS = 160;

export interface StreamConfig {
  restreamTokens: number;
  snapshotHumanKeep: number;
  count: (s: string) => number;
}

export interface StreamInput {
  /** The board with workstreams resolved. */
  board: ProjectBoard;
  /** Every human chat message so far, in ledger order. */
  humans: readonly LedgerEntry[];
  /** The bot's own segments as a brief renders them now (a snapshot shows these texts). */
  own: Record<OwnKind, string>;
  /** The items of the memory, notes and projection segments above (appends compare these). */
  items: Record<ItemKind, ItemPart[]>;
  /** A brief request's delta: rendered first in the tail, without the human messages the stream carries. */
  delta?: BriefDelta;
  /** This request's own part, appended last: the trigger, or a context's body and trigger. */
  tail: readonly { kind: StreamSegmentKind; text: string }[];
}

/** The segment titles of the item-level own segments. */
const TITLES: Record<ItemKind, string> = { memory: '# Your memory', workspace: '# Your notes', projection: '# Your part' };

type Plain = { kind: StreamSegmentKind; text: string };

/** Every project-wide item as the core renders it, per section, in board order. */
function projectWide(b: ProjectBoard): Record<BoardSection, Shown> {
  return {
    Goal: [['goal', b.goal.trim().length > 0 ? b.goal : NOTHING]],
    Constraints: [['constraints', b.constraints.length > 0 ? b.constraints.map(c => `- ${c}`).join('\n') : NOTHING]],
    Conventions: b.conventions.map(x => [x.id, itemLine(x)]),
    Contracts: b.contracts.map(c => [c.id, contractLine(c)]),
    Decisions: b.decisions.map(d => [d.id, decisionBlock(d)]),
    Failures: b.failures.map(f => [f.id, failureBlock(f)]),
    Workstreams: b.workstreams.map(w => [w.id, `- ${workstreamLine(w)}`]),
  };
}

const retiredOf = (b: ProjectBoard): Shown => (b.retiredContracts ?? []).map(c => [c.id, contractLine(c)]);

/** An older human message in a snapshot: one line, the first 160 characters of its text. */
function foldedLine(e: LedgerEntry): string {
  const text = e.body.type === 'chat' ? e.body.text.replace(/\s*\r?\n\s*/g, ' ') : '';
  const cps = Array.from(text);
  const short = cps.length > FOLDED_HUMAN_CHARS ? `${cps.slice(0, FOLDED_HUMAN_CHARS).join('')}…` : text;
  return `- [#${e.seq} ${e.author.id}] ${short}`;
}

/** How many of the oldest human messages a snapshot folds. */
const foldedCount = (humans: readonly LedgerEntry[], keep: number) => Math.max(0, humans.length - keep);

/** The snapshot's board: every project-wide item, retired contracts, and every human message (older ones folded). */
function snapshotBoard(items: Record<BoardSection, Shown>, retired: Shown, humans: readonly LedgerEntry[], keep: number): string {
  const out = ['# Project'];
  for (const s of BOARD_SECTIONS) {
    const lines = items[s].map(([, t]) => t);
    out.push('', `## ${s}`, ...(lines.length > 0 ? lines : [NOTHING]));
  }
  if (retired.length > 0) out.push('', '## Retired contracts', ...retired.map(([, t]) => t));
  const cut = foldedCount(humans, keep);
  if (cut > 0) out.push('', `## Earlier human messages (first ${FOLDED_HUMAN_CHARS} characters each)`, ...humans.slice(0, cut).map(foldedLine));
  const full = humans.slice(cut);
  out.push('', '## Human messages', ...(full.length > 0 ? full.map(directiveLine) : [NOTHING]));
  return out.join('\n');
}

/** The `# Project updates` text since `prev`, or null when nothing project-wide changed. */
function projectUpdates(prev: StreamState, items: Record<BoardSection, Shown>, retired: Shown, humans: readonly LedgerEntry[]): string | null {
  const lines: string[] = [];
  const fresh = humans.filter(h => h.seq > prev.humanSeq);
  if (fresh.length > 0) lines.push('## Human messages', ...fresh.map(directiveLine));
  const retiredNow = new Map(retired);
  for (const s of BOARD_SECTIONS) {
    const before = new Map(prev.board[s]);
    const now = new Map(items[s]);
    const changed = items[s].filter(([k, t]) => before.get(k) !== t).map(([, t]) => t);
    // A contract a replan retired is shown under Retired contracts instead.
    const gone = prev.board[s].filter(([k]) => !now.has(k) && !(s === 'Contracts' && retiredNow.has(k))).map(([k]) => k);
    const removed = gone.map(k => (s === 'Workstreams' ? `- workstream ${k} removed from the board` : `- [${k}] removed from the board`));
    if (changed.length + removed.length > 0) lines.push(`## ${s}`, ...changed, ...removed);
  }
  const shownRetired = new Map(prev.retired);
  const newlyRetired = retired.filter(([k, t]) => shownRetired.get(k) !== t).map(([, t]) => t);
  if (newlyRetired.length > 0) lines.push('## Retired contracts', ...newlyRetired);
  return lines.length > 0 ? ['# Project updates', '', ...lines].join('\n') : null;
}

/** True when the bot's next request is a snapshot: it has no stream yet, or more than the budget was appended since its last one. */
export function needsSnapshot(prev: StreamState | null, cfg: Pick<StreamConfig, 'restreamTokens'>): boolean {
  return prev === null || prev.appended > cfg.restreamTokens;
}

const cacheable = (xs: readonly Plain[]): StreamSegment[] => xs.map(x => ({ kind: x.kind, text: x.text, cacheable: true }));

/**
 * The delta a brief request appends: without human chat messages, which the stream carries
 * (project updates or the snapshot's board), except, on a snapshot, those it folds to 160
 * characters, which stay here in full. Null when nothing is left.
 */
function deltaText(delta: BriefDelta, folded: ReadonlySet<string>): string | null {
  const entries = delta.entries.filter(e => !isHumanChat(e) || folded.has(e.id));
  return entries.length + delta.changes.length + delta.omitted > 0 ? renderDelta(entries, delta.changes, delta.omitted) : null;
}

/**
 * The bot's request: a new snapshot (first request, or past the restream budget), or its previous
 * stream unchanged plus, in order, project updates, own-segment updates, then this request's tail.
 */
export function streamRequest(
  prev: StreamState | null,
  input: StreamInput,
  cfg: StreamConfig,
): { state: StreamState; segments: StreamSegment[]; snapshot: boolean } {
  const items = projectWide(input.board);
  const retired = retiredOf(input.board);
  const humanSeq = input.humans.at(-1)?.seq ?? prev?.humanSeq ?? 0;
  const snapshot = needsSnapshot(prev, cfg);
  const folded = snapshot ? new Set(input.humans.slice(0, foldedCount(input.humans, cfg.snapshotHumanKeep)).map(e => e.id)) : new Set<string>();
  const delta = input.delta === undefined ? null : deltaText(input.delta, folded);
  const tail: Plain[] = [...(delta === null ? [] : [{ kind: 'delta' as const, text: delta }]), ...input.tail];
  if (snapshot) {
    const segments: Plain[] = [
      { kind: 'common', text: input.own.common },
      { kind: 'memory', text: input.own.memory },
      { kind: 'workspace', text: input.own.workspace },
      { kind: 'board', text: snapshotBoard(items, retired, input.humans, cfg.snapshotHumanKeep) },
      { kind: 'projection', text: input.own.projection },
      ...tail,
    ];
    const state: StreamState = {
      version: 2,
      segments,
      appended: tail.reduce((n, x) => n + cfg.count(x.text), 0),
      board: items,
      retired,
      humanSeq,
      common: input.own.common,
      own: { memory: knownOf(input.items.memory), workspace: knownOf(input.items.workspace), projection: knownOf(input.items.projection) },
    };
    return { state, segments: cacheable(segments), snapshot: true };
  }
  const p = prev!;
  const added: Plain[] = [];
  const updates = projectUpdates(p, items, retired, input.humans);
  if (updates !== null) added.push({ kind: 'updates', text: updates });
  if (p.common !== input.own.common) added.push({ kind: 'common', text: input.own.common });
  const own = { ...p.own };
  for (const k of ITEM_KINDS) {
    const r = sectionUpdate(TITLES[k], p.own[k], input.items[k]);
    if (r.text !== null) added.push({ kind: k, text: r.text });
    own[k] = r.known;
  }
  added.push(...tail);
  const segments = [...p.segments, ...added];
  const state: StreamState = {
    version: 2,
    segments,
    appended: p.appended + added.reduce((n, x) => n + cfg.count(x.text), 0),
    board: items,
    retired,
    humanSeq: Math.max(p.humanSeq, humanSeq),
    common: input.own.common,
    own,
  };
  return { state, segments: cacheable(segments), snapshot: false };
}

/** The bot's own output (its reply and tool calls), appended to its stream; it counts toward the restream budget. */
export function appendOwnOutput(state: StreamState, text: string, count: (s: string) => number): StreamState {
  return { ...state, segments: [...state.segments, { kind: 'own', text }], appended: state.appended + count(text) };
}
