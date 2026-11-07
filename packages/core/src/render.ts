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
import type { PublicBoardSwitches, PublicBoardView } from './publicBoard.js';

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

/** The review instruction when contracts are on the public board (spec 2026-11-04 section 2.2), not in the review body. */
function reviewInstructionContractsOnBoard(workstreamId: string): string {
  return (
    'Check only whether the content violates the conventions listed below, or the contracts involving ' +
    `workstream "${workstreamId}" in the Contracts section of the project board above. ` +
    'Do not judge style, quality or anything else. ' +
    'Reply with a pass, or with the specific conventions or contracts that are violated.'
  );
}

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

export function workstreamLine(w: Workstream): string {
  return `${w.id} | ${w.title} | ${w.owner} | ${w.status}`;
}

export function itemLine(x: Item): string {
  return `- [${x.id}] ${x.text}`;
}

export function contractLine(c: Contract): string {
  return `- [${c.id}@v${c.version}] ${c.from} -> ${c.to}: ${c.spec}`;
}

export function decisionBlock(d: Decision): string {
  const lines = [`- [${d.id}] ${d.text}`, `  why: ${d.rationale}`];
  if (d.rejected.length > 0) lines.push(`  rejected: ${d.rejected.join('; ')}`);
  lines.push(`  affects: ${d.affects.join(', ')}`);
  return lines.join('\n');
}

export function failureBlock(f: Failure): string {
  return [`- [${f.id}] tried: ${f.text}`, `  why it failed: ${f.reason}`, `  affects: ${f.affects.join(', ')}`].join('\n');
}

function entryLine(e: LedgerEntry): string {
  if (e.body.type === 'chat') return `- #${e.seq} ${e.author.id}: ${e.body.text}`;
  const { kind, ...rest } = e.body.event;
  return `- #${e.seq} [${kind}] ${JSON.stringify(rest)}`;
}

/** R39b: delta chat lines carry the entry id, so a bot can pass it to `sendMessage.replyTo`. */
function deltaLine(e: LedgerEntry): string {
  if (e.body.type === 'chat') return `- #${e.seq} ${e.author.id} (id: ${e.id}): ${e.body.text}`;
  return entryLine(e);
}

/** Splits notes into paragraphs at blank lines (LF or CRLF, whitespace-only lines count as blank); trimmed, empties dropped. */
export function splitParagraphs(notes: string): string[] {
  return notes
    .split(/\r?\n[ \t]*\r?\n/)
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

// ---------------------------------------------------------------------------
// items, for item-level comparison (stream mode, spec 2026-11-06 §2.3)
// ---------------------------------------------------------------------------

/** One item as a segment shows it: its identity, the text shown now, and its text in full (differs only for a "(seen)" form). */
export interface ShownItem {
  key: string;
  text: string;
  full: string;
  /** The compact "(seen)" form, for items that have one (a projection's board items). */
  compact?: string;
}

/**
 * The items under one heading (`''` for a part's head lines, else a `## ` heading or a label such as
 * `Pinned:`). `leaves` says what an item that disappears means: `retract`, a real removal; `roll`, it
 * left a window (Recent, or budget trimming) and is no news; `replace`, a single text block (persona,
 * summary) whose removal is no news either.
 */
export interface ItemGroup {
  heading: string;
  leaves: 'retract' | 'roll' | 'replace';
  items: ShownItem[];
}

/** A segment's items per part: one part per owned workstream for a projection (`part` = its id), one `null` part otherwise. */
export interface ItemPart {
  part: string | null;
  groups: ItemGroup[];
}

const same = (key: string, text: string): ShownItem => ({ key, text, full: text });

/** The items of pinnedSummaryRecent, as groups; `key` identifies a pinned or recent entry. */
function pinnedSummaryRecentItems<T>(pinned: T[], condensed: string, recent: T[], key: (x: T) => string, text: (x: T) => string): ItemGroup[] {
  const groups: ItemGroup[] = [];
  if (pinned.length > 0) groups.push({ heading: 'Pinned:', leaves: 'retract', items: pinned.map((x) => same(key(x), `- ${text(x)}`)) });
  if (condensed.trim().length > 0) groups.push({ heading: 'Summary:', leaves: 'replace', items: [same('summary', condensed)] });
  if (recent.length > 0) groups.push({ heading: 'Recent:', leaves: 'roll', items: recent.map((x) => same(key(x), `- ${text(x)}`)) });
  return groups;
}

/** renderMemory's items (same recentKeep): persona, skills, pinned memories, summary, recent memories (keyed by memory id). */
export function memoryItems(m: EmployeeMemory, recentKeep: number): ItemPart[] {
  const groups: ItemGroup[] = [];
  if (m.persona.trim().length > 0) groups.push({ heading: 'Persona:', leaves: 'replace', items: [same('persona', m.persona)] });
  if (m.skills.length > 0) groups.push({ heading: 'Skills:', leaves: 'retract', items: m.skills.map((s) => same(`- ${s}`, `- ${s}`)) });
  const recent = last(m.memories.filter((x) => !x.pinned), recentKeep);
  groups.push(...pinnedSummaryRecentItems(m.memories.filter((x) => x.pinned), m.condensed, recent, (x) => x.id, (x) => x.text));
  return [{ part: null, groups }];
}

/** renderWorkspace's items (same recentKeep): pinned notes, summary, recent notes (notes have no id: keyed by their text). */
export function workspaceItems(w: Workspace, recentKeep: number): ItemPart[] {
  const id = (p: string) => p;
  return [{ part: null, groups: pinnedSummaryRecentItems(w.pinnedNotes, w.condensed, last(splitParagraphs(w.notes), recentKeep), id, id) }];
}

/** Key used for the seen-item rule: `${id}@${version}` for contracts, `id` for everything else. */
export function itemKey(x: Item | Contract): string {
  return 'version' in x ? `${x.id}@${x.version}` : x.id;
}

// ---------------------------------------------------------------------------
// segments 1-4 (cacheable)
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

/** A contract on the public board (spec 2026-11-04 section 2.2): `- [<id>@<version>] <from> → <to>: <spec>`. */
function boardContractLine(c: Contract): string {
  return `- [${c.id}@${c.version}] ${c.from} → ${c.to}: ${c.spec}`;
}

/** A directive line: `- [#<seq> <author id>] <original text>` (ledger authors carry only an id). */
export function directiveLine(e: LedgerEntry): string {
  return `- [#${e.seq} ${e.author.id}] ${e.body.type === 'chat' ? e.body.text : ''}`;
}

/**
 * The public board (segment 4). Without `view`, or with every switch off, the base render.
 * Optional sections (spec 2026-11-04 section 2.4) go in the order Goal, Constraints, Directives,
 * Conventions, Contracts, Failures, Workstreams; a section that is switched off does not appear.
 * Board items are always shown in full: the seen rule applies only to the projection.
 */
export function renderBoardPublic(board: ProjectBoard, workstreams: Workstream[], view?: PublicBoardView): string {
  const directives: string[] = [];
  if (view?.switches.directives) {
    const omitted = view.directivesOmitted > 0 ? [`(${view.directivesOmitted} earlier directives omitted)`] : [];
    const lines = view.directives.map(directiveLine);
    directives.push('## Directives', ...(omitted.length + lines.length > 0 ? [...omitted, ...lines] : [NOTHING]), '');
  }
  const contracts = view?.switches.contracts ? ['## Contracts', ...list(board.contracts.map(boardContractLine)), ''] : [];
  const failures = view?.switches.failures ? ['## Failures', ...list(board.failures.map(failureBlock)), ''] : [];
  return [
    '# Project',
    '',
    '## Goal',
    board.goal.trim().length > 0 ? board.goal : NOTHING,
    '',
    '## Constraints',
    ...list(board.constraints.map((c) => `- ${c}`)),
    '',
    ...directives,
    '## Conventions',
    ...list(board.conventions.map(itemLine)),
    '',
    ...contracts,
    ...failures,
    '## Workstreams',
    ...list(workstreams.map(workstreamLine)),
  ].join('\n');
}

/** The keep values that render a workspace's notes and a memory untrimmed (shared by buildBrief's start state and the lead contexts). */
export function untrimmedKeeps(workspace: Workspace, memory: EmployeeMemory): { notesKeep: number; memKeep: number } {
  return { notesKeep: splitParagraphs(workspace.notes).length, memKeep: memory.memories.filter(m => !m.pinned).length };
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
// segment 5: projection with seen-item compression
// ---------------------------------------------------------------------------

/**
 * `onBoard`: the public board switches. A section whose items are on the public board (contracts,
 * failures) is left out here, heading included, and its items are never shown or marked seen.
 */
export function renderProjection(
  p: Projection,
  seen: Set<string>,
  onBoard?: PublicBoardSwitches,
): { text: string; shownKeys: string[]; items: ItemPart } {
  if (p.workstream === null) return { text: ['# Your part', '', NO_PART].join('\n'), shownKeys: [], items: { part: null, groups: [] } };

  const shownKeys: string[] = [];
  const groups: ItemGroup[] = [];
  const group = (heading: string, items: ShownItem[]): void => {
    groups.push({ heading, leaves: 'retract', items });
  };
  const entries = <T extends Item | Contract>(heading: string, xs: T[], compact: (x: T) => string, full: (x: T) => string): string[] => {
    const shown = xs.map((x): ShownItem => {
      const key = itemKey(x);
      if (seen.has(key)) return { key: x.id, text: compact(x), full: full(x), compact: compact(x) };
      shownKeys.push(key);
      return { ...same(x.id, full(x)), compact: compact(x) };
    });
    group(heading, shown);
    return shown.map((x) => x.text);
  };
  const compactItem = (x: Item): string => `- [${x.id}] ${firstCodePoints(x.text, COMPACT_CODE_POINTS)} (seen)`;

  const w = p.workstream;
  const headItems = [same('line', workstreamLine(w)), same('brief', `Brief:\n${w.brief}`)];
  if (w.dependsOn.length > 0) headItems.push(same('dependsOn', `depends on: ${w.dependsOn.join(', ')}`));
  if (w.writeScopes.length > 0) headItems.push(same('writeScopes', `write scopes: ${w.writeScopes.join(', ')}`));
  headItems.push(same('reviewRounds', `review rounds: ${w.reviewRounds}`));
  group('', headItems);
  const head = headItems.map((x) => x.text);

  const contracts = onBoard?.contracts
    ? []
    : ['## Contracts', ...list(entries('## Contracts', p.contracts, (c) => `- [${c.id}@v${c.version}] ${c.from} -> ${c.to} (seen)`, contractLine)), ''];
  const decisions = entries('## Decisions', p.decisions, compactItem, decisionBlock);
  const facts = entries('## Facts', p.facts, compactItem, itemLine);
  const failures = onBoard?.failures ? [] : ['## Failures', ...list(entries('## Failures', p.failures, compactItem, failureBlock)), ''];
  const upstream = p.upstream.map((u) => same(u.workstream.id, `- ${u.workstream.id} delivered v${u.deliverable.version}: ${u.deliverable.summary} (ref: ${u.deliverable.ref})`));
  group('## Upstream deliverables', upstream);
  const overlaps = p.overlaps.map((o) => `- overlaps with ${o.other.id} (${o.other.owner}) on ${o.prefix}`);
  group('## Overlaps', overlaps.map((t) => same(t, t)));

  const text = [
    '# Your part',
    '',
    ...head,
    '',
    ...contracts,
    '## Decisions',
    ...list(decisions),
    '',
    '## Facts',
    ...list(facts),
    '',
    ...failures,
    '## Upstream deliverables',
    ...list(upstream.map((u) => u.text)),
    '',
    '## Overlaps',
    ...list(overlaps),
  ].join('\n');
  return { text, shownKeys, items: { part: w.id, groups } };
}

// ---------------------------------------------------------------------------
// segment 3 (workspace, cacheable) and segments 6-7 (delta, trigger)
// ---------------------------------------------------------------------------

export function renderWorkspace(w: Workspace, recentKeep: number): string {
  return section(
    '# Your notes',
    pinnedSummaryRecent(w.pinnedNotes, w.condensed, last(splitParagraphs(w.notes), recentKeep)),
  );
}

/** `omitted`: how many older entries/changes were left out to fit the token budget. */
export function renderDelta(entries: LedgerEntry[], changes: AppliedOp[], omitted = 0): string {
  const note =
    omitted > 0 ? [`- (${omitted} older ${omitted === 1 ? 'item' : 'items'} omitted to fit the token budget)`] : [];
  return section('# Since you last looked', [
    ...note,
    ...entries.map(deltaLine),
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
  failures: Failure[];
  facts: Fact[];
  /** The public board switches: contracts and failures on the board are not repeated here. */
  onBoard?: PublicBoardSwitches;
}): string {
  const contracts = i.onBoard?.contracts ? [] : ['## Contracts', ...list(i.contracts.map(contractLine)), ''];
  const failures = i.onBoard?.failures ? [] : ['## Failures', ...list(i.failures.map(failureBlock)), ''];
  return [
    i.onBoard?.contracts ? reviewInstructionContractsOnBoard(i.workstream.id) : REVIEW_INSTRUCTION,
    '',
    '## Workstream',
    workstreamLine(i.workstream),
    '',
    '## Conventions',
    ...list(i.conventions.map(itemLine)),
    '',
    ...contracts,
    '## Decisions',
    ...list(i.decisions.map(decisionBlock)),
    '',
    '## Facts',
    ...list(i.facts.map(itemLine)),
    '',
    ...failures,
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
