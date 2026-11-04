import {
  createEmployeeRegistry,
  createProject,
  memoryStore,
  type Clock,
  type ContextBundle,
  type LedgerEntry,
  type Project,
  type PublicBoardSwitches,
  type Wake,
} from '@context-continue/core';
import type { Policy, RunContext } from '../runner.js';
import { fmtBot, fmtHuman, fmtTask } from '../text.js';
import { prefixCacheable } from './history.js';
import { briefStream } from './stream.js';
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

/** A seeded id generator: `<prefix>-<n as 8 hex digits>`, counting from 1 per project (R-B23). */
function benchIds(): (prefix: string) => string {
  let n = 0;
  return prefix => `${prefix}-${(++n).toString(16).padStart(8, '0')}`;
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

/**
 * A compact rendering of a successful tool result for the bot's next trigger (R-B21):
 * `tool <name>: ok <result as JSON>`. Wakes are left out (the core delivers them as wakes); a result
 * that is only wakes renders as `tool <name>: ok`. Lookup tools (getBoardItem, searchLedger,
 * getDeliverable) return content, which is included in full.
 */
export function resultLine(name: string, result: unknown): string {
  let shown = result;
  if (typeof result === 'object' && result !== null && !Array.isArray(result) && 'wakes' in result) {
    const { wakes: _wakes, ...rest } = result as Record<string, unknown>;
    shown = Object.keys(rest).length > 0 ? rest : undefined;
  }
  if (shown === undefined || shown === null) return `tool ${name}: ok`;
  return `tool ${name}: ok ${typeof shown === 'string' ? shown : JSON.stringify(shown)}`;
}

/**
 * Routed wakes carry the message that was routed. The core's wake detail only says why the bot was
 * woken, and the brief's delta shows a chat message only to bots it mentions, replies to or whose
 * workstream it matches — so a message routed to the lead (no match, no routing model) would
 * otherwise never reach it. As the host that called `route(entry)`, the bench delivers the message
 * in the trigger, in the history groups' line format.
 */
function withMessage(wakes: Wake[], line: string): Wake[] {
  return wakes.map(w => (w.reason === 'routed' ? { ...w, detail: `${w.detail} ${line}` } : w));
}

const sameWake = (a: Wake, b: Wake): boolean => a.botId === b.botId && a.reason === b.reason && a.detail === b.detail;

/**
 * R-L13: the core both emits a `wake` event and returns the same wakes. The event's copy is already
 * in `caught` when the call returns; drop it, so only the returned copy (which the host may enrich,
 * e.g. with the routed message) remains.
 */
function withoutEcho(caught: Wake[], returned: Wake[]): Wake[] {
  return caught.filter(w => !returned.some(r => sameWake(w, r)));
}

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

/** The id of the latest version among a workstream's deliverables, if it has any. */
async function latestDeliverableId(p: Project, workstreamId: string): Promise<string | undefined> {
  const w = (await p.board()).workstreams.find(x => x.id === workstreamId);
  const latest = w?.deliverables.reduce<(typeof w.deliverables)[number] | undefined>(
    (a, d) => (a === undefined || d.version > a.version ? d : a),
    undefined,
  );
  return latest?.id;
}

/**
 * Group C (this project): drives the real core library. The scenario's employees and plan set up a
 * project (start → proposePlan → approvePlan); scripted steps map onto the facade and `callTool`.
 * Who is woken is decided by the core alone (returned wakes and `wake` events, counted once per bot
 * per step; a returned wake's echo in the event is dropped, R-L13). A request is the seven `buildBrief`
 * segments, except the lead's scripted review and replan steps, which use the contexts the core builds
 * for them: `buildReviewContext(latest deliverable of deliverableOf)` and `buildPlanningContext()`
 * (common, memory, workspace, board, projection), with the trigger (task line, merged wakes, pending tool
 * results) passed to the core, which appends its trigger segment, so nothing waits for a later brief.
 * Cacheable per R-B19 (see `send`).
 * The core's optional models are not given, so it uses its fallback behaviour and makes no model calls.
 * Every tool result is shown to that bot in the trigger of its next request (R-B21): a success as
 * `tool <name>: ok <result>` (see `resultLine`), a core error (a throw from `callTool` or
 * `approvePlan`) as `tool error: <message>`, also counted; the run continues.
 *
 * With `stream` (`--c-stream on`, a prototype) the core is driven exactly the same, but the text
 * sent is each bot's append-only stream (`briefStream`) built from the core's segments, the board
 * and the human messages in the ledger; every stream segment is flagged cacheable, so R-B19 alone
 * decides, and no core-flagged upper bound is reported.
 */
export function projectPolicy(
  opts: { publicBoard?: PublicBoardSwitches; stream?: { restreamTokens: number } } = {},
): Policy & { readonly project: Project | null } {
  let project: Project | null = null;
  /** Stream mode: the per-bot streams, the run's store, and the human chat entries read from it so far. */
  let streams: ReturnType<typeof briefStream> | null = null;
  let ledger: { store: ReturnType<typeof memoryStore>; projectId: string } | null = null;
  const humans: LedgerEntry[] = [];
  let nextSeq = 1;
  let coreErrors = 0;
  /** Wakes caught since the last time they were turned into requests. */
  let woken: Wake[] = [];
  /** Segment texts of each bot's previous brief (R-B19). */
  const prevTexts = new Map<string, string[]>();
  /** Tokens the core flags cacheable, summed over all briefs: the report's upper bound. */
  let flaggedCacheable = 0;
  /** Details of wakes merged into each bot's next scripted step (merge rule), not yet shown to it. */
  const mergedWakes = new Map<string, string[]>();
  /** Tool results per bot (successes and core errors), not yet shown to it (R-B21). */
  const toolResults = new Map<string, string[]>();

  const keepResult = (botId: string, line: string) => toolResults.set(botId, [...(toolResults.get(botId) ?? []), line]);

  const withResults = (botId: string, detail: string): string => {
    const lines = toolResults.get(botId) ?? [];
    toolResults.delete(botId);
    return [detail, ...lines].join('; ');
  };

  /** The trigger of a scripted step: the task line, merged wakes and pending tool results. */
  const manual = (botId: string, detail: string) => ({ reason: 'manual' as const, detail: withResults(botId, detail) });

  const brief = (p: Project, botId: string, reason: Wake['reason'] | 'manual', detail: string): Promise<ContextBundle> =>
    p.buildBrief(botId, { maxTokens: MAX_BRIEF_TOKENS, trigger: { reason, detail: withResults(botId, detail) } });

  /**
   * The request of a scripted step: the core's review context for a review of an existing
   * deliverable, its planning context for a replan, otherwise the brief. A review of a workstream
   * without a deliverable gets the brief; its submitReview then fails as a core error.
   */
  async function stepRequest(p: Project, botId: string, step: Step, detail: string): Promise<{ b: ContextBundle; shape: 'brief' | 'context' }> {
    if (step.kind === 'review') {
      const id = await latestDeliverableId(p, step.deliverableOf);
      if (id !== undefined) return { b: await p.buildReviewContext(id, { trigger: manual(botId, detail) }), shape: 'context' };
    }
    if (step.kind === 'replan') return { b: await p.buildPlanningContext({ trigger: manual(botId, detail) }), shape: 'context' };
    return { b: await brief(p, botId, 'manual', detail), shape: 'brief' };
  }

  /** Stream mode: the request's segments, from the bot's stream (R-B19 prefix rule applied in `send`). */
  async function streamed(ctx: RunContext, botId: string, b: ContextBundle, shape: 'brief' | 'context') {
    streams ??= briefStream({ restreamTokens: opts.stream!.restreamTokens, count: ctx.count });
    const { store, projectId } = ledger!;
    for (const e of await store.read(projectId, nextSeq)) {
      nextSeq = e.seq + 1;
      if (e.author.kind === 'human' && e.body.type === 'chat') humans.push(e);
    }
    const board = await project!.board();
    // A snapshot on a review or planning request takes the bot's projection from a peek brief (no side effects).
    const projection =
      shape === 'context' && streams.needsSnapshot(botId)
        ? (await project!.buildBrief(botId, { maxTokens: MAX_BRIEF_TOKENS, peek: true })).segments.find(x => x.kind === 'projection')?.text
        : undefined;
    return streams.request(botId, { core: b.segments, shape, board, humans, ...(projection === undefined ? {} : { projection }) }).segments;
  }

  /**
   * Sends a brief. Cacheable (R-B19, the rule every group uses): a segment counts only if the core
   * flags it cacheable AND it lies in the leading run of segments identical to this bot's previous
   * brief; on a bot's first brief only the common segment (the analogue of the shared template).
   * The core-flagged total is kept as an upper bound for the report.
   */
  async function send(ctx: RunContext, botId: string, step: number, kind: 'scripted' | 'extra', b: ContextBundle, shape: 'brief' | 'context' = 'brief') {
    const segments: { text: string; cacheable: boolean; kind: string }[] = opts.stream ? await streamed(ctx, botId, b, shape) : b.segments;
    const texts = segments.map(s => s.text);
    const inPrefix = prefixCacheable(prevTexts.get(botId) ?? null, texts, 1);
    prevTexts.set(botId, texts);
    for (const s of segments) if (s.cacheable) flaggedCacheable += ctx.count(s.text);
    return ctx.call({
      botId,
      step,
      kind,
      segments: segments.map((s, i) => ({ text: s.text, cacheable: s.cacheable && inPrefix[i]!, kind: s.kind })),
    });
  }

  /**
   * Extra requests for the wakes caught so far. `mergeStep` is the step the wake happened at for the
   * merge rule (-1 for setup: merged when the bot performs step 0); `step` is where it is recorded.
   */
  async function wakeRequests(p: Project, ctx: RunContext, step: number, mergeStep: number) {
    const batch = byBot(woken);
    woken = [];
    for (const w of batch) {
      if (ctx.isMerged(w.botId, mergeStep)) {
        // Merge rule: the wake is the trigger of the bot's own next step; keep what it says for that brief.
        mergedWakes.set(w.botId, [...(mergedWakes.get(w.botId) ?? []), w.detail]);
        continue;
      }
      await send(ctx, w.botId, step, 'extra', await brief(p, w.botId, w.reason, w.detail));
    }
  }

  /**
   * Runs one tool call as `botId`; its result (or the core error, which is also counted) is kept for
   * that bot's next request.
   */
  async function runTool(p: Project, ctx: RunContext, botId: string, op: ToolCall) {
    try {
      const result = await p.callTool(botId, op.name, op.args);
      keepResult(botId, resultLine(op.name, result));
      const text = op.name === 'sendMessage' ? (op.args as { text?: unknown }).text : undefined;
      const returned = wakesIn(result);
      woken = withoutEcho(woken, returned);
      woken.push(...(typeof text === 'string' ? withMessage(returned, fmtBot(botId, text)) : returned));
      const proposalId = op.name === 'proposePlan' ? proposalIdIn(result) : null;
      if (proposalId !== null) woken.push(...(await p.approvePlan(proposalId, { by: ctx.scenario.owner })));
    } catch (e) {
      coreErrors++;
      keepResult(botId, `tool error: ${errText(e)}`);
    }
  }

  async function setup(ctx: RunContext): Promise<Project> {
    const s = ctx.scenario;
    const newId = benchIds();
    const store = memoryStore({ newId });
    ledger = { store, projectId: s.id };
    const employees = createEmployeeRegistry({ store });
    for (const e of s.employees) await employees.upsert({ botId: e.botId, persona: e.persona, skills: [...e.skills] });
    const p = createProject({ projectId: s.id, store, employees, clock: benchClock(), newId, ...(opts.publicBoard === undefined ? {} : { publicBoard: opts.publicBoard }) });
    project = p; // stream mode reads the board for setup requests too
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
    // Without a deliverable the core rejects the review, which counts as a core error.
    return { name: op.name, args: { ...rest, deliverableId: await latestDeliverableId(p, deliverableOf) } };
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
        const routed = await p.route(entry);
        woken = withoutEcho(woken, routed);
        woken.push(...withMessage(routed, fmtHuman(ctx.scenario.owner, step.text)));
      } else {
        const botId = ctx.actorOf(step);
        const merged = mergedWakes.get(botId) ?? [];
        mergedWakes.delete(botId);
        const detail = [fmtTask(botId, step), ...merged].join('; ');
        const { b, shape } = await stepRequest(p, botId, step, detail);
        const out = await send(ctx, botId, index, 'scripted', b, shape);
        for (const op of out.ops) await runTool(p, ctx, botId, await coreOp(p, op));
      }
      await wakeRequests(p, ctx, index, index);
    },
    async finish() {
      const unfinished = project ? (await project.board()).workstreams.some(w => w.status !== 'delivered') : false;
      project?.dispose();
      // Stream mode flags every segment cacheable, so the core-flagged upper bound means nothing there.
      return { compactions: 0, pauses: 0, coreErrors, unfinished, ...(opts.stream ? {} : { cacheableUpperBound: flaggedCacheable }) };
    },
  };
}
