import { BASE_TEMPLATE, type Policy, type RunContext, type Segment } from '../runner.js';
import { fmtBot, fmtHuman, fmtTask, fmtTool, deliverableIn } from '../text.js';
import { prefixCacheable } from './history.js';
import type { Scenario, ToolCall } from '../types.js';

interface BotState {
  /**
   * Append-only own history: human messages that woke the bot, its task lines, its own scripted
   * replies and tool lines. Deliverables are NOT repeated here; they live on the workstream pages.
   */
  history: string[];
  /** Segment texts of the previous request, or null before the first request (R-B19). */
  prev: string[] | null;
}

/** The project page: goal, constraints, then conventions/decisions/failures in order of occurrence. */
function projectPage(s: Scenario, entries: string[]): string {
  const list = s.constraints.length > 0 ? s.constraints.join('; ') : 'none';
  return [`[page project] goal: ${s.goal} | constraints: ${list}`, ...entries].join('\n');
}

type Kind = 'decision' | 'failure' | 'fact';

const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);

/**
 * A project-page entry in the core's field layout (render.ts) without item ids, `kind` or
 * `sourceEntryIds`: a shared document has no item ids.
 */
function entryText(kind: Kind, args: unknown): string {
  const a = (typeof args === 'object' && args !== null ? args : {}) as Record<string, unknown>;
  const affects = strs(a.affects).join(', ');
  switch (kind) {
    case 'decision': {
      const rejected = strs(a.rejected);
      return [
        `decision: ${str(a.text)}`,
        `  why: ${str(a.rationale)}`,
        ...(rejected.length > 0 ? [`  rejected: ${rejected.join('; ')}`] : []),
        `  affects: ${affects}`,
      ].join('\n');
    }
    case 'failure':
      return [`tried: ${str(a.text)}`, `  why it failed: ${str(a.reason)}`, `  affects: ${affects}`].join('\n');
    case 'fact':
      return [str(a.text), ...(affects !== '' ? [`  affects: ${affects}`] : [])].join('\n');
  }
}

const promotedKind = (args: unknown): Kind => {
  const k = typeof args === 'object' && args !== null ? (args as Record<string, unknown>).kind : undefined;
  return k === 'decision' || k === 'failure' ? k : 'fact';
};

/**
 * Group F (Dots + Space style): people and bots share a set of document pages. A request is the
 * template, all current pages (the project page, then one page per workstream of the CURRENT plan
 * that has a deliverable, in plan order, holding that workstream's latest deliverable in full), the
 * bot's own history lines and, for scripted requests, the task line.
 *
 * Cacheable (R-B19, the rule every group uses): the leading run of segments identical to the bot's
 * previous request; on its first request only the template. Pages come before history, so a
 * changed page un-caches itself, every later page and the whole history.
 *
 * Pages are driven by tool calls, applied after the request that produced them:
 * submitDeliverable replaces the workstream page; proposeDecision / recordFailure / promote and
 * the conventions of a review are appended to the project page; proposePlan (a replan, R-B2 shape
 * `{ plan }`) replaces the plan, so pages of new workstreams can appear and pages of removed ones
 * are dropped (R-B20). A human message without mentions is appended to the project page (people
 * write in the shared pages, R-B20); one with mentions goes to the mentioned bots' histories.
 *
 * Wakes: a human message with mentions wakes the mentioned bots (extra requests, merge rule); one
 * without mentions wakes nobody; bots never wake each other. Idle replies are passes (R-B10): they
 * cost the request but are not added to the bot's history.
 */
export function spacePolicy(): Policy {
  const bots = new Map<string, BotState>();
  const projectEntries: string[] = [];
  const wsPages = new Map<string, string>();
  /** The current plan's workstream ids, in plan order; null until the first step reads the scenario's plan. */
  let planIds: string[] | null = null;

  const stateOf = (botId: string): BotState => {
    let b = bots.get(botId);
    if (!b) {
      b = { history: [], prev: null };
      bots.set(botId, b);
    }
    return b;
  };

  const pageTexts = (s: Scenario): string[] => {
    const pages = [projectPage(s, projectEntries)];
    for (const id of planIds ?? s.plan.workstreams.map(w => w.id)) {
      const content = wsPages.get(id);
      if (content !== undefined) pages.push(`[page workstream ${id}] ${content}`);
    }
    return pages;
  };

  const request = (ctx: RunContext, botId: string, step: number, kind: 'scripted' | 'extra', task: string | null) => {
    const b = stateOf(botId);
    if (task !== null) b.history.push(task);
    const texts = [BASE_TEMPLATE, ...pageTexts(ctx.scenario), ...b.history];
    const cacheable = prefixCacheable(b.prev, texts, 1);
    b.prev = texts;
    const segments: Segment[] = texts.map((text, i) => ({ text, cacheable: cacheable[i]! }));
    return ctx.call({ botId, step, kind, segments });
  };

  const applyOps = (ops: ToolCall[]): void => {
    for (const op of ops) {
      const d = deliverableIn(op);
      if (d) wsPages.set(d.workstreamId, d.content);
      else if (op.name === 'proposeDecision') projectEntries.push(entryText('decision', op.args));
      else if (op.name === 'recordFailure') projectEntries.push(entryText('failure', op.args));
      else if (op.name === 'promote') projectEntries.push(entryText(promotedKind(op.args), op.args));
      else if (op.name === 'proposePlan') replan(op.args);
    }
  };

  /** A replan replaces the plan; pages of workstreams it no longer has are dropped (R-B20). */
  const replan = (args: unknown): void => {
    const plan = typeof args === 'object' && args !== null ? (args as { plan?: unknown }).plan : undefined;
    const list = typeof plan === 'object' && plan !== null ? (plan as { workstreams?: unknown }).workstreams : undefined;
    if (!Array.isArray(list)) throw new Error(`group F: malformed proposePlan args: ${JSON.stringify(args)}`);
    planIds = list.map(w => (w as { id: string }).id);
    for (const id of [...wsPages.keys()]) if (!planIds.includes(id)) wsPages.delete(id);
  };

  // F has no compaction, call limit or core library calls, so its stats are always zero.
  return {
    group: 'F',
    async onStep(step, index, ctx) {
      if (step.kind === 'human') {
        const line = fmtHuman(ctx.scenario.owner, step.text);
        const mentioned = step.mentions ?? [];
        // Unaddressed: written into the shared project page; it wakes nobody (R-B20).
        if (mentioned.length === 0) projectEntries.push(line);
        for (const e of ctx.scenario.employees) {
          if (!mentioned.includes(e.botId)) continue;
          stateOf(e.botId).history.push(line);
          if (ctx.isMerged(e.botId, index)) continue;
          await request(ctx, e.botId, index, 'extra', null); // idle reply = pass (R-B10)
        }
        return;
      }
      const actor = ctx.actorOf(step);
      const out = await request(ctx, actor, index, 'scripted', fmtTask(actor, step));
      const b = stateOf(actor);
      b.history.push(fmtBot(actor, out.reply), ...out.ops.map(op => fmtTool(actor, op.name)));
      applyOps(out.ops);
      if (step.kind === 'review') {
        for (const c of step.conventions ?? []) projectEntries.push(`convention: ${c}`);
      }
    },
    async finish() {
      return { compactions: 0, pauses: 0, coreErrors: 0 };
    },
  };
}
