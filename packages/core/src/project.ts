// The project facade (design spec 4, 5.1, 6.1, 7). Orchestration only: every rule lives in the
// modules imported below; this file sequences them, writes events and turns results into wakes.
import { createHash } from 'node:crypto';
import { structuralWakes, writeScopeOverlaps } from './board/diff.js';
import { Merger, type MergeResult } from './board/merge.js';
import { buildBrief as assembleBrief, type BriefDeps, type BriefOptions } from './brief.js';
import { systemClock, type Clock } from './clock.js';
import type { CondenseFn } from './condense.js';
import { findDeliverable, planningContext, retroContext, reviewContext, type ContextDeps, type PlanMeta } from './contexts.js';
import type { EmployeeRegistry } from './employees.js';
import { ContextError } from './errors.js';
import { createEventBus, type EventBus } from './events.js';
import { createExtractor } from './extract.js';
import { newId } from './ids.js';
import { assertMember, botMembers } from './members.js';
import { resolveOptions, type Options } from './options.js';
import { diffPlan, type ApprovedPlan, type PlanWorkstream } from './plan/replan.js';
import { validatePlan, type PlanInput } from './plan/validate.js';
import { addMemories, appendNote, type PrivateDeps } from './private.js';
import { renderBoardPublic } from './render.js';
import { retryingStore, withRetry } from './retry.js';
import { routeChat, toLedgerEntry, type RouteInput } from './route.js';
import type { Store } from './store/store.js';
import { defaultCountTokens } from './tokens.js';
import type {
  AppliedOp,
  BoardChange,
  BoardOp,
  ChatInput,
  ContextBundle,
  LedgerEntry,
  PendingProposal,
  PlanProposal,
  ProjectBoard,
  ProjectEvent,
  Wake,
  Workstream,
} from './types.js';
import { localWorkstreamSource, resolveWorkstreams, type WorkstreamSource } from './workstreams/source.js';

export { withRetry } from './retry.js';

export interface ProjectModels {
  route?: (input: RouteInput) => Promise<string[]>;
  extract?: (entries: LedgerEntry[], board: ProjectBoard) => Promise<BoardOp[]>;
  condense?: CondenseFn;
}

export interface ProjectConfig {
  projectId: string;
  store: Store;
  /** Should be built on the same store: retro memories are written through `store`. */
  employees: EmployeeRegistry;
  models?: ProjectModels;
  /** Host task board; when absent the core keeps workstream state in the project board. */
  workstreams?: WorkstreamSource;
  countTokens?: (s: string) => number;
  clock?: Clock;
  options?: Options;
}

export type Submission =
  | { type: 'deliverable'; workstreamId: string; summary: string; content: string }
  | { type: 'proposal'; ops: BoardOp[] }
  | { type: 'blocked'; workstreamId: string; reason: string }
  | { type: 'notes'; text: string; pinned?: boolean };

export interface Project {
  start(i: { goal: string; constraints: string[]; lead: string; by: string }): Promise<Wake[]>;
  buildPlanningContext(): Promise<ContextBundle>;
  proposePlan(plan: PlanInput, o: { by: string }): Promise<{ proposalId: string }>;
  approvePlan(id: string, o: { by: string; edits?: PlanInput }): Promise<Wake[]>;
  rejectPlan(id: string, o: { by: string; feedback: string }): Promise<Wake[]>;
  buildBrief(botId: string, o: BriefOptions): Promise<ContextBundle>;
  submit(botId: string, s: Submission): Promise<Wake[]>;
  buildReviewContext(deliverableId: string): Promise<ContextBundle>;
  submitReview(
    deliverableId: string,
    r: { by: string; passed: boolean; notes: string; conventions?: string[] },
  ): Promise<Wake[]>;
  resolveProposal(pendingId: string, r: { by: string; accept: boolean; edits?: BoardOp[] }): Promise<Wake[]>;
  close(o: { by: string; force?: boolean }): Promise<void>;
  buildRetroContext(botId: string): Promise<ContextBundle>;
  commitRetro(botId: string, memories: { text: string; pinned?: boolean }[]): Promise<void>;
  ingest(c: ChatInput): Promise<LedgerEntry>;
  route(e: LedgerEntry): Promise<Wake[]>;
  merge(): Promise<Wake[]>;
  /** The board with `workstreams` resolved through the WorkstreamSource. */
  board(): Promise<ProjectBoard>;
  on: EventBus['on'];
  /** Resolves when no chat extraction is running or being scheduled (for tests and hosts). */
  flushExtraction(): Promise<void>;
  /** Stops the lead-timeout and extraction timers and the host WorkstreamSource subscription. */
  dispose(): void;
}

type Author = LedgerEntry['author'];
const human = (id: string): Author => ({ kind: 'human', id });
const bot = (id: string): Author => ({ kind: 'bot', id });
const SYSTEM: Author = { kind: 'system', id: 'core' };
/** Meta key: workstream statuses the core has acted on, for an external WorkstreamSource (R24). */
const HOST_STATUS = 'hostStatus';
type ReviewStep = 'status' | 'rounds' | 'conventions' | 'event';
type ReviewMarker = { done: ReviewStep[] };
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

function forbidden(message: string): never {
  throw new ContextError('FORBIDDEN', message);
}

function planWorkstreams(plan: PlanInput): PlanWorkstream[] {
  return plan.workstreams.map(w => ({
    id: w.id,
    title: w.title,
    brief: w.brief,
    owner: w.owner,
    dependsOn: [...w.dependsOn],
    writeScopes: [...(w.writeScopes ?? [])],
  }));
}

/** Dedupe by (botId, reason) in first-seen order; distinct details are joined with '; '. */
function dedupeWakes(wakes: Wake[]): Wake[] {
  const acc = new Map<string, Wake>();
  for (const w of wakes) {
    const key = `${w.botId}\u0000${w.reason}`;
    const got = acc.get(key);
    if (!got) acc.set(key, { ...w });
    else if (w.detail && !(got.detail ?? '').split('; ').includes(w.detail)) {
      got.detail = got.detail ? `${got.detail}; ${w.detail}` : w.detail;
    }
  }
  return [...acc.values()];
}

export function createProject(cfg: ProjectConfig): Project {
  const { projectId, employees } = cfg;
  const store = retryingStore(cfg.store);
  const clock = cfg.clock ?? systemClock;
  const options = resolveOptions(cfg.options);
  const count = cfg.countTokens ?? defaultCountTokens;
  const external = cfg.workstreams !== undefined;
  const source = cfg.workstreams ?? localWorkstreamSource(store, clock);
  const bus = createEventBus();
  const leadTimers = new Map<string, unknown>();
  const overlapsSeen = new Set<string>();

  const getBoard = () => store.getBoard(projectId);
  const workstreamsOf = (b: ProjectBoard) => resolveWorkstreams(b, source);
  const ledger = () => store.read(projectId, 1);
  const log = (author: Author, event: ProjectEvent) =>
    store.append({ id: newId('e'), projectId, createdAt: clock.now(), author, body: { type: 'event', event } });
  /** The local source already retries through the store; only a host source gets the outer retry. */
  const hostWrite = (fn: () => Promise<void>) => (external ? withRetry(fn) : fn());

  const merger = new Merger({
    store,
    projectId,
    clock,
    options,
    count,
    renderPublic: b => renderBoardPublic(b, b.workstreams),
    ownWorkstreams: async botId => (await workstreamsOf(await getBoard())).filter(w => w.owner === botId).map(w => w.id),
  });
  const briefDeps: BriefDeps = { store, projectId, source, employees, count, options, tools: () => [] };
  const contextDeps: ContextDeps = { store, projectId, employees, count };
  const privateDeps: PrivateDeps = {
    store,
    projectId,
    employees,
    options,
    count,
    now: () => clock.now(),
    condense: cfg.models?.condense,
    aborted: e => bus.emit('condenseAborted', e),
  };

  // ---------------------------------------------------------------------------
  // per-project serial queue (spec 7) and host-source reconciliation (R24)
  // ---------------------------------------------------------------------------

  let chain: Promise<void> = Promise.resolve();

  /** Runs mutating operations one at a time; a failed one does not block the queue. */
  function serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = chain.then(fn);
    chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  type StatusMap = Record<string, Workstream['status']>;

  /** While a reconcile acts, the statuses it writes itself (merged into the map it records). */
  let ownWrites: StatusMap | null = null;

  /** Records statuses the core itself wrote to the host, so they are not mistaken for host changes. */
  async function noteStatuses(entries: StatusMap): Promise<void> {
    if (!external) return;
    if (ownWrites) Object.assign(ownWrites, entries);
    const map = (await store.getMeta<StatusMap>(projectId, HOST_STATUS)) ?? {};
    await store.setMeta(projectId, HOST_STATUS, { ...map, ...entries });
  }

  /**
   * Diffs the host's statuses against the persisted acted-on map, acts on any change (activating
   * newly ready work, R25) and records what it saw. The first run only seeds the map.
   */
  async function reconcile(): Promise<void> {
    const board = await getBoard().catch((e: unknown) => {
      if (e instanceof ContextError && e.code === 'NOT_FOUND') return null; // not started yet
      throw e;
    });
    if (!board) return;
    const listed = await source.list(projectId);
    const known = await store.getMeta<StatusMap>(projectId, HOST_STATUS);
    const seen: StatusMap = Object.fromEntries(listed.map(w => [w.id, w.status]));
    const changed = known !== null && listed.some(w => known[w.id] !== undefined && known[w.id] !== w.status);
    const own: StatusMap = {};
    if (changed && board.status !== 'closed') {
      ownWrites = own;
      try {
        finish(await activateReady());
      } finally {
        ownWrites = null;
      }
    }
    // Recorded only after acting: if acting fails, the next reconcile sees the same change again.
    await store.setMeta(projectId, HOST_STATUS, { ...seen, ...own });
  }

  const unsubscribe = external
    ? source.onChange(projectId, () => {
        serial(reconcile).catch(() => undefined); // failures already escalate through setStatus
      })
    : () => undefined;
  if (external) serial(reconcile).catch(() => undefined); // init: the first queued operation

  // ---------------------------------------------------------------------------
  // helpers
  // ---------------------------------------------------------------------------

  function finish(wakes: Wake[]): Wake[] {
    const out = dedupeWakes(wakes);
    if (out.length > 0) bus.emit('wake', { wakes: out });
    return out;
  }

  async function openBoard(): Promise<ProjectBoard> {
    const board = await getBoard();
    if (board.status === 'closed') throw new ContextError('PROJECT_CLOSED', `Project ${projectId} is closed`);
    return board;
  }

  async function memberView(botId: string, open: boolean): Promise<{ board: ProjectBoard; ws: Workstream[] }> {
    const board = open ? await openBoard() : await getBoard();
    const ws = await workstreamsOf(board);
    assertMember(board, ws, botId);
    return { board, ws };
  }

  function ownedWorkstream(ws: Workstream[], botId: string, id: string): Workstream {
    const w = ws.find(x => x.id === id);
    if (!w) throw new ContextError('NOT_FOUND', `Workstream "${id}" not found`);
    if (w.owner !== botId) forbidden(`Workstream "${id}" is owned by ${w.owner}, not ${botId}`);
    return w;
  }

  /** Read-modify-write of fields the merger does not own, as one BoardChange; re-reads on STALE_VERSION. */
  async function patchBoard(mutate: (b: ProjectBoard) => AppliedOp[] | void) {
    for (let attempt = 1; ; attempt++) {
      const b = await getBoard();
      const ops = mutate(b) ?? [];
      const change: BoardChange = { version: b.version + 1, mergedAt: clock.now(), ops };
      const next = { ...b, version: change.version, updatedAt: change.mergedAt };
      try {
        await store.saveBoard(next, b.version, change);
      } catch (e) {
        if (e instanceof ContextError && e.code === 'STALE_VERSION' && attempt < 3) continue;
        throw e;
      }
      bus.emit('boardChanged', { version: change.version });
      return { board: next, change };
    }
  }

  /** Status write-back with retries; after the last failure a human is asked (spec 7). */
  async function setStatus(id: string, status: Workstream['status']): Promise<void> {
    try {
      await hostWrite(() => source.setStatus(projectId, id, status));
    } catch (e) {
      bus.emit('needsHuman', { reason: `Writing status "${status}" of workstream ${id} failed: ${errText(e)}`, ref: id });
      throw e;
    }
    if (!external) {
      bus.emit('boardChanged', { version: (await getBoard()).version });
      return;
    }
    try {
      await noteStatuses({ [id]: status });
    } catch (e) {
      // The host has the status, so the step counts as done. A stale map entry only makes a
      // later reconcile re-check readiness, which is derived from state and finds nothing to do.
      bus.emit('needsHuman', { reason: `Status "${status}" of workstream ${id} was written but not recorded: ${errText(e)}`, ref: id });
    }
  }

  function checkOverlaps(ws: Workstream[]): void {
    for (const o of writeScopeOverlaps(ws)) {
      const key = `${o.a}\u0000${o.b}\u0000${o.prefix}`;
      if (overlapsSeen.has(key)) continue;
      overlapsSeen.add(key);
      bus.emit('writeScopeOverlap', o);
    }
  }

  /**
   * R25: derived from state, not from a before/after diff, so a retry after a partial failure
   * still finishes the job. Every pending workstream of the approved plan whose dependencies are
   * all delivered becomes active, and its owner is woken with upstreamDelivered.
   */
  async function activateReady(): Promise<Wake[]> {
    const ws = await workstreamsOf(await getBoard());
    const approvedId = await store.getMeta<string>(projectId, 'approvedPlan');
    const approved = approvedId ? await store.getPlanProposal(approvedId) : null;
    const planned = new Set(approved?.workstreams.map(w => w.id) ?? []);
    const delivered = new Set(ws.filter(w => w.status === 'delivered').map(w => w.id));
    const ready = ws.filter(
      w => w.status === 'pending' && planned.has(w.id) && w.dependsOn.length > 0 && w.dependsOn.every(d => delivered.has(d)),
    );
    const wakes: Wake[] = [];
    for (const w of ready) {
      try {
        await setStatus(w.id, 'active');
      } catch (e) {
        // Dependents activated so far are no longer pending, so a retry would never wake them.
        finish(wakes);
        throw e;
      }
      wakes.push({ botId: w.owner, reason: 'upstreamDelivered', detail: `dependencies of ${w.id} delivered` });
    }
    checkOverlaps(ready.length > 0 ? await workstreamsOf(await getBoard()) : ws);
    return wakes;
  }

  function armLeadTimers(pending: PendingProposal[], lead: string): void {
    for (const p of pending) {
      if (p.needs !== 'lead' || leadTimers.has(p.id)) continue;
      const handle = clock.setTimeout(() => {
        leadTimers.delete(p.id);
        bus.emit('needsHuman', {
          reason: `The lead (${lead}) did not resolve pending proposal ${p.id} within ${options.leadTimeoutMs} ms`,
          ref: p.id,
        });
      }, options.leadTimeoutMs);
      leadTimers.set(p.id, handle);
    }
  }

  function clearLeadTimer(id: string): void {
    if (!leadTimers.has(id)) return;
    clock.clearTimeout(leadTimers.get(id));
    leadTimers.delete(id);
  }

  /** Events, status write-back, structural wakes and pending routing after a merge or resolve. */
  async function afterMerge(before: Workstream[], r: MergeResult, lead: string): Promise<Wake[]> {
    const wakes: Wake[] = [];
    if (r.change) {
      bus.emit('merged', { change: r.change });
      bus.emit('boardChanged', { version: r.change.version });
      if (external) {
        for (const a of r.change.ops) if (a.op.op === 'setWorkstreamStatus') await setStatus(a.op.id, a.op.status);
      }
      const board = await getBoard();
      const after = await workstreamsOf(board);
      wakes.push(...structuralWakes(r.change, before, after, board), ...(await activateReady()));
    }
    for (const p of r.pending) {
      if (p.needs === 'lead') {
        wakes.push({ botId: lead, reason: 'needsLead', detail: `pending proposal ${p.id} from ${p.by} needs your decision` });
      } else {
        bus.emit('needsHuman', { reason: `Pending proposal ${p.id} from ${p.by} needs the owner's confirmation`, ref: p.id });
      }
    }
    armLeadTimers(r.pending, lead);
    return wakes;
  }

  async function runMerge(): Promise<Wake[]> {
    const board = await getBoard();
    const before = await workstreamsOf(board);
    return afterMerge(before, await merger.merge(), board.lead);
  }

  async function pendingPlan(id: string): Promise<PlanProposal> {
    const p = await store.getPlanProposal(id);
    if (!p || p.projectId !== projectId) throw new ContextError('NOT_FOUND', `Plan proposal "${id}" not found`);
    if (p.status !== 'pending') throw new ContextError('INVALID_OP', `Plan proposal "${id}" is already ${p.status}`);
    return p;
  }

  async function checkPlan(plan: PlanInput): Promise<void> {
    const roster = new Set((await employees.roster()).map(r => r.botId));
    const v = validatePlan(plan, roster);
    if (!v.ok) throw new ContextError('INVALID_PLAN', `Invalid plan: ${v.reasons.join('; ')}`, { reasons: v.reasons });
  }

  // ---------------------------------------------------------------------------
  // lifecycle steps
  // ---------------------------------------------------------------------------

  /**
   * Safe to call again after a partial failure: the proposal stays pending until the end, only
   * missing workstreams are created, and `assigned` covers workstreams activated by an earlier attempt.
   */
  async function approve(id: string, o: { by: string; edits?: PlanInput }): Promise<Wake[]> {
    const board = await openBoard();
    if (o.by !== board.owner) forbidden(`Only the owner (${board.owner}) can approve a plan`);
    const proposal = await pendingPlan(id);
    if (o.edits) await checkPlan(o.edits);
    const plan: ApprovedPlan = o.edits
      ? { workstreams: planWorkstreams(o.edits), contracts: o.edits.contracts.map(c => ({ ...c })) }
      : { workstreams: proposal.workstreams, contracts: proposal.contracts };

    const before = await workstreamsOf(board);
    const diff = diffPlan(plan, before, board.contracts);
    if (external && diff.hostFieldChanges.length > 0) {
      // R22: the host owns these fields; the core cannot apply them through WorkstreamSource.
      throw new ContextError('INVALID_PLAN', `Invalid plan: ${diff.hostFieldChanges.join('; ')}`, {
        reasons: diff.hostFieldChanges,
      });
    }
    if (diff.created.length > 0) {
      await hostWrite(() => source.create(projectId, diff.created));
      await noteStatuses(Object.fromEntries(diff.created.map(w => [w.id, 'pending' as const])));
    }

    const { change } = await patchBoard(b => {
      for (const w of plan.workstreams) {
        const row = b.workstreams.find(x => x.id === w.id);
        // External source (R14): the core still stores brief, review rounds and deliverables.
        if (!row) b.workstreams.push({ ...structuredClone(w), status: 'pending', reviewRounds: 0, deliverables: [] });
        else if (external) row.brief = w.brief;
        else Object.assign(row, structuredClone(w)); // the local source's own fields live here too
      }
      b.contracts = structuredClone(diff.contracts);
      b.planStatus = 'approved';
      return diff.updated.map(c => ({ op: { op: 'updateContract', id: c.id, spec: c.spec }, by: o.by, authority: 'human', touched: [c.id] }));
    });
    for (const c of diff.dropped) await log(SYSTEM, { kind: 'archived', what: 'contracts', ref: JSON.stringify(c) });

    const prevMeta = await store.getMeta<string>(projectId, 'approvedPlan');
    const prevPlan = prevMeta ? await store.getPlanProposal(prevMeta) : null;
    const known = new Set(prevPlan?.workstreams.map(w => w.id) ?? []);
    const mid = await workstreamsOf(await getBoard());
    const delivered = new Set(mid.filter(w => w.status === 'delivered').map(w => w.id));
    const inPlan = new Set(plan.workstreams.map(w => w.id));
    const ready = mid.filter(
      w =>
        inPlan.has(w.id) &&
        w.dependsOn.every(d => delivered.has(d)) &&
        (w.status === 'pending' || (w.status === 'active' && !known.has(w.id))),
    );
    for (const w of ready) if (w.status === 'pending') await setStatus(w.id, 'active');
    // The proposal records what was approved (edits included).
    await store.savePlanProposal({ ...proposal, ...plan, status: 'approved' });
    await store.setMeta(projectId, 'approvedPlan', id);
    await log(human(o.by), { kind: 'planApproved', proposalId: id });

    const after = await getBoard();
    const afterWs = await workstreamsOf(after);
    checkOverlaps(afterWs);
    const ownerOf = (wsId: string) => afterWs.find(x => x.id === wsId)?.owner;
    const wakes: Wake[] = ready.map(w => ({ botId: w.owner, reason: 'assigned', detail: `workstream ${w.id} can start` }));
    wakes.push(...structuralWakes(change, before, afterWs, after));
    for (const { id: wsId, fields } of diff.reshaped) {
      const owner = ownerOf(wsId);
      if (owner) wakes.push({ botId: owner, reason: 'contractChanged', detail: `${fields.join(' and ')} of ${wsId} changed` });
    }
    for (const { id: wsId, owner } of diff.reassigned) {
      if (afterWs.find(x => x.id === wsId)?.status === 'active') {
        wakes.push({ botId: owner, reason: 'assigned', detail: `workstream ${wsId} was reassigned to you` });
      }
    }
    const existed = new Set(before.map(w => w.id));
    for (const [what, list] of [['added', diff.added], ['dropped', diff.dropped]] as const) {
      for (const c of list) {
        for (const end of [c.from, c.to]) {
          const owner = existed.has(end) ? ownerOf(end) : undefined;
          if (owner) wakes.push({ botId: owner, reason: 'contractChanged', detail: `contract ${c.id} ${what} for ${end}` });
        }
      }
    }
    return wakes;
  }

  async function submitDeliverable(
    board: ProjectBoard,
    ws: Workstream[],
    botId: string,
    s: Extract<Submission, { type: 'deliverable' }>,
  ): Promise<Wake[]> {
    const w = ownedWorkstream(ws, botId, s.workstreamId);
    const ref = await store.putDeliverable(projectId, s.content);
    const op: BoardOp = { op: 'addDeliverable', workstreamId: w.id, summary: s.summary, ref };
    await store.enqueueProposal({ id: newId('prop'), projectId, baseVersion: board.version, by: botId, ops: [op] });
    const wakes = await runMerge();
    const d = (await getBoard()).workstreams.find(x => x.id === w.id)?.deliverables.find(x => x.ref === ref);
    if (!d) throw new ContextError('INVALID_OP', `The deliverable for workstream ${w.id} could not be recorded`);
    await log(bot(botId), { kind: 'deliverableSubmitted', workstreamId: w.id, deliverableId: d.id });
    wakes.push({ botId: board.lead, reason: 'needsLead', detail: `deliverable ${d.id} of ${w.id} awaits review` });
    return wakes;
  }

  async function submit(botId: string, s: Submission): Promise<Wake[]> {
    const { board, ws } = await memberView(botId, true);
    switch (s.type) {
      case 'deliverable':
        return submitDeliverable(board, ws, botId, s);
      case 'proposal': {
        // R20: delivery happens only through submitReview.
        const delivers = Array.isArray(s.ops) && s.ops.some(op => op?.op === 'setWorkstreamStatus' && op.status === 'delivered');
        if (delivers && botId !== board.lead) forbidden('Only the lead marks a workstream delivered, through submitReview');
        // Conflicts are judged against what the bot last saw (spec 3).
        const seen = (await store.getWorkspace(projectId, botId))?.lastSeenBoardVersion ?? 0;
        const baseVersion = seen > 0 ? seen : board.version;
        await store.enqueueProposal({ id: newId('prop'), projectId, baseVersion, by: botId, ops: s.ops });
        return runMerge();
      }
      case 'blocked': {
        const w = ownedWorkstream(ws, botId, s.workstreamId);
        await setStatus(w.id, 'blocked');
        await log(bot(botId), { kind: 'blocked', workstreamId: w.id, reason: s.reason });
        return [{ botId: board.lead, reason: 'needsLead', detail: `workstream ${w.id} is blocked: ${s.reason}` }];
      }
      case 'notes':
        await appendNote(privateDeps, botId, s.text, s.pinned ?? false);
        return [];
    }
  }

  /**
   * R26/R27: idempotent per (deliverable, outcome, conventions). Each side effect records a marker
   * in meta `review:<deliverableId>:<outcome>:<conventions hash>` and is skipped when a retry finds it
   * done; activation is derived from state (R25), so it completes on a retry too.
   */
  async function review(
    deliverableId: string,
    r: { by: string; passed: boolean; notes: string; conventions?: string[] },
  ): Promise<Wake[]> {
    const board = await openBoard();
    if (r.by !== board.lead) forbidden(`Only the lead (${board.lead}) can review deliverables`);
    const { w } = findDeliverable(await workstreamsOf(board), deliverableId);
    // Idempotency rule: calls with the same deliverable, outcome and set of conventions are one
    // review. A retry completes the steps not yet marked done, and repeating a completed review
    // changes nothing. Any difference (another outcome, other conventions) is a new review round.
    const conventionsHash = createHash('sha256')
      .update(JSON.stringify([...new Set(r.conventions ?? [])].sort()))
      .digest('hex')
      .slice(0, 16);
    const key = `review:${deliverableId}:${r.passed ? 'passed' : 'failed'}:${conventionsHash}`;
    const marker: ReviewMarker = (await store.getMeta<ReviewMarker>(projectId, key)) ?? { done: [] };
    const step = async (name: ReviewStep, fn: () => Promise<void>) => {
      if (marker.done.includes(name)) return;
      await fn();
      marker.done.push(name);
      await store.setMeta(projectId, key, marker);
    };

    const wakes: Wake[] = [];
    if (r.passed) {
      await step('status', () => setStatus(w.id, 'delivered'));
      wakes.push(...(await activateReady()));
    } else {
      await step('rounds', async () => {
        const { board: next } = await patchBoard(b => {
          const row = b.workstreams.find(x => x.id === w.id);
          if (row) row.reviewRounds += 1;
        });
        const rounds = next.workstreams.find(x => x.id === w.id)?.reviewRounds ?? 0;
        if (rounds > options.maxReviewRounds) {
          bus.emit('needsHuman', { reason: `Workstream ${w.id} failed review ${rounds} times`, ref: w.id });
        }
      });
      wakes.push({ botId: w.owner, reason: 'reviewFailed', detail: `deliverable ${deliverableId} failed review: ${r.notes}` });
    }
    if (r.conventions && r.conventions.length > 0) {
      const ops: BoardOp[] = r.conventions.map(text => ({
        op: 'add',
        section: 'conventions',
        item: { text, source: { entryIds: [], by: board.lead } },
      }));
      // Marked once queued: the merger either commits a queued proposal or puts it back, never twice.
      await step('conventions', () =>
        store.enqueueProposal({ id: newId('prop'), projectId, baseVersion: board.version, by: board.lead, ops }),
      );
      wakes.push(...(await runMerge()));
    }
    await step('event', async () => {
      await log(bot(r.by), { kind: r.passed ? 'reviewPassed' : 'reviewFailed', deliverableId, notes: r.notes });
    });
    return wakes;
  }

  const resolvedBoard = async (): Promise<ProjectBoard> => {
    const b = await getBoard();
    return { ...b, workstreams: await workstreamsOf(b) };
  };

  // Human-chat extraction (spec 5.3): the model call runs outside the queue, only the proposal is queued.
  const extractor = createExtractor({
    store,
    projectId,
    clock,
    options,
    extract: cfg.models?.extract,
    board: resolvedBoard,
    emit: bus.emit,
    enqueue: (ops, baseVersion) =>
      serial(async () => {
        await openBoard();
        await store.enqueueProposal({ id: newId('prop'), projectId, baseVersion, by: 'extractor', ops });
        finish(await runMerge());
      }),
  });
  extractor.restore().catch(() => undefined);

  const dispose = () => {
    extractor.dispose();
    for (const id of [...leadTimers.keys()]) clearLeadTimer(id);
    unsubscribe();
  };

  // ---------------------------------------------------------------------------
  // the facade: every mutating method runs in the serial queue
  // ---------------------------------------------------------------------------

  return {
    start: i =>
      serial(async () => {
        await store.createBoard({
          projectId,
          version: 0,
          updatedAt: clock.now(),
          status: 'active',
          owner: i.by,
          lead: i.lead,
          goal: i.goal,
          constraints: [...i.constraints],
          planStatus: 'none',
          conventions: [],
          workstreams: [],
          contracts: [],
          decisions: [],
          facts: [],
          failures: [],
          openQuestions: [],
        });
        await log(human(i.by), { kind: 'projectStarted' });
        return finish([{ botId: i.lead, reason: 'needsLead', detail: 'project started: propose a plan' }]);
      }),

    async buildPlanningContext() {
      const board = await getBoard();
      return planningContext(contextDeps, board, await workstreamsOf(board));
    },

    proposePlan: (plan, o) =>
      serial(async () => {
        const board = await openBoard();
        if (o.by !== board.lead) forbidden(`Only the lead (${board.lead}) can propose a plan`);
        await checkPlan(plan);
        const meta = await store.getMeta<PlanMeta>(projectId, 'plan');
        const prev = meta ? await store.getPlanProposal(meta.proposalId) : null;
        // R21: a new proposal supersedes an earlier one still waiting for the owner.
        if (prev?.status === 'pending') await store.savePlanProposal({ ...prev, status: 'rejected' });
        const proposal: PlanProposal = {
          id: newId('plan'),
          projectId,
          by: o.by,
          workstreams: planWorkstreams(plan),
          contracts: plan.contracts.map(c => ({ ...c })),
          status: 'pending',
          // consecutive rejections carry over until a plan is approved (spec 7)
          rejectCount: prev && prev.status !== 'approved' ? prev.rejectCount : 0,
        };
        await store.savePlanProposal(proposal);
        await store.setMeta(projectId, 'plan', { proposalId: proposal.id } satisfies PlanMeta);
        if (board.planStatus === 'none') await patchBoard(b => void (b.planStatus = 'draft'));
        await log(bot(o.by), { kind: 'planProposed', proposalId: proposal.id });
        bus.emit('needsHuman', { reason: `Plan ${proposal.id} awaits approval by the owner (${board.owner})`, ref: proposal.id });
        return { proposalId: proposal.id };
      }),

    approvePlan: (id, o) => serial(async () => finish(await approve(id, o))),

    rejectPlan: (id, o) =>
      serial(async () => {
        const board = await openBoard();
        if (o.by !== board.owner) forbidden(`Only the owner (${board.owner}) can reject a plan`);
        const proposal = await pendingPlan(id);
        const rejected: PlanProposal = { ...proposal, status: 'rejected', rejectCount: proposal.rejectCount + 1 };
        await store.savePlanProposal(rejected);
        await store.setMeta(projectId, 'plan', { proposalId: id, feedback: o.feedback } satisfies PlanMeta);
        await log(human(o.by), { kind: 'planRejected', proposalId: id, feedback: o.feedback });
        if (rejected.rejectCount >= options.maxPlanRejects) {
          bus.emit('needsHuman', { reason: `The plan was rejected ${rejected.rejectCount} times; split the work by hand`, ref: id });
        }
        return finish([{ botId: board.lead, reason: 'needsLead', detail: `plan ${id} was rejected: ${o.feedback}` }]);
      }),

    // A non-peek brief saves the workspace (seen items, pointers), so it is queued like other writes.
    buildBrief: (botId, o) => (o.peek ? assembleBrief(briefDeps, botId, o) : serial(() => assembleBrief(briefDeps, botId, o))),

    submit: (botId, s) => serial(async () => finish(await submit(botId, s))),

    async buildReviewContext(deliverableId) {
      const board = await getBoard();
      return reviewContext(contextDeps, board, await workstreamsOf(board), deliverableId);
    },

    submitReview: (deliverableId, r) => serial(async () => finish(await review(deliverableId, r))),

    resolveProposal: (pendingId, r) =>
      serial(async () => {
        const board = await openBoard();
        const before = await workstreamsOf(board);
        const result = await merger.resolve(pendingId, r);
        // A pending item whose ops were all rejected stays queued, and so does its timer.
        if (!(await store.listPending(projectId)).some(p => p.id === pendingId)) clearLeadTimer(pendingId);
        return finish(await afterMerge(before, result, board.lead));
      }),

    close: o =>
      serial(async () => {
        const board = await openBoard();
        if (o.by !== board.owner) forbidden(`Only the owner (${board.owner}) can close the project`);
        const pending = (await workstreamsOf(board)).filter(w => w.status !== 'delivered');
        if (pending.length > 0 && !o.force) {
          const ids = pending.map(w => w.id);
          throw new ContextError('PROJECT_NOT_COMPLETE', `Workstreams not delivered: ${ids.join(', ')}`, { pending: ids });
        }
        // Forced close: unfinished workstreams are recorded in the ledger before the project closes.
        for (const w of pending) await log(SYSTEM, { kind: 'archived', what: 'workstreams', ref: JSON.stringify(w) });
        await patchBoard(b => void (b.status = 'closed'));
        await log(human(o.by), { kind: 'projectClosed', forced: pending.length > 0 });
        dispose();
      }),

    async buildRetroContext(botId) {
      const board = await getBoard();
      return retroContext(contextDeps, board, await workstreamsOf(board), botId);
    },

    commitRetro: (botId, memories) =>
      serial(async () => {
        await memberView(botId, false);
        await addMemories(privateDeps, botId, memories);
      }),

    ingest: c =>
      serial(async () => {
        await openBoard();
        const parent = c.replyTo ? ((await ledger()).find(e => e.id === c.replyTo) ?? null) : null;
        const entry = await store.append({ ...toLedgerEntry(c, parent), id: newId('e'), projectId, createdAt: clock.now() });
        if (entry.author.kind === 'human' && entry.body.type === 'chat') extractor.onHumanMessage(entry).catch(() => undefined);
        return entry;
      }),

    route: entry =>
      serial(async () => {
        const board = await openBoard();
        const ws = await workstreamsOf(board);
        const all = await ledger();
        const chats = all.filter(e => e.body.type === 'chat' && e.seq < entry.seq);
        // R16: bot turns = bot chat entries after the last human chat entry and before this one.
        const afterSeq = chats.findLast(e => e.author.kind === 'human')?.seq ?? 0;
        const botTurnsSinceHuman = chats.filter(e => e.seq > afterSeq && e.author.kind === 'bot').length;
        const replyTo = entry.body.type === 'chat' ? entry.body.replyTo : undefined;
        const members = botMembers(board, ws);
        const r = await routeChat(entry, {
          lead: board.lead,
          members: new Set(members),
          workstreams: ws,
          botTurnsSinceHuman,
          parent: replyTo === undefined ? null : (all.find(e => e.id === replyTo) ?? null),
          options,
          route: cfg.models?.route,
          routeInput: async () => ({
            boardPublic: renderBoardPublic(board, ws),
            recent: chats.slice(-options.recentForRouter),
            candidates: members.map(botId => ({ botId, workstreams: ws.filter(w => w.owner === botId).map(w => w.id) })),
            message: entry,
          }),
        });
        // Once per human message, persisted so a restart does not repeat it.
        if (r.limitReached && (await store.getMeta<number>(projectId, 'wakeLimitReached')) !== afterSeq) {
          await store.setMeta(projectId, 'wakeLimitReached', afterSeq);
          bus.emit('wakeLimitReached', { afterSeq });
        }
        return finish(r.wakes);
      }),

    merge: () =>
      serial(async () => {
        await openBoard();
        return finish(await runMerge());
      }),

    board: resolvedBoard,

    on: (k, h) => bus.on(k, h),
    flushExtraction: () => extractor.flush(),
    dispose,
  };
}
