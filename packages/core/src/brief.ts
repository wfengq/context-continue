// Brief assembly (design spec 5.2): seven segments in a fixed order, a per-bot projection with
// seen-item compaction, a relevance-filtered delta, and budget trimming.
import { writeScopeOverlaps } from './board/diff.js';
import type { EmployeeRegistry } from './employees.js';
import { BudgetTooSmallError } from './errors.js';
import { assertMember, defaultMemory, defaultWorkspace, renderTeam } from './members.js';
import type { Options } from './options.js';
import { isHumanChat, publicBoardView, type PublicBoardSwitches } from './publicBoard.js';
import {
  itemKey,
  memoryItems,
  renderBoardPublic,
  renderDelta,
  renderMemory,
  renderProjection,
  renderTrigger,
  renderWorkspace,
  untrimmedKeeps,
  workspaceItems,
  type ItemPart,
  type Projection,
} from './render.js';
import type { ContextTrigger } from './contexts.js';
import { matchWorkstreams } from './route.js';
import type { Store } from './store/store.js';
import type {
  AppliedOp,
  ContextBundle,
  EmployeeMemory,
  LedgerEntry,
  ProjectBoard,
  Segment,
  SegmentKind,
  ToolDefinition,
  Workspace,
  Workstream,
} from './types.js';
import { resolveWorkstreams, type WorkstreamSource } from './workstreams/source.js';

export interface BriefDeps {
  store: Store;
  projectId: string;
  source: WorkstreamSource;
  employees: EmployeeRegistry;
  count: (s: string) => number;
  // Not read here: recentKeep is applied by condensing (Task 11), so stored notes and memories are already bounded.
  options: Required<Options>;
  tools: (botId: string, board: ProjectBoard) => ToolDefinition[];
  /** Optional public board sections (spec 2026-11-04); absent means every switch is off. */
  publicBoard?: Required<PublicBoardSwitches>;
}

export interface BriefOptions {
  maxTokens: number;
  /** Render without marking anything as seen or advancing the bot's pointers. */
  peek?: boolean;
  trigger?: ContextTrigger;
}

type Overlaps = ReturnType<typeof writeScopeOverlaps>;

// Key order is the segment order: stable-first, so the leading run a cache can reuse is as long as possible.
const CACHEABLE: Record<SegmentKind, boolean> = {
  common: true,
  memory: true,
  workspace: true,
  board: true,
  projection: false,
  delta: false,
  trigger: false,
};

// ---------------------------------------------------------------------------
// projection
// ---------------------------------------------------------------------------

function projectionFor(board: ProjectBoard, workstreams: Workstream[], w: Workstream, overlaps: Overlaps): Projection {
  const affects = (x: { affects: string[] }) => x.affects.includes(w.id);
  const byId = new Map(workstreams.map(x => [x.id, x]));
  const upstream: Projection['upstream'] = [];
  for (const depId of w.dependsOn) {
    const dep = byId.get(depId);
    if (!dep || dep.deliverables.length === 0) continue;
    const latest = dep.deliverables.reduce((a, b) => (b.version >= a.version ? b : a));
    upstream.push({ workstream: dep, deliverable: latest });
  }
  const others: Projection['overlaps'] = [];
  for (const o of overlaps) {
    const otherId = o.a === w.id ? o.b : o.b === w.id ? o.a : undefined;
    const other = otherId === undefined ? undefined : byId.get(otherId);
    if (other) others.push({ other, prefix: o.prefix });
  }
  return {
    workstream: w,
    contracts: board.contracts.filter(c => c.from === w.id || c.to === w.id),
    decisions: board.decisions.filter(affects),
    facts: board.facts.filter(affects),
    failures: board.failures.filter(affects),
    upstream,
    overlaps: others,
  };
}

const emptyProjection = (): Projection => ({
  workstream: null,
  contracts: [],
  decisions: [],
  facts: [],
  failures: [],
  upstream: [],
  overlaps: [],
});

/** One projection per workstream the bot owns, in workstream order; a single empty one when it owns none. */
export function selectProjections(
  board: ProjectBoard,
  workstreams: Workstream[],
  botId: string,
  overlaps: Overlaps,
): Projection[] {
  const owned = workstreams.filter(w => w.owner === botId);
  if (owned.length === 0) return [emptyProjection()];
  return owned.map(w => projectionFor(board, workstreams, w, overlaps));
}

/** The projection for the bot's first owned workstream (`workstream: null` when it owns none). */
export function selectProjection(
  board: ProjectBoard,
  workstreams: Workstream[],
  botId: string,
  overlaps: Overlaps,
): Projection {
  return selectProjections(board, workstreams, botId, overlaps)[0]!;
}

// ---------------------------------------------------------------------------
// delta
// ---------------------------------------------------------------------------

type DeltaItem = { at: number; entry: LedgerEntry } | { at: number; change: AppliedOp };

async function relevantEntries(
  deps: BriefDeps,
  botId: string,
  isLead: boolean,
  own: Workstream[],
  fromSeq: number,
  toSeq: number,
): Promise<LedgerEntry[]> {
  const window = (await deps.store.read(deps.projectId, fromSeq)).filter(e => e.seq <= toSeq);
  const ownIds = new Set(own.map(w => w.id));
  const ownDeliverables = new Set(own.flatMap(w => w.deliverables.map(d => d.id)));

  const authors = new Map(window.map(e => [e.id, e.author.id]));
  const missing = window.some(
    e => e.body.type === 'chat' && e.body.replyTo !== undefined && !authors.has(e.body.replyTo),
  );
  if (missing && fromSeq > 1) {
    for (const e of await deps.store.read(deps.projectId, 1, fromSeq - 1)) authors.set(e.id, e.author.id);
  }

  // Spec 2026-11-04 section 2.1: with directives on, human chat is on the public board, so no delta repeats it.
  const directivesOn = deps.publicBoard?.directives === true;
  return window.filter(e => {
    if (e.author.id === botId) return false; // the bot knows what it said or did
    if (directivesOn && isHumanChat(e)) return false;
    const body = e.body;
    if (body.type === 'chat') {
      if (isLead && e.author.kind === 'human') return true; // the lead coordinates everything, like R33
      if (body.mentions.includes(botId)) return true;
      if (body.replyTo !== undefined && authors.get(body.replyTo) === botId) return true;
      return matchWorkstreams(body.text, own).length > 0;
    }
    const ev = body.event;
    switch (ev.kind) {
      case 'deliverableSubmitted':
      case 'blocked':
        // R33: the lead coordinates every workstream, so it sees these for all of them.
        return isLead || ownIds.has(ev.workstreamId);
      case 'reviewPassed':
      case 'reviewFailed':
        return ownDeliverables.has(ev.deliverableId);
      default:
        // boardMerged and archived are covered by the board changes; the rest is not workstream-scoped.
        return false;
    }
  });
}

async function relevantChanges(
  deps: BriefDeps,
  board: ProjectBoard,
  own: Workstream[],
  sinceVersion: number,
): Promise<{ at: number; change: AppliedOp }[]> {
  if (sinceVersion === 0) return [];
  const ownIds = new Set(own.map(w => w.id));
  const related = new Set<string>(ownIds);
  for (const x of [...board.decisions, ...board.facts, ...board.failures]) {
    if (x.affects.some(a => ownIds.has(a))) related.add(x.id);
  }
  for (const c of board.contracts) if (ownIds.has(c.from) || ownIds.has(c.to)) related.add(c.id);

  const out: { at: number; change: AppliedOp }[] = [];
  for (const ch of await deps.store.getBoardChanges(deps.projectId, sinceVersion)) {
    for (const op of ch.ops) if (op.touched.some(id => related.has(id))) out.push({ at: ch.mergedAt, change: op });
  }
  return out;
}

// ---------------------------------------------------------------------------
// seen-item keys
// ---------------------------------------------------------------------------

/** Every key the seen-item rule can refer to on this board (`itemKey` of each item and contract). */
export function boardItemKeys(board: ProjectBoard): Set<string> {
  return new Set<string>([
    ...[...board.conventions, ...board.openQuestions, ...board.decisions, ...board.facts, ...board.failures].map(x => x.id),
    ...board.contracts.map(itemKey),
  ]);
}

/**
 * Second phase of the seen-item rule (spec 5.2): the bot acted, so the items its latest brief showed
 * in full count as seen. Keys no longer on the board are dropped. A bot without a workspace, or
 * with nothing pending, is left untouched.
 */
export async function confirmSeen(store: Store, projectId: string, botId: string): Promise<void> {
  const ws = await store.getWorkspace(projectId, botId);
  const pending = ws?.pendingSeenItemIds ?? [];
  if (!ws || pending.length === 0) return;
  const boardKeys = boardItemKeys(await store.getBoard(projectId));
  const seen = new Set(ws.seenItemIds);
  for (const k of pending) if (boardKeys.has(k)) seen.add(k);
  await store.saveWorkspace({ ...ws, seenItemIds: [...seen], pendingSeenItemIds: [] });
}

/**
 * The bot's pending items were shown in a brief that a review or planning context has since replaced
 * (spec 5.2), so they are not confirmed: they show in full again. No workspace is created.
 */
export async function discardPendingSeen(store: Store, projectId: string, botId: string): Promise<void> {
  const ws = await store.getWorkspace(projectId, botId);
  if (!ws || (ws.pendingSeenItemIds ?? []).length === 0) return;
  await store.saveWorkspace({ ...ws, pendingSeenItemIds: [] });
}

// ---------------------------------------------------------------------------
// buildBrief
// ---------------------------------------------------------------------------

export async function buildBrief(deps: BriefDeps, botId: string, opts: BriefOptions): Promise<ContextBundle> {
  return (await buildBriefParts(deps, botId, opts)).bundle;
}

/** The delta items a brief shows, before rendering: kept entries and changes, and the omitted count its note shows (0 for none). */
export interface BriefDelta {
  entries: LedgerEntry[];
  changes: AppliedOp[];
  omitted: number;
}

/** The items of the memory, notes and projection segments a brief shows (as trimmed to its budget). */
export interface BriefItems {
  memory: ItemPart[];
  workspace: ItemPart[];
  projection: ItemPart[];
}

/** buildBrief, plus the structured delta and own items (the stream renders its appends from them). */
export async function buildBriefParts(
  deps: BriefDeps,
  botId: string,
  opts: BriefOptions,
): Promise<{ bundle: ContextBundle; delta: BriefDelta; items: BriefItems }> {
  const { store, projectId } = deps;
  const board = await store.getBoard(projectId);
  const workstreams = await resolveWorkstreams(board, deps.source);

  const botMembers = assertMember(board, workstreams, botId);

  const latestSeq = await store.latestSeq(projectId);
  const workspace: Workspace = (await store.getWorkspace(projectId, botId)) ?? defaultWorkspace(projectId, botId, latestSeq);

  const memories = new Map(
    await Promise.all(botMembers.map(async id => [id, await deps.employees.get(id)] as const)),
  );
  const memory: EmployeeMemory = memories.get(botId) ?? defaultMemory(botId);

  // Segments that are never trimmed.
  const common = renderTeam(board, botMembers, id => memories.get(id)?.persona);
  const boardText = renderBoardPublic(
    board,
    workstreams,
    await publicBoardView(store, projectId, deps.publicBoard, deps.options.directivesKeep),
  );
  // Two-phase seen (spec 5.2): items shown in full here only become seen once the bot calls a tool.
  // Within one brief a key shown in an earlier block is compacted in later blocks.
  const seen = new Set(workspace.seenItemIds);
  const shown: string[] = [];
  const blocks: string[] = [];
  const projectionParts: ItemPart[] = [];
  for (const p of selectProjections(board, workstreams, botId, writeScopeOverlaps(workstreams))) {
    const r = renderProjection(p, seen, deps.publicBoard);
    blocks.push(r.text);
    projectionParts.push(r.items);
    for (const k of r.shownKeys) seen.add(k);
    shown.push(...r.shownKeys);
  }
  const projection = blocks.join('\n\n');
  const trigger = opts.trigger ?? { reason: 'manual' as const, detail: '' };
  const triggerText = renderTrigger(trigger.reason, trigger.detail);

  // Delta, oldest first (stable: entries before changes at the same instant).
  const own = workstreams.filter(w => w.owner === botId);
  const entries = await relevantEntries(deps, botId, botId === board.lead, own, workspace.lastSeenSeq + 1, latestSeq);
  const changes = await relevantChanges(deps, board, own, workspace.lastSeenBoardVersion);
  const delta: DeltaItem[] = [...entries.map(entry => ({ at: entry.createdAt, entry })), ...changes].sort(
    (x, y) => x.at - y.at,
  );

  // Budget trimming (spec 5.2): walk the trim states in order (oldest delta items, then recent
  // notes, then recent memories) and stop at the first that fits. Totals are measured without the
  // "N older items omitted" note so no step can grow the total; the note is added at the end only
  // if the chosen state still fits with it.
  let dropped = 0;
  let { notesKeep, memKeep } = untrimmedKeeps(workspace, memory);
  const renderDeltaNow = (withNote: boolean) => {
    const kept = delta.slice(dropped);
    return renderDelta(
      kept.flatMap(d => ('entry' in d ? [d.entry] : [])),
      kept.flatMap(d => ('change' in d ? [d.change] : [])),
      withNote ? dropped : 0,
    );
  };

  const texts: Record<SegmentKind, string> = {
    common,
    board: boardText,
    memory: renderMemory(memory, memKeep),
    projection,
    workspace: renderWorkspace(workspace, notesKeep),
    delta: renderDeltaNow(false),
    trigger: triggerText,
  };
  const counts = {} as Record<SegmentKind, number>;
  const kinds = Object.keys(CACHEABLE) as SegmentKind[];
  for (const k of kinds) counts[k] = deps.count(texts[k]);
  const total = () => kinds.reduce((n, k) => n + counts[k], 0);
  const set = (k: SegmentKind, text: string) => {
    texts[k] = text;
    counts[k] = deps.count(text);
  };

  let smallest = total();
  while (total() > opts.maxTokens) {
    if (dropped < delta.length) {
      dropped++;
      set('delta', renderDeltaNow(false));
    } else if (notesKeep > 0) {
      set('workspace', renderWorkspace(workspace, --notesKeep));
    } else if (memKeep > 0) {
      set('memory', renderMemory(memory, --memKeep));
    } else {
      // Every state was visited, so `smallest` is the minimum total over all of them.
      throw new BudgetTooSmallError(smallest, opts.maxTokens);
    }
    smallest = Math.min(smallest, total());
  }
  let omitted = 0;
  if (dropped > 0) {
    const plain = texts.delta;
    set('delta', renderDeltaNow(true));
    if (total() > opts.maxTokens) set('delta', plain);
    else omitted = dropped;
  }

  if (!opts.peek) {
    const boardKeys = boardItemKeys(board);
    await store.saveWorkspace({
      ...workspace,
      // Keys of items no longer on the board can never be shown again; drop them so the list stays bounded.
      seenItemIds: workspace.seenItemIds.filter(k => boardKeys.has(k)),
      // Replaces any older pending set: a brief with no tool call after it confirms nothing.
      pendingSeenItemIds: shown,
      lastSeenSeq: latestSeq,
      lastSeenBoardVersion: board.version,
      promotionsThisTurn: 0,
    });
  }

  const segments: Segment[] = kinds.map(kind => ({ kind, text: texts[kind], cacheable: CACHEABLE[kind] }));
  const kept = delta.slice(dropped);
  return {
    bundle: {
      segments,
      tools: deps.tools(botId, board),
      stats: { bySegment: { ...counts }, total: total() },
    },
    delta: {
      entries: kept.flatMap(d => ('entry' in d ? [d.entry] : [])),
      changes: kept.flatMap(d => ('change' in d ? [d.change] : [])),
      omitted,
    },
    items: { memory: memoryItems(memory, memKeep), workspace: workspaceItems(workspace, notesKeep), projection: projectionParts },
  };
}
