// What approving a plan changes relative to the current workstreams and contracts (spec 4 ⑥).
// Pure: no I/O.
import type { Contract, PlanProposal, Workstream } from '../types.js';

export type PlanWorkstream = PlanProposal['workstreams'][number];
export type ApprovedPlan = { workstreams: PlanWorkstream[]; contracts: PlanProposal['contracts'] };

/** Workstream fields owned by a host WorkstreamSource (spec 6.4); `brief` is always the core's. */
const HOST_FIELDS = ['title', 'owner', 'dependsOn', 'writeScopes'] as const;

export interface PlanChanges {
  /** Plan workstreams that do not exist yet. */
  created: PlanWorkstream[];
  /** Existing workstreams whose brief or dependencies change, with the changed fields. */
  reshaped: { id: string; fields: ('brief' | 'dependsOn')[] }[];
  /** One line per host-owned field the plan changes on an existing workstream (R22). */
  hostFieldChanges: string[];
  /** The contract list after approval: unchanged ones keep their version, changed ones get version + 1. */
  contracts: Contract[];
  updated: Contract[];
  added: Contract[];
  dropped: Contract[];
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

export function diffPlan(plan: ApprovedPlan, existing: Workstream[], current: Contract[]): PlanChanges {
  const byId = new Map(existing.map(w => [w.id, w]));
  const out: PlanChanges = { created: [], reshaped: [], hostFieldChanges: [], contracts: [], updated: [], added: [], dropped: [] };

  for (const w of plan.workstreams) {
    const old = byId.get(w.id);
    if (!old) {
      out.created.push(w);
      continue;
    }
    for (const f of HOST_FIELDS) {
      if (!same(old[f], w[f])) out.hostFieldChanges.push(`Workstream "${w.id}": ${f} cannot be changed by a plan; change it in the host`);
    }
    const fields = (['brief', 'dependsOn'] as const).filter(f => !same(old[f], w[f]));
    if (fields.length > 0) out.reshaped.push({ id: w.id, fields: [...fields] });
  }

  for (const c of plan.contracts) {
    const old = current.find(x => x.id === c.id);
    if (!old) {
      const added = { ...c, version: 1 };
      out.added.push(added);
      out.contracts.push(added);
    } else if (old.from === c.from && old.to === c.to && old.spec === c.spec) {
      out.contracts.push(old);
    } else {
      const updated = { ...c, version: old.version + 1 };
      out.updated.push(updated);
      out.contracts.push(updated);
    }
  }
  out.dropped = current.filter(x => !plan.contracts.some(c => c.id === x.id));
  return out;
}
