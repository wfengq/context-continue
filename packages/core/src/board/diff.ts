import type { BoardChange, ProjectBoard, Wake, WakeReason, Workstream } from '../types.js';

const REASON_ORDER: WakeReason[] = ['upstreamDelivered', 'decisionChanged', 'contractChanged'];

type AffectingItem = { id: string; affects: string[] };

/**
 * Ids of workstreams that are `pending` in `after`, have at least one dependency, and whose
 * dependencies are all `delivered` in `after` but were not all delivered in `before`.
 * Workstreams that did not exist in `before` are skipped (they are covered by `assigned`).
 */
export function newlyReady(before: Workstream[], after: Workstream[]): string[] {
  const beforeById = new Map(before.map((w) => [w.id, w]));
  const afterById = new Map(after.map((w) => [w.id, w]));
  const allDelivered = (w: Workstream, byId: Map<string, Workstream>): boolean =>
    w.dependsOn.every((dep) => byId.get(dep)?.status === 'delivered');

  const ready: string[] = [];
  for (const w of after) {
    if (w.status !== 'pending' || w.dependsOn.length === 0) continue;
    const prev = beforeById.get(w.id);
    if (!prev) continue;
    if (allDelivered(w, afterById) && !allDelivered(prev, beforeById)) ready.push(w.id);
  }
  return ready;
}

/**
 * Wakes derived from one board merge (spec 5.1): upstreamDelivered, decisionChanged, contractChanged.
 * `board` is the board after the change; `before`/`after` are the workstream lists around it.
 * One wake per (bot, reason); details of merged wakes are joined with '; '.
 */
export function structuralWakes(
  change: BoardChange,
  before: Workstream[],
  after: Workstream[],
  board: ProjectBoard,
): Wake[] {
  const afterById = new Map(after.map((w) => [w.id, w]));
  const acc = new Map<string, { botId: string; reason: WakeReason; details: string[] }>();

  const add = (workstreamId: string, reason: WakeReason, detail: string): void => {
    const w = afterById.get(workstreamId);
    if (!w || !w.owner) return;
    // Blocked workstreams only take decisionChanged and contractChanged.
    if (w.status === 'blocked' && reason !== 'decisionChanged' && reason !== 'contractChanged') return;
    const key = `${reason}\u0000${w.owner}`;
    let entry = acc.get(key);
    if (!entry) {
      entry = { botId: w.owner, reason, details: [] };
      acc.set(key, entry);
    }
    if (!entry.details.includes(detail)) entry.details.push(detail);
  };

  for (const id of newlyReady(before, after)) {
    add(id, 'upstreamDelivered', `dependencies of ${id} delivered`);
  }

  const affecting = (label: string, items: AffectingItem[], touched: string[]): void => {
    for (const id of touched) {
      const item = items.find((i) => i.id === id);
      if (!item) continue;
      for (const wsId of item.affects) add(wsId, 'decisionChanged', `${label} ${item.id} affects ${wsId}`);
    }
  };

  for (const applied of change.ops) {
    const op = applied.op;
    switch (op.op) {
      case 'addDecision':
        affecting('decision', board.decisions, applied.touched);
        break;
      case 'addFact':
        affecting('fact', board.facts, applied.touched);
        break;
      case 'addFailure':
        affecting('failure', board.failures, applied.touched);
        break;
      case 'supersede':
        if (op.section === 'decisions') affecting('decision', board.decisions, applied.touched);
        else if (op.section === 'facts') affecting('fact', board.facts, applied.touched);
        else if (op.section === 'failures') affecting('failure', board.failures, applied.touched);
        break;
      case 'updateContract':
        for (const id of applied.touched) {
          const contract = board.contracts.find((c) => c.id === id);
          if (!contract) continue;
          add(contract.from, 'contractChanged', `contract ${contract.id} changed for ${contract.from}`);
          add(contract.to, 'contractChanged', `contract ${contract.id} changed for ${contract.to}`);
        }
        break;
      default:
        break;
    }
  }

  return [...acc.values()]
    .sort((x, y) => {
      const r = REASON_ORDER.indexOf(x.reason) - REASON_ORDER.indexOf(y.reason);
      if (r !== 0) return r;
      return x.botId < y.botId ? -1 : x.botId > y.botId ? 1 : 0;
    })
    .map((e) => ({ botId: e.botId, reason: e.reason, detail: e.details.join('; ') }));
}

const segments = (scope: string): string[] => scope.split('/').filter((s) => s !== '' && s !== '.');

function overlap(x: string[], y: string[]): string | undefined {
  const n = Math.min(x.length, y.length);
  if (n === 0) return undefined;
  for (let i = 0; i < n; i++) if (x[i] !== y[i]) return undefined;
  return (x.length <= y.length ? x : y).join('/');
}

/**
 * Pairs of `active` workstreams whose write scopes overlap, compared by path segments
 * (`src/ui` overlaps `src/ui/button`, not `src/uix`). One entry per pair, `a` before `b` in input order,
 * `prefix` being the shorter of the first overlapping scope pair. Empty scopes are ignored.
 */
export function writeScopeOverlaps(workstreams: Workstream[]): { a: string; b: string; prefix: string }[] {
  const active = workstreams
    .filter((w) => w.status === 'active')
    .map((w) => ({ id: w.id, scopes: w.writeScopes.map(segments) }));
  const out: { a: string; b: string; prefix: string }[] = [];
  for (let i = 0; i < active.length; i++) {
    for (let j = i + 1; j < active.length; j++) {
      const found = firstOverlap(active[i]!.scopes, active[j]!.scopes);
      if (found !== undefined) out.push({ a: active[i]!.id, b: active[j]!.id, prefix: found });
    }
  }
  return out;
}

function firstOverlap(xs: string[][], ys: string[][]): string | undefined {
  for (const x of xs) {
    for (const y of ys) {
      const p = overlap(x, y);
      if (p !== undefined) return p;
    }
  }
  return undefined;
}
