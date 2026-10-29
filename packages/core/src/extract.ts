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
  /** Enqueues the ops as an `extractor` proposal and merges them (one queued operation). */
  enqueue: (ops: BoardOp[], baseVersion: number) => Promise<void>;
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

  const save = async (p: ExtractProgress) => {
    await store.setMeta(projectId, EXTRACT_META, p);
    progress = p;
  };

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
    const entries = await pendingMessages();
    if (entries.length === 0) return 'empty';
    const upTo = entries[entries.length - 1]!.seq;
    const start = await loadProgress();
    try {
      const board = await deps.board();
      const raw = await extract!(entries, board);
      if (!Array.isArray(raw)) throw new Error('extract must return an array of ops');
      const { ok, rejected } = parseOps(raw);
      if (rejected.length > 0) {
        throw new Error(`extract returned invalid ops: ${rejected.map(r => `#${r.index} ${r.reason}`).join('; ')}`);
      }
      if (ok.length > 0) await deps.enqueue(ok, board.version);
    } catch {
      const failures = start.failures + 1;
      await save({ fromSeq: start.fromSeq, failures });
      if (failures >= FAILURES_BEFORE_EVENT) emit('extractFailed', { attempts: failures });
      return 'failed';
    }
    await save({ fromSeq: upTo + 1, failures: 0 });
    return 'ok';
  }

  async function loop(): Promise<void> {
    try {
      for (;;) {
        clearTimer();
        const outcome = await once();
        if (disposed) return;
        if (outcome === 'failed') return armTimer(); // retry on the next trigger or after idleMs
        const pending = (await pendingMessages()).length;
        if (outcome === 'ok' && pending >= options.extractEvery) continue;
        if (pending > 0) armTimer();
        return;
      }
    } catch {
      // storage errors: progress is only ever saved after success, so the range is retried
      if (!disposed) armTimer();
    }
  }

  function startRun(): void {
    if (disposed || inflight || !extract) return;
    inflight = loop().finally(() => {
      inflight = null;
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
      await steps;
      while (inflight) await inflight;
    },
    dispose() {
      disposed = true;
      clearTimer();
    },
  };
}
