// Deterministic renderers for the brief segments (spec section 5.2) and for the planning,
// review and retrospective contexts. All functions are pure: identical input gives
// byte-identical output, with no clock, randomness or locale-dependent formatting.
import type {
  AppliedOp,
  Contract,
  Decision,
  EmployeeMemory,
  Fact,
  Failure,
  Item,
  LedgerEntry,
  PlanProposal,
  ProjectBoard,
  WakeReason,
  Workspace,
  Workstream,
} from './types.js';

export interface Projection {
  workstream: Workstream | null;
  contracts: Contract[];
  decisions: Decision[];
  facts: Fact[];
  failures: Failure[];
  upstream: { workstream: Workstream; deliverable: Workstream['deliverables'][number] }[];
  overlaps: { other: Workstream; prefix: string }[];
}

const NOTHING = '(nothing yet)';
const NO_PART = 'No part assigned yet.';
const COMPACT_CODE_POINTS = 40;

const INTRO =
  'You are a member of a project team. Your context is a projection of the shared project board: ' +
  'it shows the parts that concern you, not everything. Use your tools to fetch more detail when you need it.';

const REVIEW_INSTRUCTION =
  'Check only whether the content violates the conventions and contracts listed below. ' +
  'Do not judge style, quality or anything else. ' +
  'Reply with a pass, or with the specific conventions or contracts that are violated.';

const PLANNING_INSTRUCTION =
  'You are the lead of this project. Propose a plan: split the goal into workstreams, assign each to a team member from the roster, ' +
  'declare dependencies and the interface contracts between workstreams.';

const RETRO_INSTRUCTION =
  'The project is over. Look back on your part and decide what is worth remembering for future projects. ' +
  'Write short, reusable lessons, not a project log.';

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function section(heading: string, lines: string[]): string {
  return [heading, '', ...(lines.length > 0 ? lines : [NOTHING])].join('\n');
}

function list(items: string[]): string[] {
  return items.length > 0 ? items : [NOTHING];
}

function last<T>(arr: T[], n: number): T[] {
  if (!(n > 0)) return [];
  return arr.slice(Math.max(0, arr.length - n));
}

function firstCodePoints(text: string, n: number): string {
  const firstLine = text.split('\n')[0] ?? '';
  return Array.from(firstLine).slice(0, n).join('');
}

function workstreamLine(w: Workstream): string {
  return `${w.id} | ${w.title} | ${w.owner} | ${w.status}`;
}

function itemLine(x: Item): string {
  return `- [${x.id}] ${x.text}`;
}

function contractLine(c: Contract): string {
  return `- [${c.id}@v${c.version}] ${c.from} -> ${c.to}: ${c.spec}`;
}

function decisionBlock(d: Decision): string {
  const lines = [`- [${d.id}] ${d.text}`, `  why: ${d.rationale}`];
  if (d.rejected.length > 0) lines.push(`  rejected: ${d.rejected.join('; ')}`);
  lines.push(`  affects: ${d.affects.join(', ')}`);
  return lines.join('\n');
}

function entryLine(e: LedgerEntry): string {
  if (e.body.type === 'chat') return `- #${e.seq} ${e.author.id}: ${e.body.text}`;
  const { kind, ...rest } = e.body.event;
  return `- #${e.seq} [${kind}] ${JSON.stringify(rest)}`;
}

function paragraphs(notes: string): string[] {
  return notes
    .split('\n\n')
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
}

/** Shared shape for workspace notes and memories: pinned, rolling summary, recent. */
function pinnedSummaryRecent(pinned: string[], condensed: string, recent: string[]): string[] {
  const lines: string[] = [];
  if (pinned.length > 0) lines.push('Pinned:', ...pinned.map((p) => `- ${p}`));
  if (condensed.trim().length > 0) lines.push('Summary:', condensed);
  if (recent.length > 0) lines.push('Recent:', ...recent.map((p) => `- ${p}`));
  return lines;
}

/** Key used for the seen-item rule: `${id}@${version}` for contracts, `id` for everything else. */
export function itemKey(x: Item | Contract): string {
  return 'version' in x ? `${x.id}@${x.version}` : x.id;
}

// ---------------------------------------------------------------------------
// segments 1-3 (cacheable)
// ---------------------------------------------------------------------------

export function renderCommon(members: { id: string; kind: 'human' | 'bot'; role: string }[]): string {
  return [
    '# Team',
    '',
    INTRO,
    '',
    'Members:',
    ...list(members.map((m) => `- ${m.id} (${m.kind}): ${m.role}`)),
  ].join('\n');
}

export function renderBoardPublic(board: ProjectBoard, workstreams: Workstream[]): string {
  return [
    '# Project',
    '',
    '## Goal',
    board.goal.trim().length > 0 ? board.goal : NOTHING,
    '',
    '## Constraints',
    ...list(board.constraints.map((c) => `- ${c}`)),
    '',
    '## Conventions',
    ...list(board.conventions.map(itemLine)),
    '',
    '## Workstreams',
    ...list(workstreams.map(workstreamLine)),
  ].join('\n');
}

export function renderMemory(m: EmployeeMemory, recentKeep: number): string {
  const lines: string[] = [];
  if (m.persona.trim().length > 0) lines.push('Persona:', m.persona);
  if (m.skills.length > 0) lines.push('Skills:', ...m.skills.map((s) => `- ${s}`));
  lines.push(
    ...pinnedSummaryRecent(
      m.memories.filter((x) => x.pinned).map((x) => x.text),
      m.condensed,
      last(
        m.memories.filter((x) => !x.pinned),
        recentKeep,
      ).map((x) => x.text),
    ),
  );
  return section('# Your memory', lines);
}

// ---------------------------------------------------------------------------
// segment 4: projection with seen-item compression
// ---------------------------------------------------------------------------

export function renderProjection(p: Projection, seen: Set<string>): { text: string; shownKeys: string[] } {
  if (p.workstream === null) return { text: ['# Your part', '', NO_PART].join('\n'), shownKeys: [] };

  const shownKeys: string[] = [];
  const entries = <T extends Item | Contract>(xs: T[], compact: (x: T) => string, full: (x: T) => string): string[] =>
    xs.map((x) => {
      const key = itemKey(x);
      if (seen.has(key)) return compact(x);
      shownKeys.push(key);
      return full(x);
    });
  const compactItem = (x: Item): string => `- [${x.id}] ${firstCodePoints(x.text, COMPACT_CODE_POINTS)} (seen)`;

  const w = p.workstream;
  const head = [workstreamLine(w), 'Brief:', w.brief];
  if (w.dependsOn.length > 0) head.push(`depends on: ${w.dependsOn.join(', ')}`);
  if (w.writeScopes.length > 0) head.push(`write scopes: ${w.writeScopes.join(', ')}`);
  head.push(`review rounds: ${w.reviewRounds}`);

  const contracts = entries(
    p.contracts,
    (c) => `- [${c.id}@v${c.version}] ${c.from} -> ${c.to} (seen)`,
    contractLine,
  );
  const decisions = entries(p.decisions, compactItem, decisionBlock);
  const facts = entries(p.facts, compactItem, itemLine);
  const failures = entries(p.failures, compactItem, (f) =>
    [`- [${f.id}] tried: ${f.text}`, `  why it failed: ${f.reason}`, `  affects: ${f.affects.join(', ')}`].join('\n'),
  );

  const text = [
    '# Your part',
    '',
    ...head,
    '',
    '## Contracts',
    ...list(contracts),
    '',
    '## Decisions',
    ...list(decisions),
    '',
    '## Facts',
    ...list(facts),
    '',
    '## Failures',
    ...list(failures),
    '',
    '## Upstream deliverables',
    ...list(p.upstream.map((u) => `- ${u.workstream.id} delivered v${u.deliverable.version}: ${u.deliverable.summary} (ref: ${u.deliverable.ref})`)),
    '',
    '## Overlaps',
    ...list(p.overlaps.map((o) => `- overlaps with ${o.other.id} (${o.other.owner}) on ${o.prefix}`)),
  ].join('\n');
  return { text, shownKeys };
}

// ---------------------------------------------------------------------------
// segments 5-7
// ---------------------------------------------------------------------------

export function renderWorkspace(w: Workspace, recentKeep: number): string {
  return section(
    '# Your notes',
    pinnedSummaryRecent(w.pinnedNotes, w.condensed, last(paragraphs(w.notes), recentKeep)),
  );
}

export function renderDelta(entries: LedgerEntry[], changes: AppliedOp[]): string {
  return section('# Since you last looked', [
    ...entries.map(entryLine),
    ...changes.map((c) => `- board: ${c.op.op} by ${c.by} (${c.touched.join(', ')})`),
  ]);
}

export function renderTrigger(reason: WakeReason | 'manual', detail: string): string {
  const lines = ['# Why you are awake', '', `reason: ${reason}`];
  if (detail.length > 0) lines.push(detail);
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// planning, review and retro contexts
// ---------------------------------------------------------------------------

export function renderPlanning(i: {
  board: ProjectBoard;
  roster: { botId: string; persona: string; skills: string[] }[];
  humanMessages: LedgerEntry[];
  previous?: { plan: PlanProposal; feedback?: string };
}): string {
  const out = [
    '# Plan the project',
    '',
    PLANNING_INSTRUCTION,
    '',
    '## Goal',
    i.board.goal.trim().length > 0 ? i.board.goal : NOTHING,
    '',
    '## Constraints',
    ...list(i.board.constraints.map((c) => `- ${c}`)),
    '',
    '## Roster',
    ...list(
      i.roster.map((r) => {
        const skills = r.skills.length > 0 ? ` (skills: ${r.skills.join(', ')})` : '';
        return `- ${r.botId}: ${firstCodePoints(r.persona, Number.POSITIVE_INFINITY)}${skills}`;
      }),
    ),
    '',
    '## Human messages',
    ...list(i.humanMessages.map(entryLine)),
  ];
  if (i.previous) {
    const { plan, feedback } = i.previous;
    out.push(
      '',
      '## Previous plan',
      'Workstreams:',
      ...list(
        plan.workstreams.map(
          (w) =>
            `- ${w.id} | ${w.title} | ${w.owner}` + (w.dependsOn.length > 0 ? ` | depends on: ${w.dependsOn.join(', ')}` : ''),
        ),
      ),
      'Contracts:',
      ...list(plan.contracts.map((c) => `- [${c.id}] ${c.from} -> ${c.to}: ${c.spec}`)),
    );
    if (feedback !== undefined && feedback.length > 0) out.push('Feedback:', feedback);
  }
  return out.join('\n');
}

export function renderReview(i: {
  content: string;
  workstream: Workstream;
  contracts: Contract[];
  conventions: Item[];
  decisions: Decision[];
}): string {
  return [
    REVIEW_INSTRUCTION,
    '',
    '## Workstream',
    workstreamLine(i.workstream),
    '',
    '## Conventions',
    ...list(i.conventions.map(itemLine)),
    '',
    '## Contracts',
    ...list(i.contracts.map(contractLine)),
    '',
    '## Decisions',
    ...list(i.decisions.map(decisionBlock)),
    '',
    '## Content to review',
    i.content,
  ].join('\n');
}

export function renderRetro(i: {
  workspace: Workspace;
  workstream: Workstream | null;
  reviews: LedgerEntry[];
  memory: EmployeeMemory;
}): string {
  const all = Number.POSITIVE_INFINITY; // notes and memory are size-capped, so show them whole
  return [
    '# Retrospective',
    '',
    RETRO_INSTRUCTION,
    '',
    '## Your part',
    i.workstream === null ? NO_PART : workstreamLine(i.workstream),
    '',
    '## Reviews',
    ...list(i.reviews.map(entryLine)),
    '',
    renderWorkspace(i.workspace, all),
    '',
    renderMemory(i.memory, all),
  ].join('\n');
}
