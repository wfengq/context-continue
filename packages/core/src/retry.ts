import { ContextError } from './errors.js';
import type { Store } from './store/store.js';

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

/** The same store with every write except `append` wrapped in `withRetry`. */
export function retryingStore(store: Store): Store {
  return new Proxy(store, {
    get(target, key, receiver) {
      const v: unknown = Reflect.get(target, key, receiver);
      if (typeof v !== 'function') return v;
      const fn = (...args: unknown[]) => (v as (...a: unknown[]) => Promise<unknown>).apply(target, args);
      return RETRIED_WRITES.has(key) ? (...args: unknown[]) => withRetry(() => fn(...args)) : fn;
    },
  });
}
