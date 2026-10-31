// Shared parts of the long-scenario generators (spec §3): a step builder that tracks the current
// plan and every workstream's deliverable text, small op constructors with the core's tool argument
// shapes (packages/core/src/tools.ts), and a deterministic rotation picker. No randomness, no clock:
// the same code always produces the same scenario.
import type { PlanInput } from '@context-continue/core';
import { checkCoverage, stepText, validateScenario } from '../scenario.js';
import type { Fact, Scenario, Step, ToolCall } from '../types.js';

/** The i-th element of `xs`, wrapping around: a deterministic stand-in for a random choice. */
export function rotate<T>(xs: readonly T[], i: number): T {
  if (xs.length === 0) throw new Error('rotate: empty list');
  return xs[((i % xs.length) + xs.length) % xs.length]!;
}

// ---------------------------------------------------------------------------
// op constructors (core tool names and argument shapes)
// ---------------------------------------------------------------------------

export const op = {
  notes: (text: string, pinned?: boolean): ToolCall => ({ name: 'updateNotes', args: pinned === undefined ? { text } : { text, pinned } }),
  board: (id: string): ToolCall => ({ name: 'getBoardItem', args: { id } }),
  search: (query: string): ToolCall => ({ name: 'searchLedger', args: { query } }),
  message: (text: string, act: 'request' | 'query' | 'propose' | 'inform' | 'agree' | 'refuse' | 'done', mentions?: string[]): ToolCall => ({
    name: 'sendMessage',
    args: mentions && mentions.length > 0 ? { text, act, mentions } : { text, act },
  }),
  decide: (text: string, rationale: string, rejected: string[], affects: string[]): ToolCall => ({
    name: 'proposeDecision',
    args: rejected.length > 0 ? { text, rationale, rejected, affects } : { text, rationale, affects },
  }),
  failure: (text: string, reason: string, affects: string[]): ToolCall => ({ name: 'recordFailure', args: { text, reason, affects } }),
};

/** Lengths the spec allows for a long scenario's deliverables (spec §3). */
export const DELIVERABLE_MIN = 300;
export const DELIVERABLE_MAX = 3000;

interface Doc {
  title: string;
  /** Paragraphs so far; every new version appends at least one. */
  paragraphs: string[];
  version: number;
}

export interface Head {
  id: string;
  goal: string;
  constraints: string[];
  owner: string;
  lead: string;
  employees: Scenario['employees'];
  plan: PlanInput;
  idleReply?: string;
}

/**
 * Builds a long scenario step by step and fails fast (throws) on anything the core or the
 * scenario rules would reject: a bot working on a workstream it does not own or that is not in the
 * current plan, a review without a deliverable, a plan with unknown dependencies or contract ends,
 * a lookup of a board item that does not exist, a deliverable outside 300–3000 characters, or a
 * fact whose marker is not in its step's text.
 */
export class LongScenarioBuilder {
  private readonly steps: Step[] = [];
  private readonly facts: Fact[] = [];
  private plan: PlanInput;
  private readonly docs = new Map<string, Doc>();

  constructor(private readonly head: Head) {
    checkPlan(head.plan, new Set(head.employees.map(e => e.botId)));
    this.plan = head.plan;
  }

  /** Number of steps so far (the index the next step gets). */
  get length(): number {
    return this.steps.length;
  }

  /** Current version of a workstream's deliverable (0 before the first submission). */
  version(ws: string): number {
    return this.docs.get(ws)?.version ?? 0;
  }

  human(text: string, mentions?: string[]): this {
    this.steps.push(mentions && mentions.length > 0 ? { kind: 'human', text, mentions } : { kind: 'human', text });
    return this;
  }

  work(botId: string, ws: string, reply: string, ops: ToolCall[] = []): this {
    const w = this.plan.workstreams.find(x => x.id === ws);
    if (!w) throw new Error(`step ${this.length}: workstream "${ws}" is not in the current plan`);
    if (w.owner !== botId) throw new Error(`step ${this.length}: "${botId}" does not own "${ws}"`);
    for (const o of ops) {
      if (o.name === 'getBoardItem') {
        const id = (o.args as { id: string }).id;
        const known = this.plan.workstreams.some(x => x.id === id) || this.plan.contracts.some(c => c.id === id);
        if (!known) throw new Error(`step ${this.length}: board item "${id}" is not in the current plan`);
      }
      if (o.name === 'proposeDecision') {
        const affects = (o.args as { affects: string[] }).affects;
        // A decision reaching beyond the author's own workstreams would wait for the lead.
        for (const a of affects) {
          if (this.plan.workstreams.find(x => x.id === a)?.owner !== botId) throw new Error(`step ${this.length}: decision affects "${a}", not owned by ${botId}`);
        }
      }
    }
    const step: Step = ops.length > 0 ? { kind: 'work', botId, workstreamId: ws, reply, ops } : { kind: 'work', botId, workstreamId: ws, reply };
    this.steps.push(step);
    return this;
  }

  /**
   * Submits the next version of `ws`: its content is the title line plus every paragraph so far and
   * the new ones in `add`, so each version extends the previous one. `before` ops run first.
   */
  deliver(botId: string, ws: string, a: { reply: string; summary: string; add: string[]; before?: ToolCall[] }): this {
    const w = this.plan.workstreams.find(x => x.id === ws);
    if (!w) throw new Error(`step ${this.length}: workstream "${ws}" is not in the current plan`);
    if (a.add.length === 0) throw new Error(`step ${this.length}: a new version of "${ws}" must add something`);
    const doc = this.docs.get(ws) ?? { title: w.title, paragraphs: [], version: 0 };
    doc.paragraphs = [...doc.paragraphs, ...a.add];
    doc.version += 1;
    this.docs.set(ws, doc);
    const content = [`${doc.title}, version ${doc.version}.`, ...doc.paragraphs].join('\n\n');
    if (content.length < DELIVERABLE_MIN || content.length > DELIVERABLE_MAX) {
      throw new Error(`step ${this.length}: deliverable ${ws} v${doc.version} has ${content.length} characters (allowed ${DELIVERABLE_MIN}–${DELIVERABLE_MAX})`);
    }
    return this.work(botId, ws, a.reply, [
      ...(a.before ?? []),
      { name: 'submitDeliverable', args: { workstreamId: ws, summary: a.summary, content } },
    ]);
  }

  review(ws: string, passed: boolean, notes: string, conventions?: string[]): this {
    if (!this.plan.workstreams.some(x => x.id === ws)) throw new Error(`step ${this.length}: review of "${ws}", not in the current plan`);
    if (this.version(ws) === 0) throw new Error(`step ${this.length}: review of "${ws}" before any deliverable`);
    this.steps.push(
      conventions && conventions.length > 0 ? { kind: 'review', deliverableOf: ws, passed, notes, conventions } : { kind: 'review', deliverableOf: ws, passed, notes },
    );
    return this;
  }

  replan(plan: PlanInput): this {
    checkPlan(plan, new Set(this.head.employees.map(e => e.botId)));
    for (const w of plan.workstreams) {
      const old = this.plan.workstreams.find(x => x.id === w.id);
      if (old && (old.owner !== w.owner || old.title !== w.title)) throw new Error(`step ${this.length}: replan changes the owner or title of "${w.id}"`);
    }
    this.plan = plan;
    this.steps.push({ kind: 'replan', plan });
    return this;
  }

  /** The current plan (a replan usually starts from it). */
  get currentPlan(): PlanInput {
    return this.plan;
  }

  /**
   * A bot-to-bot question: `asker` (working on `ws`) posts a query that @-mentions `asked`; the
   * reply says what the bot is doing and repeats the @-mention.
   */
  ask(asker: string, ws: string, asked: string, a: { reply: string; question: string; ops?: ToolCall[] }): this {
    return this.work(asker, ws, `${a.reply} @${asked} ${a.question}`, [...(a.ops ?? []), op.message(`@${asked} ${a.question}`, 'query', [asked])]);
  }

  /**
   * The answer to a question: `bot` (working on `ws`) informs `asker`, and also addresses `also`
   * (bots the text @-mentions besides the asker).
   */
  answer(bot: string, ws: string, asker: string, text: string, ops: ToolCall[] = [], also: string[] = []): this {
    for (const m of also) if (!text.includes(`@${m}`)) throw new Error(`step ${this.length}: answer addresses ${m} without @${m} in the text`);
    return this.work(bot, ws, `@${asker} ${text}`, [op.message(text, 'inform', [asker, ...also]), ...ops]);
  }

  /** Annotates the last step as introducing a fact; its marker must be in that step's text. */
  fact(id: string, marker: string, audience: string[]): this {
    const step = this.length - 1;
    const last = this.steps[step];
    if (!last || !stepText(last).includes(marker)) throw new Error(`fact ${id}: marker "${marker}" is not in step ${step}`);
    this.facts.push({ id, marker, step, audience });
    return this;
  }

  /** The finished scenario; throws when it does not validate or misses a coverage item. */
  build(): Scenario {
    const { idleReply, ...head } = this.head;
    const raw = {
      id: head.id,
      tier: 'long' as const,
      goal: head.goal,
      constraints: head.constraints,
      owner: head.owner,
      lead: head.lead,
      employees: head.employees,
      plan: head.plan,
      ...(idleReply !== undefined && { idleReply }),
      facts: this.facts,
      steps: this.steps,
    };
    const checked = validateScenario(structuredClone(raw));
    const missing = checkCoverage(checked);
    if (missing.length > 0) throw new Error(`Scenario "${head.id}" misses: ${missing.join('; ')} (${this.steps.length} steps, ${this.facts.length} facts)`);
    return raw;
  }
}

/** The core's plan rules (validatePlan): owners on the roster, known dependencies and contract ends, no cycles. */
function checkPlan(plan: PlanInput, roster: Set<string>): void {
  const ids = new Set(plan.workstreams.map(w => w.id));
  if (ids.size !== plan.workstreams.length) throw new Error('plan: duplicate workstream id');
  for (const w of plan.workstreams) {
    if (!roster.has(w.owner)) throw new Error(`plan: owner "${w.owner}" of "${w.id}" is not an employee`);
    for (const d of w.dependsOn) if (!ids.has(d)) throw new Error(`plan: "${w.id}" depends on unknown "${d}"`);
  }
  for (const c of plan.contracts) if (!ids.has(c.from) || !ids.has(c.to)) throw new Error(`plan: contract "${c.id}" has an unknown end`);
  const done = new Set<string>();
  const visit = (id: string, path: string[]) => {
    if (path.includes(id)) throw new Error(`plan: dependency cycle ${[...path, id].join(' -> ')}`);
    if (done.has(id)) return;
    for (const d of plan.workstreams.find(w => w.id === id)!.dependsOn) visit(d, [...path, id]);
    done.add(id);
  };
  for (const w of plan.workstreams) visit(w.id, []);
}
