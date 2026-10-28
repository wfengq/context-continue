export interface PlanInput {
  workstreams: {
    id: string;
    title: string;
    brief: string;
    owner: string;
    dependsOn: string[];
    writeScopes?: string[];
  }[];
  contracts: { id: string; from: string; to: string; spec: string }[];
}

export type PlanValidation = { ok: true } | { ok: false; reasons: string[] };

/** First dependency cycle found by DFS (in workstream order), as the path from the cycle's start back to it. */
function findCycle(deps: Map<string, string[]>): string[] | null {
  const state = new Map<string, 'visiting' | 'done'>();
  const stack: string[] = [];

  const visit = (id: string): string[] | null => {
    state.set(id, 'visiting');
    stack.push(id);
    for (const next of deps.get(id) ?? []) {
      if (!deps.has(next)) continue; // unknown ids are reported separately
      const s = state.get(next);
      if (s === 'visiting') return [...stack.slice(stack.indexOf(next)), next];
      if (s === undefined) {
        const found = visit(next);
        if (found) return found;
      }
    }
    stack.pop();
    state.set(id, 'done');
    return null;
  };

  for (const id of deps.keys()) {
    if (state.has(id)) continue;
    const found = visit(id);
    if (found) return found;
  }
  return null;
}

/** Checks a proposed plan and reports every problem found. */
export function validatePlan(plan: PlanInput, rosterIds: Set<string>): PlanValidation {
  const reasons: string[] = [];
  const ids = new Set<string>();
  const deps = new Map<string, string[]>();

  for (const w of plan.workstreams) {
    if (ids.has(w.id)) {
      reasons.push(`Duplicate workstream id "${w.id}"`);
      continue;
    }
    ids.add(w.id);
    deps.set(w.id, w.dependsOn);
  }

  for (const w of plan.workstreams) {
    if (!rosterIds.has(w.owner)) {
      reasons.push(`Workstream "${w.id}" has owner "${w.owner}" who is not in the roster`);
    }
    for (const d of w.dependsOn) {
      if (!ids.has(d)) reasons.push(`Workstream "${w.id}" depends on unknown workstream "${d}"`);
    }
  }

  const cycle = findCycle(deps);
  if (cycle) reasons.push(`Dependency cycle: ${cycle.join(' -> ')}`);

  const contractIds = new Set<string>();
  for (const c of plan.contracts) {
    if (contractIds.has(c.id)) reasons.push(`Duplicate contract id "${c.id}"`);
    contractIds.add(c.id);
    if (!ids.has(c.from)) reasons.push(`Contract "${c.id}" references unknown workstream "${c.from}" (from)`);
    if (!ids.has(c.to)) reasons.push(`Contract "${c.id}" references unknown workstream "${c.to}" (to)`);
  }

  return reasons.length === 0 ? { ok: true } : { ok: false, reasons };
}
