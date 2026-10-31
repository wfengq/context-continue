import {
  createEmployeeRegistry,
  createProject,
  memoryStore,
  type Clock,
  type ContextBundle,
  type Project,
  type Wake,
} from '@context-continue/core';
import type { Policy, RunContext } from '../runner.js';
import { fmtTask } from '../text.js';
import type { Step, ToolCall } from '../types.js';

/** Briefs are never trimmed: the bench measures the full brief the core assembles. */
const MAX_BRIEF_TOKENS = 1_000_000;

/**
 * A deterministic clock: time advances by 1 ms per reading from a fixed epoch, and timers never fire
 * (the lead timeout is a wall-clock escalation to a human, outside what the bench measures).
 */
function benchClock(): Clock {
  let t = Date.UTC(2026, 0, 1);
  return { now: () => ++t, setTimeout: () => null, clearTimeout: () => undefined };
}

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

const wakesIn = (result: unknown): Wake[] => {
  if (typeof result !== 'object' || result === null) return [];
  const w = (result as { wakes?: unknown }).wakes;
  return Array.isArray(w) ? (w as Wake[]) : [];
};

const proposalIdIn = (result: unknown): string | null => {
  if (typeof result !== 'object' || result === null) return null;
  const id = (result as { proposalId?: unknown }).proposalId;
  return typeof id === 'string' ? id : null;
};

/** One request per woken bot, in first-seen order; its reasons and details are combined. */
function byBot(wakes: Wake[]): { botId: string; reason: Wake['reason']; detail: string }[] {
  const acc = new Map<string, { botId: string; reason: Wake['reason']; details: string[] }>();
  for (const w of wakes) {
    let got = acc.get(w.botId);
    if (!got) acc.set(w.botId, (got = { botId: w.botId, reason: w.reason, details: [] }));
    const d = w.detail ? `${w.reason}: ${w.detail}` : w.reason;
    if (!got.details.includes(d)) got.details.push(d);
  }
  return [...acc.values()].map(g => ({ botId: g.botId, reason: g.reason, detail: g.details.join('; ') }));
}

/**
 * Group C (this project): drives the real core library. The scenario's employees and plan set up a
 * project (start → proposePlan → approvePlan); scripted steps map onto the facade and `callTool`.
 * Who is woken is decided by the core alone (returned wakes and `wake` events, counted once per bot
 * per step); each request is exactly the seven `buildBrief` segments, with the core's cacheable flags.
 * The core's optional models are not given, so it uses its fallback behaviour and makes no model calls.
 * A core error (a throw from `callTool` or `approvePlan`) is counted and shown to that bot as
 * `tool error: <message>` in the trigger of its next request; the run continues.
 */
export function projectPolicy(): Policy & { readonly project: Project | null } {
  let project: Project | null = null;
  let coreErrors = 0;
  /** Wakes caught since the last time they were turned into requests. */
  let woken: Wake[] = [];
  /** Core errors per bot, not yet shown to it. */
  const toolErrors = new Map<string, string[]>();

  const withErrors = (botId: string, detail: string): string => {
    const errs = toolErrors.get(botId) ?? [];
    toolErrors.delete(botId);
    return [detail, ...errs.map(m => `tool error: ${m}`)].join('; ');
  };

  const brief = (p: Project, botId: string, reason: Wake['reason'] | 'manual', detail: string): Promise<ContextBundle> =>
    p.buildBrief(botId, { maxTokens: MAX_BRIEF_TOKENS, trigger: { reason, detail: withErrors(botId, detail) } });

  async function send(ctx: RunContext, botId: string, step: number, kind: 'scripted' | 'extra', b: ContextBundle) {
    return ctx.call({ botId, step, kind, segments: b.segments.map(s => ({ text: s.text, cacheable: s.cacheable, kind: s.kind })) });
  }

  /**
   * Extra requests for the wakes caught so far. `mergeStep` is the step the wake happened at for the
   * merge rule (-1 for setup: merged when the bot performs step 0); `step` is where it is recorded.
   */
  async function wakeRequests(p: Project, ctx: RunContext, step: number, mergeStep: number) {
    const batch = byBot(woken);
    woken = [];
    for (const w of batch) {
      if (ctx.isMerged(w.botId, mergeStep)) continue;
      await send(ctx, w.botId, step, 'extra', await brief(p, w.botId, w.reason, w.detail));
    }
  }

  /** Runs one tool call as `botId`; a core error is counted and kept for that bot's next request. */
  async function runTool(p: Project, ctx: RunContext, botId: string, op: ToolCall) {
    try {
      const result = await p.callTool(botId, op.name, op.args);
      woken.push(...wakesIn(result));
      const proposalId = op.name === 'proposePlan' ? proposalIdIn(result) : null;
      if (proposalId !== null) woken.push(...(await p.approvePlan(proposalId, { by: ctx.scenario.owner })));
    } catch (e) {
      coreErrors++;
      toolErrors.set(botId, [...(toolErrors.get(botId) ?? []), errText(e)]);
    }
  }

  async function setup(ctx: RunContext): Promise<Project> {
    const s = ctx.scenario;
    const store = memoryStore();
    const employees = createEmployeeRegistry({ store });
    for (const e of s.employees) await employees.upsert({ botId: e.botId, persona: e.persona, skills: [...e.skills] });
    const p = createProject({ projectId: s.id, store, employees, clock: benchClock() });
    p.on('wake', e => void woken.push(...e.wakes));
    woken.push(...(await p.start({ goal: s.goal, constraints: [...s.constraints], lead: s.lead, by: s.owner })));
    await wakeRequests(p, ctx, 0, -1);
    await runTool(p, ctx, s.lead, { name: 'proposePlan', args: s.plan });
    await wakeRequests(p, ctx, 0, -1);
    return p;
  }

  /**
   * The core arguments of a scripted review/replan op (R-B2 gives them in the scenario's terms): the
   * core's `proposePlan` takes the plan itself, and a review names the latest deliverable of `deliverableOf`.
   */
  async function coreOp(p: Project, op: ToolCall): Promise<ToolCall> {
    if (typeof op.args !== 'object' || op.args === null) return op;
    if (op.name === 'proposePlan' && 'plan' in op.args) return { name: op.name, args: (op.args as { plan: unknown }).plan };
    if (op.name !== 'submitReview') return op;
    const { deliverableOf, ...rest } = op.args as { deliverableOf?: unknown };
    if (typeof deliverableOf !== 'string') return op;
    const w = (await p.board()).workstreams.find(x => x.id === deliverableOf);
    const latest = w?.deliverables.reduce<(typeof w.deliverables)[number] | undefined>(
      (a, d) => (a === undefined || d.version > a.version ? d : a),
      undefined,
    );
    // Without a deliverable the core rejects the review, which counts as a core error.
    return { name: op.name, args: { ...rest, deliverableId: latest?.id } };
  }

  return {
    group: 'C',
    get project() {
      return project;
    },
    async onStep(step: Step, index: number, ctx: RunContext) {
      project ??= await setup(ctx);
      const p = project;
      if (step.kind === 'human') {
        const entry = await p.ingest({
          author: { kind: 'human', id: ctx.scenario.owner },
          text: step.text,
          ...(step.mentions && { mentions: [...step.mentions] }),
        });
        woken.push(...(await p.route(entry)));
      } else {
        const botId = ctx.actorOf(step);
        const out = await send(ctx, botId, index, 'scripted', await brief(p, botId, 'manual', fmtTask(botId, step)));
        for (const op of out.ops) await runTool(p, ctx, botId, await coreOp(p, op));
      }
      await wakeRequests(p, ctx, index, index);
    },
    async finish() {
      const unfinished = project ? (await project.board()).workstreams.some(w => w.status !== 'delivered') : false;
      project?.dispose();
      return { compactions: 0, pauses: 0, coreErrors, unfinished };
    },
  };
}
