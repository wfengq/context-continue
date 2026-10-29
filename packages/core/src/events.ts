import type { BoardChange, Wake } from './types.js';

/** Typed events emitted by a project (design spec 6.1). */
export interface CoreEvents {
  boardChanged: { version: number };
  wake: { wakes: Wake[] };
  merged: { change: BoardChange };
  needsHuman: { reason: string; ref: string };
  extractFailed: { attempts: number };
  wakeLimitReached: { afterSeq: number };
  writeScopeOverlap: { a: string; b: string; prefix: string };
  condenseAborted: { target: 'notes' | 'memory'; botId: string; reason: string };
}

export interface EventBus {
  /** Subscribes a handler; returns an unsubscribe function. */
  on<K extends keyof CoreEvents>(k: K, h: (e: CoreEvents[K]) => void): () => void;
  emit<K extends keyof CoreEvents>(k: K, e: CoreEvents[K]): void;
}

export function createEventBus(): EventBus {
  const handlers = new Map<keyof CoreEvents, Set<(e: never) => void>>();
  return {
    on(k, h) {
      let set = handlers.get(k);
      if (!set) handlers.set(k, (set = new Set()));
      set.add(h);
      return () => {
        set.delete(h);
      };
    },
    emit(k, e) {
      for (const h of [...(handlers.get(k) ?? [])]) {
        try {
          (h as (e: CoreEvents[typeof k]) => void)(e);
        } catch {
          // a faulty subscriber must not break the operation that emitted or other subscribers
        }
      }
    },
  };
}
