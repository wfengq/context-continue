// Scheduling of human-chat extraction (design spec 5.3). The model call itself is the host's
// `models.extract`; this module decides when it runs, which messages it sees and what happens
// when it fails. It never runs inside the project's serial queue: only `enqueue` (propose and
// merge) is queued by the caller.
import type { Clock } from './clock.js';
import { parseOps } from './board/schema.js';
import type { EventBus } from './events.js';
import type { Options } from './options.js';
import type { Store } from './store/store.js';
import type { BoardOp, LedgerEntry, ProjectBoard } from './types.js';

/** Meta key holding {@link ExtractProgress}. */
export const EXTRACT_META = 'extract';
/** Consecutive failures from which `extractFailed` is emitted (on that one and on every further one). */
const FAILURES_BEFORE_EVENT = 3;

export interface ExtractProgress {
  /** First human chat seq that has not been extracted yet. */
  fromSeq: number;
  /** Consecutive failed runs. */
  failures: number;
}

export interface ExtractorDeps {
  store: Store;
  projectId: string;
  clock: Clock;
  options: Required<Options>;
  /** The host's extraction model; without it nothing is scheduled. */
  extract?: (e: LedgerEntry[], b: ProjectBoard) => Promise<BoardOp[]>;
  /** Reads the board handed to `extract`; its version is the proposal's base version. */
  board: () => Promise<ProjectBoard>;
  /** Durably queues the ops as an `extractor` proposal and returns its id. Does not merge. */
  enqueue: (ops: BoardOp[], baseVersion: number) => Promise<string>;
  /** Merges the proposal queue (one queued operation). */
  merge: () => Promise<void>;
  /** Records an invalid op the extraction model returned (dropped, never fatal). */
  rejected: (ref: string) => Promise<void>;
  emit: EventBus['emit'];
}

export interface Extractor {
  /** Counts the new human message towards the threshold or (re)arms the idle timer; never waits for a run. */
  onHumanMessage(entry: LedgerEntry): Promise<void>;
  /** Loads saved progress and schedules a run for messages still pending after a restart. */
  restore(): Promise<void>;
  /** Resolves when no scheduling step and no extraction is in flight. */
  flush(): Promise<void>;
  dispose(): void;
}

const isHumanChat = (e: LedgerEntry) => e.author.kind === 'human' && e.body.type === 'chat';

export function createExtractor(deps: ExtractorDeps): Extractor {
  const { store, projectId, clock, options, extract, emit } = deps;
  let progress: ExtractProgress | null = null;
  let timer: unknown = null;
  let inflight: Promise<void> | null = null;
  let disposed = false;
  let steps: Promise<void> = Promise.resolve();

  const loadProgress = async (): Promise<ExtractProgress> =>
    (progress ??= (await store.getMeta<ExtractProgress>(projectId, EXTRACT_META)) ?? { fromSeq: 1, failures: 0 });

  /** Consecutive failures counted when progress could not be loaded or saved. */
  let memFailures = 0;

  /** Memory first: if the write fails, this process still never re-extracts a range it already queued. */
  const save = async (p: ExtractProgress) => {
    progress = p;
    memFailures = p.failures;
    await store.setMeta(projectId, EXTRACT_META, p);
  };

  /** A failed run keeps the range; the third consecutive failure (and each later one) is announced. */
  async function fail(): Promise<'failed'> {
    const failures = (progress?.failures ?? memFailures) + 1;
    memFailures = failures;
    if (progress) await save({ fromSeq: progress.fromSeq, failures }).catch(() => undefined);
    if (failures >= FAILURES_BEFORE_EVENT) emit('extractFailed', { attempts: failures });
    return 'failed';
  }

  async function pendingMessages(): Promise<LedgerEntry[]> {
    return (await store.read(projectId, (await loadProgress()).fromSeq)).filter(isHumanChat);
  }

  function clearTimer(): void {
    if (timer === null) return;
    clock.clearTimeout(timer);
    timer = null;
  }

  function armTimer(): void {
    clearTimer();
    if (disposed) return;
    timer = clock.setTimeout(() => {
      timer = null;
      startRun();
    }, options.idleMs);
  }

  /** One extraction over everything pending now. */
  async function once(): Promise<'ok' | 'failed' | 'empty'> {
    let upTo: number;
    let raw: unknown[];
    let rejected: ReturnType<typeof parseOps>['rejected'];
    let proposalId: string | null = null;
    try {
      const entries = await pendingMessages();
      if (entries.length === 0) return 'empty';
      upTo = entries[entries.length - 1]!.seq;
      const board = await deps.board();
      const result = await extract!(entries, board);
      if (!Array.isArray(result)) throw new Error('extract must return an array of ops');
      raw = result;
      const parsed = parseOps(raw);
      rejected = parsed.rejected;
      if (parsed.ok.length > 0) proposalId = await deps.enqueue(parsed.ok, board.version);
    } catch {
      return fail();
    }
    // The proposal is queued: from here on the range must never be extracted again, whatever fails.
    await save({ fromSeq: upTo + 1, failures: 0 }).catch(() => undefined);
    // Invalid ops are dropped one by one (spec 7) and recorded.
    for (const r of rejected) {
      await deps.rejected(JSON.stringify({ index: r.index, reason: r.reason, op: raw[r.index] })).catch(() => undefined);
    }
    if (proposalId !== null) {
      try {
        await deps.merge();
      } catch (e) {
        // The queued proposal is merged by the next merge; re-extracting would apply it twice.
        emit('needsHuman', {
          reason: `Extracted proposal ${proposalId} could not be merged yet and stays queued: ${e instanceof Error ? e.message : String(e)}`,
          ref: proposalId,
        });
      }
    }
    return 'ok';
  }

  /** Resolves true when the run ended normally, so the caller should look for messages that arrived meanwhile. */
  async function loop(): Promise<boolean> {
    try {
      for (;;) {
        clearTimer();
        const outcome = await once();
        if (disposed) return false;
        if (outcome === 'failed') {
          armTimer(); // retry on the next trigger or after idleMs
          return false;
        }
        const pending = (await pendingMessages()).length;
        if (outcome === 'ok' && pending >= options.extractEvery) continue;
        if (pending > 0) armTimer();
        return true;
      }
    } catch {
      // storage failure outside a run's own handling: count it, retry later
      if (!disposed) {
        await fail();
        armTimer();
      }
      return false;
    }
  }

  function startRun(): void {
    if (disposed || inflight || !extract) return;
    inflight = loop().then(recheck => {
      inflight = null;
      // A message appended after the loop's last read found `inflight` set and did nothing.
      if (recheck && !disposed) step(schedule).catch(() => undefined);
    });
  }

  /** Runs scheduling steps one at a time so concurrent ingests count consistently. */
  function step(fn: () => Promise<void>): Promise<void> {
    const run = steps.then(fn);
    steps = run.catch(() => undefined);
    return run;
  }

  async function schedule(): Promise<void> {
    if (disposed || !extract || inflight) return; // during a run, the run reschedules when it ends
    const pending = (await pendingMessages()).length;
    if (pending === 0) return clearTimer();
    if (pending >= options.extractEvery) {
      clearTimer();
      return startRun();
    }
    if (timer === null) armTimer(); // a message already armed it; re-arming here would push the deadline back
  }

  return {
    onHumanMessage() {
      // Re-arm synchronously so a message always restarts the silence period; the counting step decides the rest.
      if (extract && !inflight) armTimer();
      return step(schedule);
    },
    restore: () => step(schedule),
    async flush() {
      for (;;) {
        const seen = steps;
        await seen;
        if (inflight) await inflight;
        else if (seen === steps) return;
      }
    },
    dispose() {
      disposed = true;
      clearTimer();
    },
  };
}
