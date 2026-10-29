// Planning, review and retrospective contexts (design spec 4): the common and board segments
// (cacheable, byte-identical to buildBrief's) followed by one non-cacheable body segment.
import type { EmployeeRegistry } from './employees.js';
import { ContextError } from './errors.js';
import { assertMember, botMembers, defaultMemory, defaultWorkspace, renderTeam } from './members.js';
import { renderBoardPublic, renderPlanning, renderRetro, renderReview } from './render.js';
import { toolDefinitions } from './tools.js';
import type { Store } from './store/store.js';
import type { ContextBundle, PlanProposal, ProjectBoard, Segment, SegmentKind, Workstream } from './types.js';

export interface ContextDeps {
  store: Store;
  projectId: string;
  employees: EmployeeRegistry;
  count: (s: string) => number;
}

/** Meta key `plan`: the latest plan proposal and, after a rejection, its feedback. */
export type PlanMeta = { proposalId: string; feedback?: string };

export function findDeliverable(ws: Workstream[], deliverableId: string) {
  for (const w of ws) {
    const d = w.deliverables.find(x => x.id === deliverableId);
    if (d) return { w, d };
  }
  throw new ContextError('NOT_FOUND', `Deliverable "${deliverableId}" not found`);
}

async function bundle(
  deps: ContextDeps,
  board: ProjectBoard,
  ws: Workstream[],
  body: string,
  role: 'lead' | 'member',
): Promise<ContextBundle> {
  const members = botMembers(board, ws);
  const personas = new Map(await Promise.all(members.map(async id => [id, (await deps.employees.get(id))?.persona] as const)));
  const segments: Segment[] = [
    { kind: 'common', text: renderTeam(board, members, id => personas.get(id)), cacheable: true },
    { kind: 'board', text: renderBoardPublic(board, ws), cacheable: true },
    { kind: 'projection', text: body, cacheable: false },
  ];
  const bySegment: Partial<Record<SegmentKind, number>> = {};
  let total = 0;
  for (const s of segments) total += bySegment[s.kind] = deps.count(s.text);
  return { segments, tools: toolDefinitions(role), stats: { bySegment, total } };
}

export async function planningContext(deps: ContextDeps, board: ProjectBoard, ws: Workstream[]): Promise<ContextBundle> {
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
  return bundle(deps, board, ws, body, 'lead');
}

export async function reviewContext(
  deps: ContextDeps,
  board: ProjectBoard,
  ws: Workstream[],
  deliverableId: string,
): Promise<ContextBundle> {
  const { w, d } = findDeliverable(ws, deliverableId);
  const body = renderReview({
    content: await deps.store.getDeliverable(deps.projectId, d.ref),
    workstream: w,
    contracts: board.contracts.filter(c => c.from === w.id || c.to === w.id),
    conventions: board.conventions,
    decisions: board.decisions.filter(x => x.affects.includes(w.id)),
  });
  return bundle(deps, board, ws, body, 'lead');
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
