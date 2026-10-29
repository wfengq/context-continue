// Bot tool definitions (design spec 6.2) and the dispatcher behind `Project.callTool`. Parameter
// schemas are zod; the JSON Schema handed to the host is generated from them. Every tool maps onto
// a facade method, so permission checks, the serial queue and R20 stay in one place (project.ts).
// The calling bot is always the author: arguments can never name another actor.
import { z } from 'zod';
import { boardOpSchema } from './board/schema.js';
import type { Rejection } from './board/merge.js';
import { ContextError } from './errors.js';
import type { Project } from './project.js';
import type { Store } from './store/store.js';
import type { BoardOp, PendingProposal, ProjectBoard, ToolDefinition, Wake } from './types.js';

export const MEMBER_TOOL_NAMES = [
  'searchLedger',
  'getBoardItem',
  'getDeliverable',
  'submitDeliverable',
  'proposeDecision',
  'recordFailure',
  'promote',
  'reportBlocked',
  'updateNotes',
  'sendMessage',
] as const;
export const LEAD_TOOL_NAMES = ['proposePlan', 'resolveProposal', 'submitReview', 'listPending', 'unblockWorkstream'] as const;
export type ToolName = (typeof MEMBER_TOOL_NAMES)[number] | (typeof LEAD_TOOL_NAMES)[number];

/** What a bot learns about a board proposal it submitted (R30). */
export interface ProposalOutcome {
  /** True when at least one op changed the board. */
  applied: boolean;
  /** Ops waiting for the lead or a human. */
  pending: { id: string; needs: 'lead' | 'human' }[];
  /** Ops the merger refused; `index` is the position in the submitted ops. */
  rejected: { index: number; reason: string }[];
}

/** The part of a merge result that belongs to proposal `proposalId`, which submitted `opCount` ops. */
export function proposalOutcome(
  proposalId: string,
  opCount: number,
  merge: { pending: PendingProposal[]; rejected: Rejection[] } | null,
): ProposalOutcome {
  if (!merge) return { applied: false, pending: [], rejected: [] };
  const pending = merge.pending.filter(p => p.proposalId === proposalId);
  const rejected = merge.rejected.filter(r => r.proposalId === proposalId);
  const unapplied = pending.reduce((n, p) => n + p.ops.length, 0) + rejected.filter(r => r.index >= 0).length;
  return {
    applied: opCount - unapplied > 0,
    pending: pending.map(p => ({ id: p.id, needs: p.needs })),
    rejected: rejected.map(r => ({ index: r.index, reason: r.reason })),
  };
}

/** What the dispatcher needs from the project facade. */
export interface ToolHost
  extends Pick<Project, 'board' | 'pending' | 'submit' | 'proposePlan' | 'resolveProposal' | 'submitReview' | 'ingest' | 'route'> {
  store: Store;
  projectId: string;
  /** Resolves with the board's lead; throws NOT_A_MEMBER when `botId` is not a bot member. */
  member(botId: string): Promise<{ lead: string }>;
  /**
   * Queues and merges a proposal as `botId` and reports what happened to it. With `promotion`,
   * the call counts against `maxPromotionsPerTurn` and fails with FORBIDDEN beyond it.
   */
  propose(botId: string, ops: BoardOp[], promotion: boolean): Promise<ProposalOutcome>;
  /** R35: the lead returns a blocked workstream to `pending`; it becomes active once its dependencies are delivered. */
  unblock(botId: string, workstreamId: string): Promise<Wake[]>;
}

// ---------------------------------------------------------------------------
// parameter schemas
// ---------------------------------------------------------------------------

const str = z.string().min(1);
const strList = z.array(z.string());
const affects = z.array(str).min(1).describe('Ids of the workstreams this affects; must not be empty.');
const sourceEntryIds = strList.optional().describe('Ledger entry ids the statement is based on, if any.');

const planSchema = z.object({
  workstreams: z.array(
    z.object({
      id: z.string(),
      title: z.string(),
      brief: z.string(),
      owner: z.string().describe('Id of the responsible bot.'),
      dependsOn: strList.describe('Ids of workstreams that must be delivered first.'),
      writeScopes: strList.optional().describe('Planned path prefixes this workstream writes to.'),
    }),
  ),
  contracts: z.array(
    z.object({
      id: z.string(),
      from: z.string().describe('Providing workstream id.'),
      to: z.string().describe('Consuming workstream id.'),
      spec: z.string().describe('What is delivered, in what format.'),
    }),
  ),
});

const promoteSchema = z
  .object({
    kind: z.enum(['fact', 'decision', 'failure']),
    text: str.describe('The fact, decision, or what was tried.'),
    affects,
    rationale: str.optional().describe('Required for a decision: why it was chosen.'),
    rejected: strList.optional().describe('For a decision: alternatives that were rejected.'),
    reason: str.optional().describe('Required for a failure: why it does not work.'),
    sourceEntryIds,
  })
  .superRefine((v, ctx) => {
    if (v.kind === 'decision' && v.rationale === undefined) {
      ctx.addIssue({ code: 'custom', path: ['rationale'], message: 'rationale is required for a decision' });
    }
    if (v.kind === 'failure' && v.reason === undefined) {
      ctx.addIssue({ code: 'custom', path: ['reason'], message: 'reason is required for a failure' });
    }
  });

// ---------------------------------------------------------------------------
// the tools
// ---------------------------------------------------------------------------

interface Ctx {
  botId: string;
  host: ToolHost;
}

interface Tool {
  name: ToolName;
  description: string;
  leadOnly: boolean;
  schema: z.ZodType;
  run(c: Ctx, args: never): Promise<unknown>;
}

function tool<S extends z.ZodType>(spec: {
  name: ToolName;
  description: string;
  leadOnly?: boolean;
  schema: S;
  run: (c: Ctx, args: z.output<S>) => Promise<unknown>;
}): Tool {
  return { name: spec.name, description: spec.description, leadOnly: spec.leadOnly ?? false, schema: spec.schema, run: spec.run };
}

const source = (c: Ctx, entryIds: string[] | undefined) => ({ entryIds: entryIds ?? [], by: c.botId });

type Section = { section: string; items: { id: string }[] };
const sectionsOf = (b: ProjectBoard): Section[] => [
  { section: 'conventions', items: b.conventions },
  { section: 'decisions', items: b.decisions },
  { section: 'facts', items: b.facts },
  { section: 'failures', items: b.failures },
  { section: 'openQuestions', items: b.openQuestions },
  { section: 'contracts', items: b.contracts },
  { section: 'workstreams', items: b.workstreams },
];

const TOOLS: Tool[] = [
  tool({
    name: 'searchLedger',
    description:
      'Search the shared project ledger (chat messages and archived board items) for a text. Case-insensitive; every word must match. Never searches private notes or memories.',
    schema: z.object({ query: str, limit: z.number().int().min(1).max(100).optional() }),
    run: (c, a) => c.host.store.search(c.host.projectId, a.query, a.limit),
  }),
  tool({
    name: 'getBoardItem',
    description:
      'Get the full content of one project board item by id: a convention, decision, fact, failure, open question, contract or workstream. A contract key such as "c1@2" is accepted too.',
    schema: z.object({ id: str }),
    run: async (c, a) => {
      const board = await c.host.board();
      const ids = [a.id, a.id.replace(/@\d+$/, '')];
      for (const id of ids) {
        for (const s of sectionsOf(board)) {
          const item = s.items.find(x => x.id === id);
          if (item) return item;
        }
      }
      throw new ContextError('NOT_FOUND', `Board item "${a.id}" not found`);
    },
  }),
  tool({
    name: 'getDeliverable',
    description: 'Get the content of a submitted deliverable by its ref (listed on the board under each workstream).',
    schema: z.object({ ref: str }),
    run: (c, a) => c.host.store.getDeliverable(c.host.projectId, a.ref),
  }),
  tool({
    name: 'submitDeliverable',
    description:
      'Submit a deliverable for a workstream you own. The lead is asked to review it. A summary and the full content are required.',
    schema: z.object({ workstreamId: str, summary: str, content: str }),
    run: async (c, a) => ({ wakes: await c.host.submit(c.botId, { type: 'deliverable', ...a }) }),
  }),
  tool({
    name: 'proposeDecision',
    description:
      'Propose a decision for the project board. It lands directly when it only affects workstreams you own; otherwise the lead decides. Returns what happened to it.',
    schema: z.object({
      text: str.describe('The decision.'),
      rationale: str.describe('Why it was decided.'),
      rejected: strList.optional().describe('Alternatives that were rejected.'),
      affects,
      sourceEntryIds,
    }),
    run: (c, a) =>
      c.host.propose(
        c.botId,
        [
          {
            op: 'addDecision',
            decision: { text: a.text, rationale: a.rationale, rejected: a.rejected ?? [], affects: a.affects, source: source(c, a.sourceEntryIds) },
          },
        ],
        false,
      ),
  }),
  tool({
    name: 'recordFailure',
    description: 'Record an approach that was tried and did not work, so nobody repeats it. Returns what happened to it.',
    schema: z.object({
      text: str.describe('What was tried.'),
      reason: str.describe('Why it does not work.'),
      affects,
      sourceEntryIds,
    }),
    run: (c, a) =>
      c.host.propose(
        c.botId,
        [{ op: 'addFailure', failure: { text: a.text, reason: a.reason, affects: a.affects, source: source(c, a.sourceEntryIds) } }],
        false,
      ),
  }),
  tool({
    name: 'promote',
    description:
      'Promote something from your private notes to the shared project board as a fact, a decision or a failure. Limited per turn; affects must not be empty. Returns what happened to it.',
    schema: promoteSchema,
    run: (c, a) => {
      const base = { text: a.text, affects: a.affects, source: source(c, a.sourceEntryIds) };
      const op: BoardOp =
        a.kind === 'fact'
          ? { op: 'addFact', fact: base }
          : a.kind === 'decision'
            ? { op: 'addDecision', decision: { ...base, rationale: a.rationale!, rejected: a.rejected ?? [] } }
            : { op: 'addFailure', failure: { ...base, reason: a.reason! } };
      return c.host.propose(c.botId, [op], true);
    },
  }),
  tool({
    name: 'reportBlocked',
    description: 'Report that a workstream you own is blocked. The workstream is marked blocked and the lead is asked to help.',
    schema: z.object({ workstreamId: str, reason: str }),
    run: async (c, a) => ({ wakes: await c.host.submit(c.botId, { type: 'blocked', ...a }) }),
  }),
  tool({
    name: 'updateNotes',
    description:
      'Add to your private working notes for this project. Pinned notes are never condensed away. Notes are visible only to you.',
    schema: z.object({ text: str, pinned: z.boolean().optional() }),
    run: async (c, a) => ({
      wakes: await c.host.submit(c.botId, a.pinned === undefined ? { type: 'notes', text: a.text } : { type: 'notes', text: a.text, pinned: a.pinned }),
    }),
  }),
  tool({
    name: 'sendMessage',
    description:
      'Post a message to the project chat. The speech act is required: request, query and propose expect a reply; inform, agree, refuse and done are terminal and wake nobody.',
    schema: z.object({
      text: str,
      act: z.enum(['request', 'query', 'propose', 'inform', 'agree', 'refuse', 'done']),
      mentions: strList.optional().describe('Ids of the bots addressed.'),
      replyTo: str.optional().describe('Id of the ledger entry this replies to.'),
    }),
    run: async (c, a) => {
      const entry = await c.host.ingest({
        author: { kind: 'bot', id: c.botId },
        text: a.text,
        act: a.act,
        ...(a.mentions && { mentions: a.mentions }),
        ...(a.replyTo && { replyTo: a.replyTo }),
      });
      return { entryId: entry.id, wakes: await c.host.route(entry) };
    },
  }),
  tool({
    name: 'proposePlan',
    description: 'Lead only. Propose the split of the project into workstreams and contracts for the owner to approve.',
    leadOnly: true,
    schema: planSchema,
    run: (c, a) => c.host.proposePlan(a, { by: c.botId }),
  }),
  tool({
    name: 'resolveProposal',
    description:
      'Lead only. Accept (optionally with edited ops) or reject a pending board proposal that needs the lead.',
    leadOnly: true,
    schema: z.object({
      pendingId: str,
      accept: z.boolean(),
      edits: z.array(boardOpSchema).optional().describe('Replacement ops; they become your own ops.'),
    }),
    run: async (c, a) => ({
      wakes: await c.host.resolveProposal(a.pendingId, { by: c.botId, accept: a.accept, ...(a.edits && { edits: a.edits }) }),
    }),
  }),
  tool({
    name: 'listPending',
    description:
      'Lead only. List the pending board proposals waiting for your decision (id, author, ops, creation time); resolve them with resolveProposal.',
    leadOnly: true,
    schema: z.object({}),
    run: async c =>
      (await c.host.pending())
        .filter(p => p.needs === 'lead')
        .map(p => ({ id: p.id, by: p.by, needs: p.needs, ops: p.ops, createdAt: p.createdAt })),
  }),
  tool({
    name: 'unblockWorkstream',
    description:
      'Lead only. Return a blocked workstream to pending once the blocker is resolved. It becomes active, and its owner is woken, as soon as its dependencies are delivered.',
    leadOnly: true,
    schema: z.object({ workstreamId: str }),
    run: async (c, a) => ({ wakes: await c.host.unblock(c.botId, a.workstreamId) }),
  }),
  tool({
    name: 'submitReview',
    description:
      'Lead only. Record the review of a deliverable. Passing it marks the workstream delivered; failing it sends it back to its owner. Conventions are new rules for everyone.',
    leadOnly: true,
    schema: z.object({
      deliverableId: str,
      passed: z.boolean(),
      notes: z.string(),
      conventions: strList.optional(),
    }),
    run: async (c, a) => ({
      wakes: await c.host.submitReview(a.deliverableId, {
        by: c.botId,
        passed: a.passed,
        notes: a.notes,
        ...(a.conventions && { conventions: a.conventions }),
      }),
    }),
  }),
];

// ---------------------------------------------------------------------------
// public API
// ---------------------------------------------------------------------------

let definitions: ToolDefinition[] | null = null;

/** The tools a bot of the given role can call, with JSON Schema parameters. Fresh copies on every call. */
export function toolDefinitions(role: 'lead' | 'member'): ToolDefinition[] {
  definitions ??= TOOLS.map(t => {
    // Some providers reject the top-level `$schema` key, so it is left out.
    const { $schema: _, ...parameters } = z.toJSONSchema(t.schema, { io: 'input' }) as Record<string, unknown>;
    return { name: t.name, description: t.description, parameters };
  });
  const lead = new Set<string>(LEAD_TOOL_NAMES);
  return structuredClone(definitions.filter(d => role === 'lead' || !lead.has(d.name)));
}

/** Builds `callTool`: non-member, then lead-only, then argument validation, then the facade call. */
export function createToolDispatcher(host: ToolHost): (botId: string, name: string, args: unknown) => Promise<unknown> {
  return async (botId, name, args) => {
    const { lead } = await host.member(botId);
    const t = TOOLS.find(x => x.name === name);
    if (!t) throw new ContextError('NOT_FOUND', `Unknown tool "${name}"`);
    if (t.leadOnly && botId !== lead) {
      throw new ContextError('FORBIDDEN', `Tool "${name}" can only be called by the lead (${lead})`);
    }
    const parsed = t.schema.safeParse(args);
    if (!parsed.success) {
      const summary = parsed.error.issues.map(i => `${i.path.join('.') || '(arguments)'}: ${i.message}`).join('; ');
      throw new ContextError('INVALID_OP', `Invalid arguments for ${name}: ${summary}`, { issues: parsed.error.issues });
    }
    return t.run({ botId, host }, parsed.data as never);
  };
}
