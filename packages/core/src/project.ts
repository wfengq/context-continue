// The project facade (design spec 4, 5.1, 6.1, 7). Orchestration only: every rule lives in the
// modules imported below; this file sequences them, writes events and turns results into wakes.
import { newlyReady, structuralWakes, writeScopeOverlaps } from './board/diff.js';
import { Merger, type MergeResult } from './board/merge.js';
import { buildBrief as assembleBrief, type BriefDeps, type BriefOptions } from './brief.js';
import { systemClock, type Clock } from './clock.js';
import { condenseSegments, type CondenseFn } from './condense.js';
import type { EmployeeRegistry } from './employees.js';
import { ContextError } from './errors.js';
import { createEventBus, type EventBus } from './events.js';
import { newId } from './ids.js';
import { resolveOptions, type Options } from './options.js';
import { validatePlan, type PlanInput } from './plan/validate.js';
import { renderBoardPublic, renderCommon, renderPlanning, renderRetro, renderReview, splitParagraphs } from './render.js';
import { routeChat, toLedgerEntry, type RouteInput } from './route.js';
import type { Store } from './store/store.js';
import { defaultCountTokens } from './tokens.js';
import type {
  AppliedOp,
  BoardChange,
  BoardOp,
  ChatInput,
  ContextBundle,
  Contract,
  EmployeeMemory,
  LedgerEntry,
  PendingProposal,
  PlanProposal,
  ProjectBoard,
  ProjectEvent,
  Segment,
  SegmentKind,
  Wake,
  Workspace,
  Workstream,
} from './types.js';
import { localWorkstreamSource, resolveWorkstreams, type WorkstreamSource } from './workstreams/source.js';

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
  /** Stops the lead-timeout timers. */
  dispose(): void;
}

/**
 * Runs `fn` up to `times` times and rethrows the last error (spec 7: "other writes are retried up
 * to 3 times"). ContextErrors are deterministic outcomes (version conflicts, unknown ids) and are
 * rethrown at once.
 */
export async function withRetry<T>(fn: () => Promise<T>, times = 3): Promise<T> {
  let last: unknown;
  for (let i = 0; i < times; i++) {
    try {
      return await fn();
    } catch (e) {
      if (e instanceof ContextError) throw e;
      last = e;
    }
  }
  throw last;
}

/** Store writes that go through `withRetry`; `append` is deliberately absent (spec 7). */
const RETRIED_WRITES = new Set<string | symbol>([
  'createBoard',
  'saveBoard',
  'enqueueProposal',
  'savePlanProposal',
  'savePending',
  'deletePending',
  'saveWorkspace',
  'saveMemory',
  'putDeliverable',
  'setMeta',
]);

function retryingStore(store: Store): Store {
  return new Proxy(store, {
    get(target, key, receiver) {
      const v: unknown = Reflect.get(target, key, receiver);
      if (typeof v !== 'function') return v;
      const fn = (...args: unknown[]) => (v as (...a: unknown[]) => Promise<unknown>).apply(target, args);
      return RETRIED_WRITES.has(key) ? (...args: unknown[]) => withRetry(() => fn(...args)) : fn;
    },
  });
}

type Author = LedgerEntry['author'];
const human = (id: string): Author => ({ kind: 'human', id });
const bot = (id: string): Author => ({ kind: 'bot', id });
const SYSTEM: Author = { kind: 'system', id: 'core' };
const firstLine = (s: string) => (s.split(/\r?\n/)[0] ?? '').trim();
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));
const sameList = (a: string[], b: string[]) => a.length === b.length && a.every((x, i) => x === b[i]);
type PlanWorkstream = PlanProposal['workstreams'][number];
type PlanMeta = { proposalId: string; feedback?: string };

function forbidden(message: string): never {
  throw new ContextError('FORBIDDEN', message);
}

function planWorkstreams(plan: PlanInput): PlanWorkstream[] {
  return plan.workstreams.map((w) => ({
    id: w.id,
    title: w.title,
    brief: w.brief,
    owner: w.owner,
    dependsOn: [...w.dependsOn],
    writeScopes: [...(w.writeScopes ?? [])],
  }));
}

/** Bot members: the lead, then workstream owners in workstream order (same rule as buildBrief). */
function botMembers(board: ProjectBoard, ws: Workstream[]): string[] {
  const out: string[] = [];
  for (const id of [board.lead, ...ws.map((w) => w.owner)]) if (id && !out.includes(id)) out.push(id);
  return out;
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

  const merger = new Merger({
    store,
    projectId,
    clock,
    options,
    count,
    renderPublic: (b) => renderBoardPublic(b, b.workstreams),
    ownWorkstreams: async (botId) =>
      (await workstreamsOf(await getBoard())).filter((w) => w.owner === botId).map((w) => w.id),
  });
  const briefDeps: BriefDeps = { store, projectId, source, employees, count, options, tools: () => [] };

  // ---------------------------------------------------------------------------
  // helpers
  // ---------------------------------------------------------------------------

  /** Dedupe by (botId, reason) keeping first-seen order, and announce the wakes. */
  function finish(wakes: Wake[]): Wake[] {
    const seen = new Set<string>();
    const out = wakes.filter((w) => {
      const key = `${w.botId}\u0000${w.reason}`;
      return !seen.has(key) && !!seen.add(key);
    });
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
    if (!botMembers(board, ws).includes(botId)) {
      throw new ContextError('NOT_A_MEMBER', `Bot "${botId}" is not a member of project ${projectId}`, { botId, projectId });
    }
    return { board, ws };
  }

  function ownedWorkstream(ws: Workstream[], botId: string, id: string): Workstream {
    const w = ws.find((x) => x.id === id);
    if (!w) throw new ContextError('NOT_FOUND', `Workstream "${id}" not found`);
    if (w.owner !== botId) forbidden(`Workstream "${id}" is owned by ${w.owner}, not ${botId}`);
    return w;
  }

  function byDeliverable(ws: Workstream[], deliverableId: string) {
    for (const w of ws) {
      const d = w.deliverables.find((x) => x.id === deliverableId);
      if (d) return { w, d };
    }
    throw new ContextError('NOT_FOUND', `Deliverable "${deliverableId}" not found`);
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
      await withRetry(() => source.setStatus(projectId, id, status));
    } catch (e) {
      bus.emit('needsHuman', { reason: `Writing status "${status}" of workstream ${id} failed: ${errText(e)}`, ref: id });
      throw e;
    }
    if (!external) bus.emit('boardChanged', { version: (await getBoard()).version });
  }

  function checkOverlaps(ws: Workstream[]): void {
    for (const o of writeScopeOverlaps(ws)) {
      const key = `${o.a}\u0000${o.b}\u0000${o.prefix}`;
      if (overlapsSeen.has(key)) continue;
      overlapsSeen.add(key);
      bus.emit('writeScopeOverlap', o);
    }
  }

  /** Activates workstreams whose dependencies were all just delivered. */
  async function activateReady(before: Workstream[], after: Workstream[]): Promise<void> {
    const ready = newlyReady(before, after);
    for (const id of ready) await setStatus(id, 'active');
    checkOverlaps(ready.length > 0 ? await workstreamsOf(await getBoard()) : after);
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
      wakes.push(...structuralWakes(r.change, before, after, board));
      await activateReady(before, after);
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

  /** Common and board segments (cacheable, identical to buildBrief's), then the body. */
  async function bundle(board: ProjectBoard, ws: Workstream[], body: string): Promise<ContextBundle> {
    const members = botMembers(board, ws);
    const roles = await Promise.all(members.map(async (id) => firstLine((await employees.get(id))?.persona ?? '')));
    const common = renderCommon([
      { id: board.owner, kind: 'human', role: 'owner' },
      ...members.map((id, i) => ({ id, kind: 'bot' as const, role: roles[i]! })),
    ]);
    const segments: Segment[] = [
      { kind: 'common', text: common, cacheable: true },
      { kind: 'board', text: renderBoardPublic(board, ws), cacheable: true },
      { kind: 'projection', text: body, cacheable: false },
    ];
    const bySegment: Partial<Record<SegmentKind, number>> = {};
    for (const s of segments) bySegment[s.kind] = count(s.text);
    return { segments, tools: [], stats: { bySegment, total: segments.reduce((n, s) => n + bySegment[s.kind]!, 0) } };
  }

  async function workspaceOf(botId: string): Promise<Workspace> {
    return (
      (await store.getWorkspace(projectId, botId)) ?? {
        projectId,
        botId,
        notes: '',
        pinnedNotes: [],
        condensed: '',
        seenItemIds: [],
        lastSeenSeq: await store.latestSeq(projectId),
        lastSeenBoardVersion: 0,
        promotionsThisTurn: 0,
      }
    );
  }

  async function memoryOf(botId: string): Promise<EmployeeMemory> {
    return (await employees.get(botId)) ?? { botId, persona: '', skills: [], memories: [], condensed: '' };
  }

  async function pendingPlan(id: string): Promise<PlanProposal> {
    const p = await store.getPlanProposal(id);
    if (!p || p.projectId !== projectId) throw new ContextError('NOT_FOUND', `Plan proposal "${id}" not found`);
    if (p.status !== 'pending') throw new ContextError('INVALID_OP', `Plan proposal "${id}" is already ${p.status}`);
    return p;
  }

  async function checkPlan(plan: PlanInput): Promise<void> {
    const roster = new Set((await employees.roster()).map((r) => r.botId));
    const v = validatePlan(plan, roster);
    if (!v.ok) throw new ContextError('INVALID_PLAN', `Invalid plan: ${v.reasons.join('; ')}`, { reasons: v.reasons });
  }

  // ---------------------------------------------------------------------------
  // submissions
  // ---------------------------------------------------------------------------

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
    const d = (await getBoard()).workstreams.find((x) => x.id === w.id)?.deliverables.find((x) => x.ref === ref);
    if (!d) throw new ContextError('INVALID_OP', `The deliverable for workstream ${w.id} could not be recorded`);
    await log(bot(botId), { kind: 'deliverableSubmitted', workstreamId: w.id, deliverableId: d.id });
    wakes.push({ botId: board.lead, reason: 'needsLead', detail: `deliverable ${d.id} of ${w.id} awaits review` });
    return wakes;
  }

  /** Appends a paragraph (or a pinned note) and condenses when over budget (R19). */
  async function saveNotes(botId: string, s: Extract<Submission, { type: 'notes' }>): Promise<void> {
    const prev = await workspaceOf(botId);
    const next: Workspace = s.pinned
      ? { ...prev, pinnedNotes: [...prev.pinnedNotes, s.text] }
      : { ...prev, notes: prev.notes.trim() === '' ? s.text : `${prev.notes}\n\n${s.text}` };
    const recent = splitParagraphs(next.notes);
    const r = await condenseSegments(
      { pinned: next.pinnedNotes, condensed: next.condensed, recent },
      { maxTokens: options.notesMaxTokens, recentKeep: options.recentKeep, count, condense: cfg.models?.condense },
    );
    if (r.ok && (r.state.recent.length !== recent.length || r.state.condensed !== next.condensed)) {
      next.notes = r.state.recent.join('\n\n');
      next.condensed = r.state.condensed;
    }
    await store.saveWorkspace(next);
    if (!r.ok) bus.emit('condenseAborted', { target: 'notes', botId, reason: r.reason });
  }

  // ---------------------------------------------------------------------------
  // the facade
  // ---------------------------------------------------------------------------

  const dispose = () => {
    for (const id of [...leadTimers.keys()]) clearLeadTimer(id);
  };

  return {
    async start(i) {
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
    },

    async buildPlanningContext() {
      const board = await getBoard();
      const ws = await workstreamsOf(board);
      const humanMessages = (await ledger()).filter((e) => e.author.kind === 'human' && e.body.type === 'chat');
      const meta = await store.getMeta<PlanMeta>(projectId, 'plan');
      const plan = meta ? await store.getPlanProposal(meta.proposalId) : null;
      const body = renderPlanning({
        board,
        roster: await employees.roster(),
        humanMessages,
        previous: plan ? { plan, feedback: meta?.feedback } : undefined,
      });
      return bundle(board, ws, body);
    },

    async proposePlan(plan, o) {
      const board = await openBoard();
      if (o.by !== board.lead) forbidden(`Only the lead (${board.lead}) can propose a plan`);
      await checkPlan(plan);
      const meta = await store.getMeta<PlanMeta>(projectId, 'plan');
      const prev = meta ? await store.getPlanProposal(meta.proposalId) : null;
      const proposal: PlanProposal = {
        id: newId('plan'),
        projectId,
        by: o.by,
        workstreams: planWorkstreams(plan),
        contracts: plan.contracts.map((c) => ({ ...c })),
        status: 'pending',
        // consecutive rejections carry over until a plan is approved (spec 7)
        rejectCount: prev && prev.status !== 'approved' ? prev.rejectCount : 0,
      };
      await store.savePlanProposal(proposal);
      await store.setMeta(projectId, 'plan', { proposalId: proposal.id } satisfies PlanMeta);
      if (board.planStatus === 'none') await patchBoard((b) => void (b.planStatus = 'draft'));
      await log(bot(o.by), { kind: 'planProposed', proposalId: proposal.id });
      bus.emit('needsHuman', { reason: `Plan ${proposal.id} awaits approval by the owner (${board.owner})`, ref: proposal.id });
      return { proposalId: proposal.id };
    },

    async approvePlan(id, o) {
      const board = await openBoard();
      if (o.by !== board.owner) forbidden(`Only the owner (${board.owner}) can approve a plan`);
      const proposal = await pendingPlan(id);
      if (o.edits) await checkPlan(o.edits);
      const plan = o.edits
        ? { workstreams: planWorkstreams(o.edits), contracts: o.edits.contracts.map((c) => ({ ...c })) }
        : { workstreams: proposal.workstreams, contracts: proposal.contracts };

      const before = await workstreamsOf(board);
      const beforeById = new Map(before.map((w) => [w.id, w]));
      const created = plan.workstreams.filter((w) => !beforeById.has(w.id));
      if (created.length > 0) await withRetry(() => source.create(projectId, created));
      const reshaped = plan.workstreams.filter((w) => {
        const old = beforeById.get(w.id);
        return old && (old.brief !== w.brief || !sameList(old.dependsOn, w.dependsOn));
      });

      let dropped: Contract[] = [];
      const { change } = await patchBoard((b) => {
        for (const w of plan.workstreams) {
          const row = b.workstreams.find((x) => x.id === w.id);
          // External source (R14): the core still stores brief, review rounds and deliverables.
          if (!row) b.workstreams.push({ ...structuredClone(w), status: 'pending', reviewRounds: 0, deliverables: [] });
          else if (external) row.brief = w.brief;
          else Object.assign(row, structuredClone(w)); // the local source's own fields live here too
        }
        const ops: AppliedOp[] = [];
        const contracts = plan.contracts.map((c): Contract => {
          const old = b.contracts.find((x) => x.id === c.id);
          if (!old) return { ...c, version: 1 };
          if (old.from === c.from && old.to === c.to && old.spec === c.spec) return old;
          ops.push({ op: { op: 'updateContract', id: c.id, spec: c.spec }, by: o.by, authority: 'human', touched: [c.id] });
          return { ...c, version: old.version + 1 };
        });
        dropped = b.contracts.filter((x) => !contracts.some((c) => c.id === x.id));
        b.contracts = contracts;
        b.planStatus = 'approved';
        return ops;
      });
      for (const c of dropped) await log(SYSTEM, { kind: 'archived', what: 'contracts', ref: JSON.stringify(c) });

      const mid = await workstreamsOf(await getBoard());
      const delivered = new Set(mid.filter((w) => w.status === 'delivered').map((w) => w.id));
      const ready = mid.filter((w) => w.status === 'pending' && w.dependsOn.every((d) => delivered.has(d)));
      for (const w of ready) await setStatus(w.id, 'active');
      await store.savePlanProposal({ ...proposal, status: 'approved' });
      await log(human(o.by), { kind: 'planApproved', proposalId: id });

      const after = await getBoard();
      const afterWs = await workstreamsOf(after);
      checkOverlaps(afterWs);
      const wakes: Wake[] = ready.map((w) => ({ botId: w.owner, reason: 'assigned', detail: `workstream ${w.id} can start` }));
      wakes.push(...structuralWakes(change, before, afterWs, after));
      for (const w of reshaped) {
        const now = afterWs.find((x) => x.id === w.id);
        if (now) wakes.push({ botId: now.owner, reason: 'contractChanged', detail: `brief or dependencies of ${w.id} changed` });
      }
      return finish(wakes);
    },

    async rejectPlan(id, o) {
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
    },

    buildBrief: (botId, o) => assembleBrief(briefDeps, botId, o),

    async submit(botId, s) {
      const { board, ws } = await memberView(botId, true);
      switch (s.type) {
        case 'deliverable':
          return finish(await submitDeliverable(board, ws, botId, s));
        case 'proposal': {
          // Conflicts are judged against what the bot last saw (spec 3).
          const seen = (await store.getWorkspace(projectId, botId))?.lastSeenBoardVersion ?? 0;
          const baseVersion = seen > 0 ? seen : board.version;
          await store.enqueueProposal({ id: newId('prop'), projectId, baseVersion, by: botId, ops: s.ops });
          return finish(await runMerge());
        }
        case 'blocked': {
          const w = ownedWorkstream(ws, botId, s.workstreamId);
          await setStatus(w.id, 'blocked');
          await log(bot(botId), { kind: 'blocked', workstreamId: w.id, reason: s.reason });
          return finish([{ botId: board.lead, reason: 'needsLead', detail: `workstream ${w.id} is blocked: ${s.reason}` }]);
        }
        case 'notes':
          await saveNotes(botId, s);
          return [];
      }
    },

    async buildReviewContext(deliverableId) {
      const board = await getBoard();
      const ws = await workstreamsOf(board);
      const { w, d } = byDeliverable(ws, deliverableId);
      const body = renderReview({
        content: await store.getDeliverable(projectId, d.ref),
        workstream: w,
        contracts: board.contracts.filter((c) => c.from === w.id || c.to === w.id),
        conventions: board.conventions,
        decisions: board.decisions.filter((x) => x.affects.includes(w.id)),
      });
      return bundle(board, ws, body);
    },

    async submitReview(deliverableId, r) {
      const board = await openBoard();
      if (r.by !== board.lead) forbidden(`Only the lead (${board.lead}) can review deliverables`);
      const { w } = byDeliverable(await workstreamsOf(board), deliverableId);
      const wakes: Wake[] = [];
      if (r.conventions && r.conventions.length > 0) {
        const ops: BoardOp[] = r.conventions.map((text) => ({
          op: 'add',
          section: 'conventions',
          item: { text, source: { entryIds: [], by: board.lead } },
        }));
        await store.enqueueProposal({ id: newId('prop'), projectId, baseVersion: board.version, by: board.lead, ops });
        wakes.push(...(await runMerge()));
      }
      await log(bot(r.by), { kind: r.passed ? 'reviewPassed' : 'reviewFailed', deliverableId, notes: r.notes });
      if (r.passed) {
        const before = await workstreamsOf(await getBoard());
        await setStatus(w.id, 'delivered');
        const after = await getBoard();
        const afterWs = await workstreamsOf(after);
        const op: AppliedOp = { op: { op: 'setWorkstreamStatus', id: w.id, status: 'delivered' }, by: r.by, authority: 'bot', touched: [w.id] };
        wakes.push(...structuralWakes({ version: after.version, mergedAt: clock.now(), ops: [op] }, before, afterWs, after));
        await activateReady(before, afterWs);
      } else {
        const { board: next } = await patchBoard((b) => {
          const row = b.workstreams.find((x) => x.id === w.id);
          if (row) row.reviewRounds += 1;
        });
        const rounds = next.workstreams.find((x) => x.id === w.id)?.reviewRounds ?? 0;
        wakes.push({ botId: w.owner, reason: 'reviewFailed', detail: `deliverable ${deliverableId} failed review: ${r.notes}` });
        if (rounds > options.maxReviewRounds) {
          bus.emit('needsHuman', { reason: `Workstream ${w.id} failed review ${rounds} times`, ref: w.id });
        }
      }
      return finish(wakes);
    },

    async resolveProposal(pendingId, r) {
      const board = await openBoard();
      const before = await workstreamsOf(board);
      const result = await merger.resolve(pendingId, r);
      // A pending item whose ops were all rejected stays queued, and so does its timer.
      if (!(await store.listPending(projectId)).some((p) => p.id === pendingId)) clearLeadTimer(pendingId);
      return finish(await afterMerge(before, result, board.lead));
    },

    async close(o) {
      const board = await openBoard();
      if (o.by !== board.owner) forbidden(`Only the owner (${board.owner}) can close the project`);
      const pending = (await workstreamsOf(board)).filter((w) => w.status !== 'delivered');
      if (pending.length > 0 && !o.force) {
        throw new ContextError('PROJECT_NOT_COMPLETE', `Workstreams not delivered: ${pending.map((w) => w.id).join(', ')}`, {
          pending: pending.map((w) => w.id),
        });
      }
      // Forced close: unfinished workstreams are recorded in the ledger before the project closes.
      for (const w of pending) await log(SYSTEM, { kind: 'archived', what: 'workstreams', ref: JSON.stringify(w) });
      await patchBoard((b) => void (b.status = 'closed'));
      await log(human(o.by), { kind: 'projectClosed', forced: pending.length > 0 });
      dispose();
    },

    async buildRetroContext(botId) {
      const { board, ws } = await memberView(botId, false);
      const own = ws.filter((w) => w.owner === botId);
      const mine = new Set(own.flatMap((w) => w.deliverables.map((d) => d.id)));
      const reviews = (await ledger()).filter((e) => {
        const ev = e.body.type === 'event' ? e.body.event : null;
        return (ev?.kind === 'reviewPassed' || ev?.kind === 'reviewFailed') && mine.has(ev.deliverableId);
      });
      const body = renderRetro({
        workspace: await workspaceOf(botId),
        workstream: own[0] ?? null,
        reviews,
        memory: await memoryOf(botId),
      });
      return bundle(board, ws, body);
    },

    async commitRetro(botId, memories) {
      await memberView(botId, false);
      const prev = await memoryOf(botId);
      const now = clock.now();
      const added = memories.map((m) => ({ id: newId('m'), text: m.text, fromProject: projectId, createdAt: now, pinned: m.pinned ?? false }));
      const next: EmployeeMemory = { ...prev, memories: [...prev.memories, ...added] };
      const recent = next.memories.filter((m) => !m.pinned);
      const r = await condenseSegments(
        { pinned: next.memories.filter((m) => m.pinned).map((m) => m.text), condensed: next.condensed, recent: recent.map((m) => m.text) },
        { maxTokens: options.memoryMaxTokens, recentKeep: options.recentKeep, count, condense: cfg.models?.condense },
      );
      if (r.ok && (r.state.recent.length !== recent.length || r.state.condensed !== next.condensed)) {
        const keep = new Set(recent.slice(recent.length - r.state.recent.length).map((m) => m.id));
        next.memories = next.memories.filter((m) => m.pinned || keep.has(m.id));
        next.condensed = r.state.condensed;
      }
      await store.saveMemory(next);
      if (!r.ok) bus.emit('condenseAborted', { target: 'memory', botId, reason: r.reason });
    },

    async ingest(c) {
      await openBoard();
      const parent = c.replyTo ? ((await ledger()).find((e) => e.id === c.replyTo) ?? null) : null;
      return store.append({ ...toLedgerEntry(c, parent), id: newId('e'), projectId, createdAt: clock.now() });
    },

    async route(entry) {
      const board = await openBoard();
      const ws = await workstreamsOf(board);
      const all = await ledger();
      const chats = all.filter((e) => e.body.type === 'chat' && e.seq < entry.seq);
      // R16: bot turns = bot chat entries after the last human chat entry and before this one.
      const afterSeq = chats.findLast((e) => e.author.kind === 'human')?.seq ?? 0;
      const botTurnsSinceHuman = chats.filter((e) => e.seq > afterSeq && e.author.kind === 'bot').length;
      const replyTo = entry.body.type === 'chat' ? entry.body.replyTo : undefined;
      const members = botMembers(board, ws);
      const r = await routeChat(entry, {
        lead: board.lead,
        members: new Set(members),
        workstreams: ws,
        botTurnsSinceHuman,
        parent: replyTo === undefined ? null : (all.find((e) => e.id === replyTo) ?? null),
        options,
        route: cfg.models?.route,
        routeInput: async () => ({
          boardPublic: renderBoardPublic(board, ws),
          recent: chats.slice(-options.recentForRouter),
          candidates: members.map((botId) => ({ botId, workstreams: ws.filter((w) => w.owner === botId).map((w) => w.id) })),
          message: entry,
        }),
      });
      // Once per human message, persisted so a restart does not repeat it.
      if (r.limitReached && (await store.getMeta<number>(projectId, 'wakeLimitReached')) !== afterSeq) {
        await store.setMeta(projectId, 'wakeLimitReached', afterSeq);
        bus.emit('wakeLimitReached', { afterSeq });
      }
      return finish(r.wakes);
    },

    async merge() {
      await openBoard();
      return finish(await runMerge());
    },

    async board() {
      const b = await getBoard();
      return { ...b, workstreams: await workstreamsOf(b) };
    },

    on: (k, h) => bus.on(k, h),
    dispose,
  };
}
