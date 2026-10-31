import { readFileSync } from 'node:fs';
import { toolDefinitions, type PlanInput } from '@context-continue/core';
import { z } from 'zod';
import type { Scenario } from './types.js';

const planSchema = z.object({
  workstreams: z.array(z.object({
    id: z.string().min(1),
    title: z.string(),
    brief: z.string(),
    owner: z.string().min(1),
    dependsOn: z.array(z.string()),
    writeScopes: z.array(z.string()).optional(),
  })),
  contracts: z.array(z.object({ id: z.string(), from: z.string(), to: z.string(), spec: z.string() })),
});

const toolCallSchema = z.object({ name: z.string().min(1), args: z.unknown() });

const stepSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('human'), text: z.string(), mentions: z.array(z.string()).optional() }),
  z.object({
    kind: z.literal('work'),
    botId: z.string().min(1),
    workstreamId: z.string().min(1),
    reply: z.string(),
    ops: z.array(toolCallSchema).optional(),
  }),
  z.object({
    kind: z.literal('review'),
    deliverableOf: z.string().min(1),
    passed: z.boolean(),
    notes: z.string(),
    conventions: z.array(z.string()).optional(),
  }),
  z.object({ kind: z.literal('replan'), plan: planSchema }),
]);

const scenarioSchema = z.object({
  id: z.string().min(1),
  goal: z.string(),
  constraints: z.array(z.string()),
  owner: z.string().min(1),
  lead: z.string().min(1),
  employees: z.array(z.object({
    botId: z.string().min(1),
    persona: z.string(),
    skills: z.array(z.string()),
  })),
  plan: planSchema,
  idleReply: z.string().optional(),
  steps: z.array(stepSchema),
});

export const DEFAULT_IDLE_REPLY = 'Noted.';

const pathOf = (path: PropertyKey[]): string =>
  path.map(p => (typeof p === 'number' ? `[${p}]` : String(p))).reduce((a, p) => (p.startsWith('[') || !a ? a + p : `${a}.${p}`), '');

/** Values that occur more than once, in order of their second occurrence. */
function duplicates(values: string[]): string[] {
  const seen = new Set<string>();
  const dup: string[] = [];
  for (const v of values) {
    if (seen.has(v) && !dup.includes(v)) dup.push(v);
    seen.add(v);
  }
  return dup;
}

/** Checks a raw scenario; throws one Error listing every problem found. */
export function validateScenario(raw: unknown): Scenario {
  const parsed = scenarioSchema.safeParse(raw);
  if (!parsed.success) {
    const lines = parsed.error.issues.map(i => `${pathOf(i.path) || '(root)'}: ${i.message}`);
    throw new Error(`Invalid scenario:\n${lines.join('\n')}`);
  }
  const s = parsed.data as Scenario;
  const problems: string[] = [];
  const botIds = new Set(s.employees.map(e => e.botId));
  const toolNames = new Set(toolDefinitions('lead').map(d => d.name));

  if (!botIds.has(s.lead)) problems.push(`lead: "${s.lead}" is not an employee`);
  for (const id of duplicates(s.employees.map(e => e.botId))) problems.push(`employees: duplicate botId "${id}"`);

  /** Reports plan owners that are not employees and duplicate workstream ids. */
  const planProblems = (plan: PlanInput, report: (msg: string) => void) => {
    plan.workstreams.forEach((w, i) => {
      if (!botIds.has(w.owner)) report(`plan.workstreams[${i}].owner: "${w.owner}" is not an employee`);
    });
    for (const id of duplicates(plan.workstreams.map(w => w.id))) report(`plan.workstreams: duplicate workstream id "${id}"`);
  };
  planProblems(s.plan, msg => problems.push(msg));

  const ownerOf = (plan: PlanInput) => new Map(plan.workstreams.map(w => [w.id, w.owner]));
  let owners = ownerOf(s.plan);

  s.steps.forEach((step, i) => {
    const bad = (msg: string) => problems.push(`step ${i}: ${msg}`);
    switch (step.kind) {
      case 'human':
        for (const m of step.mentions ?? []) if (!botIds.has(m)) bad(`mention of "${m}", who is not an employee`);
        break;
      case 'work': {
        if (!botIds.has(step.botId)) bad(`botId "${step.botId}" is not an employee`);
        const owner = owners.get(step.workstreamId);
        if (owner === undefined) bad(`workstream "${step.workstreamId}" is not in the current plan`);
        else if (owner !== step.botId) bad(`bot "${step.botId}" does not own workstream "${step.workstreamId}" (owner: "${owner}")`);
        for (const op of step.ops ?? []) if (!toolNames.has(op.name)) bad(`unknown tool "${op.name}"`);
        break;
      }
      case 'review':
        if (!owners.has(step.deliverableOf)) bad(`deliverableOf "${step.deliverableOf}" is not a workstream in the current plan`);
        break;
      case 'replan':
        planProblems(step.plan, bad);
        owners = ownerOf(step.plan);
        break;
    }
  });

  if (problems.length > 0) throw new Error(`Invalid scenario "${s.id}":\n${problems.join('\n')}`);
  return { ...s, idleReply: s.idleReply ?? DEFAULT_IDLE_REPLY };
}

export function loadScenario(path: string): Scenario {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (e) {
    throw new Error(`Cannot read scenario ${path}: ${(e as Error).message}`);
  }
  return validateScenario(raw);
}
