// Planning, review and retrospective contexts (design spec 4). The lead's planning and review
// contexts carry the lead brief's cacheable prefix (common, memory, workspace, board; untrimmed),
// then the body as the projection and an optional trigger. The retrospective context is the
// member shape: common and board (cacheable) followed by one non-cacheable body segment.
import type { EmployeeRegistry } from './employees.js';
import { ContextError } from './errors.js';
import { assertMember, botMembers, defaultMemory, defaultWorkspace, renderTeam } from './members.js';
import { renderBoardPublic, renderMemory, renderPlanning, renderRetro, renderReview, renderTrigger, renderWorkspace, untrimmedKeeps } from './render.js';
import { toolDefinitions } from './tools.js';
import type { Store } from './store/store.js';
import type { ContextBundle, PlanProposal, ProjectBoard, Segment, SegmentKind, WakeReason, Workstream } from './types.js';

export interface ContextDeps {
  store: Store;
  projectId: string;
  employees: EmployeeRegistry;
  count: (s: string) => number;
}

/** Why the lead is being run; rendered like the brief's trigger segment. */
export type ContextTrigger = { reason: WakeReason | 'manual'; detail: string };

/** Meta key `plan`: the latest plan proposal and, after a rejection, its feedback. */
export type PlanMeta = { proposalId: string; feedback?: string };

export function findDeliverable(ws: Workstream[], deliverableId: string) {
  for (const w of ws) {
    const d = w.deliverables.find(x => x.id === deliverableId);
    if (d) return { w, d };
  }
  throw new ContextError('NOT_FOUND', `Deliverable "${deliverableId}" not found`);
}

function stats(deps: ContextDeps, segments: Segment[]) {
  const bySegment: Partial<Record<SegmentKind, number>> = {};
  let total = 0;
  for (const s of segments) total += bySegment[s.kind] = deps.count(s.text);
  return { bySegment, total };
}

async function personasOf(deps: ContextDeps, members: string[]) {
  return new Map(await Promise.all(members.map(async id => [id, (await deps.employees.get(id))?.persona] as const)));
}

async function bundle(
  deps: ContextDeps,
  board: ProjectBoard,
  ws: Workstream[],
  body: string,
  role: 'lead' | 'member',
): Promise<ContextBundle> {
  const members = botMembers(board, ws);
  const personas = await personasOf(deps, members);
  const segments: Segment[] = [
    { kind: 'common', text: renderTeam(board, members, id => personas.get(id)), cacheable: true },
    { kind: 'board', text: renderBoardPublic(board, ws), cacheable: true },
    { kind: 'projection', text: body, cacheable: false },
  ];
  return { segments, tools: toolDefinitions(role), stats: stats(deps, segments) };
}

/**
 * The lead's context for planning and review: the same cacheable prefix as the lead's buildBrief
 * (common, memory, workspace, board; untrimmed, rendered with the same defaults and renderers, and
 * without creating a workspace), then the body as the projection, then an optional trigger.
 */
async function leadBundle(
  deps: ContextDeps,
  board: ProjectBoard,
  ws: Workstream[],
  body: string,
  trigger: ContextTrigger | undefined,
): Promise<ContextBundle> {
  const { store, projectId } = deps;
  const members = botMembers(board, ws);
  const personas = await personasOf(deps, members);
  const lead = board.lead;
  const workspace = (await store.getWorkspace(projectId, lead)) ?? defaultWorkspace(projectId, lead, await store.latestSeq(projectId));
  const memory = (await deps.employees.get(lead)) ?? defaultMemory(lead);
  const { notesKeep, memKeep } = untrimmedKeeps(workspace, memory);
  const segments: Segment[] = [
    { kind: 'common', text: renderTeam(board, members, id => personas.get(id)), cacheable: true },
    { kind: 'memory', text: renderMemory(memory, memKeep), cacheable: true },
    { kind: 'workspace', text: renderWorkspace(workspace, notesKeep), cacheable: true },
    { kind: 'board', text: renderBoardPublic(board, ws), cacheable: true },
    { kind: 'projection', text: body, cacheable: false },
  ];
  if (trigger) segments.push({ kind: 'trigger', text: renderTrigger(trigger.reason, trigger.detail), cacheable: false });
  return { segments, tools: toolDefinitions('lead'), stats: stats(deps, segments) };
}

export async function planningContext(
  deps: ContextDeps,
  board: ProjectBoard,
  ws: Workstream[],
  trigger?: ContextTrigger,
): Promise<ContextBundle> {
  const { store, projectId } = deps;
  const humanMessages = (await store.read(projectId, 1)).filter(e => e.author.kind === 'human' && e.body.type === 'chat');
  const meta = await store.getMeta<PlanMeta>(projectId, 'plan');
  const plan: PlanProposal | null = meta ? await store.getPlanProposal(meta.proposalId) : null;
  const body = renderPlanning({
    board,
    roster: await deps.employees.roster(),
    humanMessages,
    previous: plan ? { plan, feedback: meta?.feedback } : undefined,
  });
  return leadBundle(deps, board, ws, body, trigger);
}

export async function reviewContext(
  deps: ContextDeps,
  board: ProjectBoard,
  ws: Workstream[],
  deliverableId: string,
  trigger?: ContextTrigger,
): Promise<ContextBundle> {
  const { w, d } = findDeliverable(ws, deliverableId);
  const body = renderReview({
    content: await deps.store.getDeliverable(deps.projectId, d.ref),
    workstream: w,
    contracts: board.contracts.filter(c => c.from === w.id || c.to === w.id),
    conventions: board.conventions,
    decisions: board.decisions.filter(x => x.affects.includes(w.id)),
    facts: board.facts.filter(x => x.affects.includes(w.id)),
    failures: board.failures.filter(x => x.affects.includes(w.id)),
  });
  return leadBundle(deps, board, ws, body, trigger);
}

export async function retroContext(
  deps: ContextDeps,
  board: ProjectBoard,
  ws: Workstream[],
  botId: string,
): Promise<ContextBundle> {
  const { store, projectId } = deps;
  assertMember(board, ws, botId);
  const own = ws.filter(w => w.owner === botId);
  const mine = new Set(own.flatMap(w => w.deliverables.map(d => d.id)));
  const reviews = (await store.read(projectId, 1)).filter(e => {
    const ev = e.body.type === 'event' ? e.body.event : null;
    return (ev?.kind === 'reviewPassed' || ev?.kind === 'reviewFailed') && mine.has(ev.deliverableId);
  });
  const body = renderRetro({
    workspace: (await store.getWorkspace(projectId, botId)) ?? defaultWorkspace(projectId, botId, await store.latestSeq(projectId)),
    workstream: own[0] ?? null,
    reviews,
    memory: (await deps.employees.get(botId)) ?? defaultMemory(botId),
  });
  return bundle(deps, board, ws, body, 'member');
}
