import { BASE_TEMPLATE, type Policy, type RunContext, type Segment } from '../runner.js';
import { fmtBot, fmtHuman, fmtTask, fmtTool, deliverableIn } from '../text.js';
import type { Scenario, ToolCall } from '../types.js';

interface BotState {
  /**
   * Append-only own history: human messages that woke the bot, its task lines, its own scripted
   * replies and tool lines. Deliverables are NOT repeated here; they live on the workstream pages.
   */
  history: string[];
  /** Length of `history` at the previous request; with unchanged pages those lines are cacheable. */
  prevLen: number;
  /** Pages text of the previous request, or null before the first request. */
  prevPages: string | null;
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
 * template, all current pages (the project page, then one page per workstream that has a
 * deliverable, in plan order, holding that workstream's latest deliverable in full), the bot's own
 * history lines and, for scripted requests, the task line.
 *
 * Cacheable (R-B5 with the F exception): if the pages text is identical to the bot's previous
 * request, template + pages + the history lines of that previous request are cacheable; if any
 * page changed, only the template is (pages come before history, so a change invalidates the rest).
 *
 * Pages are driven by tool calls, applied after the request that produced them:
 * submitDeliverable replaces the workstream page; proposeDecision / recordFailure / promote and
 * the conventions of a review are appended to the project page. Human messages that only @mention
 * bots change no page.
 *
 * Wakes: a human message with mentions wakes the mentioned bots (extra requests, merge rule); one
 * without mentions wakes nobody; bots never wake each other. Idle replies are passes (R-B10): they
 * cost the request but are not added to the bot's history.
 */
export function spacePolicy(): Policy {
  const bots = new Map<string, BotState>();
  const projectEntries: string[] = [];
  const wsPages = new Map<string, string>();

  const stateOf = (botId: string): BotState => {
    let b = bots.get(botId);
    if (!b) {
      b = { history: [], prevLen: 0, prevPages: null };
      bots.set(botId, b);
    }
    return b;
  };

  const pageTexts = (s: Scenario): string[] => {
    const pages = [projectPage(s, projectEntries)];
    for (const w of s.plan.workstreams) {
      const content = wsPages.get(w.id);
      if (content !== undefined) pages.push(`[page workstream ${w.id}] ${content}`);
    }
    return pages;
  };

  const request = (ctx: RunContext, botId: string, step: number, kind: 'scripted' | 'extra', task: string | null) => {
    const b = stateOf(botId);
    if (task !== null) b.history.push(task);
    const pages = pageTexts(ctx.scenario);
    const joined = pages.join('\n');
    const unchanged = b.prevPages === joined;
    const segments: Segment[] = [
      { text: BASE_TEMPLATE, cacheable: true },
      ...pages.map(text => ({ text, cacheable: unchanged })),
      ...b.history.map((text, i) => ({ text, cacheable: unchanged && i < b.prevLen })),
    ];
    b.prevLen = b.history.length;
    b.prevPages = joined;
    return ctx.call({ botId, step, kind, segments });
  };

  const applyOps = (ops: ToolCall[]): void => {
    for (const op of ops) {
      const d = deliverableIn(op);
      if (d) wsPages.set(d.workstreamId, d.content);
      else if (op.name === 'proposeDecision') projectEntries.push(entryText('decision', op.args));
      else if (op.name === 'recordFailure') projectEntries.push(entryText('failure', op.args));
      else if (op.name === 'promote') projectEntries.push(entryText(promotedKind(op.args), op.args));
    }
  };

  // F has no compaction, call limit or core library calls, so its stats are always zero.
  return {
    group: 'F',
    async onStep(step, index, ctx) {
      if (step.kind === 'human') {
        const line = fmtHuman(ctx.scenario.owner, step.text);
        const mentioned = step.mentions ?? [];
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
