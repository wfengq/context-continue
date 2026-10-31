import { readFileSync } from 'node:fs';
import { toolDefinitions, type PlanInput } from '@context-continue/core';
import { z } from 'zod';
import { isDeliverableArgs } from './text.js';
import type { Scenario, Step } from './types.js';

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
  tier: z.enum(['standard', 'long']).optional(),
  idleReply: z.string().optional(),
  facts: z.array(z.object({
    id: z.string().min(1),
    marker: z.string().min(1),
    step: z.number().int(),
    audience: z.array(z.string().min(1)).min(1),
  })).optional(),
  steps: z.array(stepSchema),
});

/** All text a step puts into the conversation, joined by newlines (used to locate fact markers). */
export function stepText(step: Step): string {
  switch (step.kind) {
    case 'human':
      return step.text;
    case 'work':
      return [step.reply, ...(step.ops ?? []).map(op => JSON.stringify(op.args))].join('\n');
    case 'review':
      return [step.notes, ...(step.conventions ?? [])].join('\n');
    case 'replan':
      return JSON.stringify(step.plan);
  }
}

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
        for (const op of step.ops ?? []) {
          if (!toolNames.has(op.name)) bad(`unknown tool "${op.name}"`);
          else if (op.name === 'submitDeliverable' && !isDeliverableArgs(op.args))
            bad('submitDeliverable args must be { workstreamId: string, summary: string, content: string }');
        }
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

  for (const id of duplicates((s.facts ?? []).map(f => f.id))) problems.push(`facts: duplicate fact id "${id}"`);
  for (const f of s.facts ?? []) {
    const bad = (msg: string) => problems.push(`fact ${f.id}: ${msg}`);
    const step = Number.isInteger(f.step) ? s.steps[f.step] : undefined;
    if (step === undefined) bad(`step ${f.step} does not exist (scenario has ${s.steps.length} steps)`);
    else if (!stepText(step).includes(f.marker)) bad(`step ${f.step} text does not contain marker "${f.marker}"`);
    for (const a of f.audience) if (a !== '*' && !botIds.has(a)) bad(`audience "${a}" is not an employee or "*"`);
  }

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

/** Words that mark a human message as a change of goal or constraints. */
const CHANGE_MARKERS = /\b(chang(e|ed|es|ing)|instead|no longer|drop|switch(ed)?)\b/i;

const hasQuery = (st: Step): boolean =>
  st.kind === 'work' &&
  (st.ops ?? []).some(
    op => op.name === 'sendMessage' && typeof op.args === 'object' && op.args !== null && (op.args as { act?: unknown }).act === 'query',
  );

/** Counts human messages that change the requirements: after the first work step, with change words, and a later replan. */
function countRequirementChanges(s: Scenario): number {
  const firstWork = s.steps.findIndex(st => st.kind === 'work');
  return s.steps.filter(
    (st, i) =>
      st.kind === 'human' &&
      firstWork >= 0 &&
      i > firstWork &&
      CHANGE_MARKERS.test(st.text) &&
      s.steps.slice(i + 1).some(next => next.kind === 'replan'),
  ).length;
}

const FACT_CATEGORIES = ['change-', 'conv-', 'contract-', 'fail-'];

/**
 * The coverage items a formal scenario must include (spec §3, §5), in a fixed order; returns the ones
 * missing (empty when the scenario qualifies):
 * - human requirement change; failed review; review with conventions; replan; bot-to-bot query;
 * - long tier: 150–300 steps, at least 15 facts, and minimum counts of replans (3), requirement
 *   changes (4), failed reviews (6), new conventions (8) and queries (10);
 * - standard tier: 20–40 steps, 4–6 facts — checked only when the scenario has a `facts` field (R-L1);
 * - facts (when required): one per category, by id prefix change-, conv-, contract-, fail-.
 */
export function checkCoverage(s: Scenario): string[] {
  const long = s.tier === 'long';
  const missing: string[] = [];
  if (countRequirementChanges(s) === 0) missing.push('human requirement change');
  if (!s.steps.some(st => st.kind === 'review' && !st.passed)) missing.push('failed review');
  if (!s.steps.some(st => st.kind === 'review' && (st.conventions ?? []).length > 0)) missing.push('review with conventions');
  if (!s.steps.some(st => st.kind === 'replan')) missing.push('replan');
  if (!s.steps.some(hasQuery)) missing.push('bot-to-bot query');

  const factsRequired = long || s.facts !== undefined;
  if (!factsRequired) return missing;
  const facts = s.facts ?? [];

  const n = s.steps.length;
  if (long) {
    if (n < 150 || n > 300) missing.push('long scenario needs 150–300 steps');
    if (facts.length < 15) missing.push('long scenario needs at least 15 facts');
  } else {
    if (n < 20 || n > 40) missing.push('standard scenario needs 20–40 steps');
    if (facts.length < 4 || facts.length > 6) missing.push('standard scenario needs 4–6 facts');
  }
  for (const prefix of FACT_CATEGORIES) if (!facts.some(f => f.id.startsWith(prefix))) missing.push(`fact category ${prefix}`);

  if (long) {
    const count = (pred: (st: Step) => boolean) => s.steps.filter(pred).length;
    if (count(st => st.kind === 'replan') < 3) missing.push('long scenario needs at least 3 replans');
    if (countRequirementChanges(s) < 4) missing.push('long scenario needs at least 4 requirement changes');
    if (count(st => st.kind === 'review' && !st.passed) < 6) missing.push('long scenario needs at least 6 failed reviews');
    const conventions = s.steps.reduce((sum, st) => sum + (st.kind === 'review' ? (st.conventions ?? []).length : 0), 0);
    if (conventions < 8) missing.push('long scenario needs at least 8 new conventions');
    if (count(hasQuery) < 10) missing.push('long scenario needs at least 10 bot-to-bot queries');
  }
  return missing;
}
