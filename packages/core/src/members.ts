// Project membership and the per-bot defaults shared by buildBrief and the project facade.
import { ContextError } from './errors.js';
import { renderCommon } from './render.js';
import type { EmployeeMemory, ProjectBoard, Workspace, Workstream } from './types.js';

export const firstLine = (s: string): string => (s.split(/\r?\n/)[0] ?? '').trim();

/** Bot members: the lead, then workstream owners in workstream order, deduped. */
export function botMembers(board: ProjectBoard, workstreams: Workstream[]): string[] {
  const out: string[] = [];
  for (const id of [board.lead, ...workstreams.map(w => w.owner)]) {
    if (id && !out.includes(id)) out.push(id);
  }
  return out;
}

/** Returns the bot members; throws NOT_A_MEMBER when `botId` is not one of them. */
export function assertMember(board: ProjectBoard, workstreams: Workstream[], botId: string): string[] {
  const members = botMembers(board, workstreams);
  if (!members.includes(botId)) {
    throw new ContextError('NOT_A_MEMBER', `Bot "${botId}" is not a member of project ${board.projectId}`, {
      botId,
      projectId: board.projectId,
    });
  }
  return members;
}

/** Segment 1 text: the owner, then each bot member with the first line of its persona as role. */
export function renderTeam(board: ProjectBoard, members: string[], personaOf: (botId: string) => string | undefined): string {
  return renderCommon([
    { id: board.owner, kind: 'human', role: 'owner' },
    ...members.map(id => ({ id, kind: 'bot' as const, role: firstLine(personaOf(id) ?? '') })),
  ]);
}

/** Workspace of a bot that has none yet: it starts at the latest seq and has seen no board version (spec 5.2). */
export function defaultWorkspace(projectId: string, botId: string, latestSeq: number): Workspace {
  return {
    projectId,
    botId,
    notes: '',
    pinnedNotes: [],
    condensed: '',
    seenItemIds: [],
    lastSeenSeq: latestSeq,
    lastSeenBoardVersion: 0,
    promotionsThisTurn: 0,
  };
}

export function defaultMemory(botId: string): EmployeeMemory {
  return { botId, persona: '', skills: [], memories: [], condensed: '' };
}
