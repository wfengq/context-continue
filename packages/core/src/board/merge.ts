import type { Clock } from '../clock.js';
import { ContextError } from '../errors.js';
import { newId as defaultNewId, type IdGenerator } from '../ids.js';
import type { Options } from '../options.js';
import type { Store } from '../store/store.js';
import type {
  AppliedOp,
  BoardChange,
  BoardOp,
  PendingProposal,
  ProjectBoard,
  ProjectEvent,
  Proposal,
} from '../types.js';
import { applyOp, type ArchivedItem } from './apply.js';
import { enforceBoardSize } from './archive.js';
import { classifyOp } from './classify.js';
import { parseOps } from './schema.js';

export interface Rejection {
  proposalId: string;
  index: number;
  reason: string;
}

export interface MergeResult {
  change: BoardChange | null;
  pending: PendingProposal[];
  rejected: Rejection[];
}

export interface MergerDeps {
  store: Store;
  projectId: string;
  clock: Clock;
  options: Required<Options>;
  count: (s: string) => number;
  renderPublic: (b: ProjectBoard) => string;
  ownWorkstreams: (botId: string) => Promise<string[]>;
  /** Id generator for pending items, ledger entries and created board items; defaults to `newId`. */
  newId?: IdGenerator;
}

/** How many times a save that hit STALE_VERSION is retried before the error is rethrown. */
const MAX_RETRIES = 3;
const EXTRACTOR = 'extractor';
const MERGER_AUTHOR = { kind: 'system', id: 'merger' } as const;

interface IndexedOp {
  op: BoardOp;
  index: number; // position in the submitted ops array
}

/** Result of applying ops to one freshly read board. */
interface Attempt {
  next: ProjectBoard;
  applied: AppliedOp[];
  archived: ArchivedItem[];
  rejected: Rejection[];
  pending: PendingProposal[];
}

const authorityOf = (by: string): 'human' | 'bot' => (by === EXTRACTOR ? 'human' : 'bot');

/**
 * Validate a submitted ops array, keeping each valid op's original index. A value that is not
 * an array, or that makes parsing throw, is reported as a single rejection with index -1.
 */
function parseIndexed(raw: unknown): { ops: IndexedOp[]; rejected: { index: number; reason: string }[] } {
  if (!Array.isArray(raw)) return { ops: [], rejected: [{ index: -1, reason: 'ops must be an array' }] };
  try {
    const { ok, rejected } = parseOps(raw);
    const bad = new Set(rejected.map((r) => r.index));
    const okIndexes = raw.map((_, i) => i).filter((i) => !bad.has(i));
    return { ops: ok.map((op, k) => ({ op, index: okIndexes[k]! })), rejected };
  } catch (e) {
    return { ops: [], rejected: [{ index: -1, reason: `ops could not be parsed: ${String(e)}` }] };
  }
}

const isStale = (e: unknown) => e instanceof ContextError && e.code === 'STALE_VERSION';

/**
 * Merges proposals into a project board. It is not the only board writer (the facade and the
 * WorkstreamSource write too); safety comes from the store's version check on `saveBoard` plus the
 * project's serial queue. Proposals are merged one batch at a time behind a promise-chain lock;
 * `merge()` and `resolve()` share that lock.
 */
export class Merger {
  private chain: Promise<void> = Promise.resolve();

  private readonly newId: IdGenerator;

  constructor(private readonly deps: MergerDeps) {
    this.newId = deps.newId ?? defaultNewId;
  }

  /** Drain the proposal queue and merge it: auto ops land in one BoardChange, the rest wait. */
  merge(): Promise<MergeResult> {
    return this.serial(() => this.runMerge());
  }

  /** Accept (optionally with edits) or reject a pending proposal. */
  resolve(pendingId: string, r: { by: string; accept: boolean; edits?: BoardOp[] }): Promise<MergeResult> {
    return this.serial(() => this.runResolve(pendingId, r));
  }

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn);
    // Keep the chain alive whatever `fn` does; the caller still sees the rejection via `run`.
    this.chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async runMerge(): Promise<MergeResult> {
    const { store, projectId } = this.deps;
    const proposals = await store.drainProposals(projectId);
    if (proposals.length === 0) return { change: null, pending: [], rejected: [] };

    let parsed: { proposal: Proposal; ops: IndexedOp[]; rejected: Rejection[] }[];
    let committed: { attempt: Attempt; change: BoardChange | null; archived: ArchivedItem[] } | null;
    try {
      parsed = proposals.map((proposal) => {
        const { ops, rejected } = parseIndexed(proposal.ops);
        return { proposal, ops, rejected: rejected.map((r) => ({ proposalId: proposal.id, ...r })) };
      });
      // Proposals with no valid op only contribute rejections; they are dropped from the batch
      // (their fields may be malformed too, e.g. baseVersion).
      const usable = parsed.filter((p) => p.ops.length > 0);
      committed = usable.length > 0 ? await this.commit((board) => this.applyProposals(board, usable)) : null;
    } catch (e) {
      // Nothing was written: put the proposals back so a failed merge loses no ops. A failing
      // re-enqueue must not hide the original error.
      try {
        for (const p of proposals) await store.enqueueProposal(p);
      } catch {
        // ignored: `e` is the error the caller needs to see
      }
      throw e;
    }

    const pending = committed?.attempt.pending ?? [];
    const change = committed?.change ?? null;
    for (const p of pending) await store.savePending(p);
    await this.writeLedger(committed?.archived ?? [], change);

    const order = new Map(proposals.map((p, i) => [p.id, i]));
    const rejected = [...parsed.flatMap((p) => p.rejected), ...(committed?.attempt.rejected ?? [])].sort(
      (a, b) => order.get(a.proposalId)! - order.get(b.proposalId)! || a.index - b.index,
    );
    return { change, pending, rejected };
  }

  /** Classify and apply every parsed op against `board`. Pure apart from reading the store. */
  private async applyProposals(
    board: ProjectBoard,
    parsed: { proposal: Proposal; ops: IndexedOp[] }[],
  ): Promise<Attempt> {
    const { store, projectId, clock } = this.deps;
    const minBase = Math.min(...parsed.map((p) => p.proposal.baseVersion));
    const history = await store.getBoardChanges(projectId, minBase);

    const attempt: Attempt = { next: board, applied: [], archived: [], rejected: [], pending: [] };
    for (const { proposal, ops } of parsed) {
      const by = proposal.by;
      const isExtractor = by === EXTRACTOR;
      const authority = authorityOf(by);

      // Items others touched since this proposal's base: stored changes plus earlier ops of this batch.
      const touchedByOthersSince = new Set<string>();
      const othersOps = [
        ...history.filter((c) => c.version > proposal.baseVersion).flatMap((c) => c.ops),
        ...attempt.applied,
      ].filter((a) => a.by !== by);
      for (const a of othersOps) for (const id of a.touched) touchedByOthersSince.add(id);

      const ownWorkstreams = isExtractor ? [] : await this.deps.ownWorkstreams(by);
      const waiting: Record<'lead' | 'human', BoardOp[]> = { lead: [], human: [] };

      for (const { op, index } of ops) {
        const cls = classifyOp(op, {
          by,
          lead: board.lead,
          isExtractor,
          ownWorkstreams,
          board: attempt.next,
          touchedByOthersSince,
        });
        if (cls !== 'auto') {
          waiting[cls].push(op);
          continue;
        }
        this.applyOne(attempt, op, { by, authority }, proposal.id, index);
      }

      for (const needs of ['lead', 'human'] as const) {
        if (waiting[needs].length === 0) continue;
        attempt.pending.push({
          id: this.newId('pend'),
          projectId,
          proposalId: proposal.id,
          by,
          ops: waiting[needs],
          needs,
          createdAt: clock.now(),
        });
      }
    }
    return attempt;
  }

  /** Apply one auto op to `attempt.next`; an INVALID_OP becomes a rejection and the op is skipped. */
  private applyOne(
    attempt: Attempt,
    op: BoardOp,
    meta: { by: string; authority: 'human' | 'bot' },
    proposalId: string,
    index: number,
  ): void {
    try {
      const r = applyOp(attempt.next, op, { ...meta, newId: this.newId });
      attempt.next = r.board;
      attempt.applied.push({ op, by: meta.by, authority: meta.authority, touched: r.touched });
      attempt.archived.push(...r.archived);
    } catch (e) {
      if (!(e instanceof ContextError && e.code === 'INVALID_OP')) throw e;
      attempt.rejected.push({ proposalId, index, reason: e.message });
    }
  }

  /**
   * Read the board, build an attempt and save it as one BoardChange (if any op applied).
   * On STALE_VERSION the whole attempt is rebuilt against the fresh board, up to MAX_RETRIES times.
   */
  private async commit(
    build: (board: ProjectBoard) => Promise<Attempt>,
  ): Promise<{ attempt: Attempt; change: BoardChange | null; archived: ArchivedItem[] }> {
    const { store, projectId, clock, options, count, renderPublic } = this.deps;
    for (let retry = 0; ; retry++) {
      const board = await store.getBoard(projectId);
      const attempt = await build(board);
      if (attempt.applied.length === 0) return { attempt, change: null, archived: [] };

      const sized = enforceBoardSize(attempt.next, options.boardMaxTokens, count, renderPublic);
      const now = clock.now();
      const version = board.version + 1;
      const change: BoardChange = { version, mergedAt: now, ops: attempt.applied };
      try {
        await store.saveBoard({ ...sized.board, version, updatedAt: now }, board.version, change);
      } catch (e) {
        if (isStale(e) && retry < MAX_RETRIES) continue;
        throw e;
      }
      return { attempt, change, archived: [...attempt.archived, ...sized.archived] };
    }
  }

  private async runResolve(
    pendingId: string,
    r: { by: string; accept: boolean; edits?: BoardOp[] },
  ): Promise<MergeResult> {
    const { store, projectId } = this.deps;
    const pending = (await store.listPending(projectId)).find((p) => p.id === pendingId);
    if (!pending) throw new ContextError('NOT_FOUND', `No pending proposal ${pendingId}`);

    const board = await store.getBoard(projectId);
    const allowed = pending.needs === 'lead' ? board.lead : board.owner;
    if (r.by !== allowed) {
      const who = pending.needs === 'lead' ? `the lead (${board.lead})` : `the owner (${board.owner})`;
      throw new ContextError('FORBIDDEN', `Pending proposal ${pendingId} can only be resolved by ${who}`, {
        by: r.by,
        needs: pending.needs,
      });
    }

    if (!r.accept) {
      await store.deletePending(pendingId);
      return { change: null, pending: [], rejected: [] };
    }

    const { ops, rejected: schemaRejected } = parseIndexed(r.edits ?? pending.ops);
    // Without edits the ops stay the submitter's; edited ops are the resolver's own (R11).
    const meta = r.edits
      ? { by: r.by, authority: r.by === board.owner ? ('human' as const) : ('bot' as const) }
      : { by: pending.by, authority: authorityOf(pending.by) };
    const { attempt, change, archived } = await this.commit(async (fresh) => {
      const attempt: Attempt = { next: fresh, applied: [], archived: [], rejected: [], pending: [] };
      const needsHuman: BoardOp[] = [];
      for (const { op, index } of ops) {
        // The lead cannot approve what needs the owner: those ops wait for a human (R10).
        if (
          pending.needs === 'lead' &&
          classifyOp(op, {
            by: fresh.lead,
            lead: fresh.lead,
            isExtractor: false,
            ownWorkstreams: [],
            board: attempt.next,
            touchedByOthersSince: new Set(),
          }) === 'human'
        ) {
          needsHuman.push(op);
          continue;
        }
        this.applyOne(attempt, op, meta, pending.proposalId, index);
      }
      if (needsHuman.length > 0) {
        attempt.pending.push({
          id: this.newId('pend'),
          projectId,
          proposalId: pending.proposalId,
          by: meta.by,
          ops: needsHuman,
          needs: 'human',
          createdAt: this.deps.clock.now(),
        });
      }
      return attempt;
    });

    const rejected = [
      ...schemaRejected.map((x) => ({ proposalId: pending.proposalId, ...x })),
      ...attempt.rejected,
    ].sort((a, b) => a.index - b.index);
    for (const p of attempt.pending) await store.savePending(p);
    // When every op was rejected, keep the pending item so it can be resolved again with fixed edits.
    const nothingDone = !change && attempt.pending.length === 0;
    if (!(nothingDone && rejected.length > 0)) await store.deletePending(pendingId);
    await this.writeLedger(archived, change);
    return { change, pending: attempt.pending, rejected };
  }

  /** One `archived` event per archived item, then `boardMerged` if a change was saved. */
  private async writeLedger(archived: ArchivedItem[], change: BoardChange | null): Promise<void> {
    const events: ProjectEvent[] = archived.map((a) => ({
      kind: 'archived',
      what: a.section,
      ref: JSON.stringify(a.item),
    }));
    if (change) events.push({ kind: 'boardMerged', version: change.version });
    for (const event of events) {
      await this.deps.store.append({
        id: this.newId('e'),
        projectId: this.deps.projectId,
        createdAt: this.deps.clock.now(),
        author: MERGER_AUTHOR,
        body: { type: 'event', event },
      });
    }
  }
}
