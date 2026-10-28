import type { BoardOp, Item, ProjectBoard } from '../types.js';

export type OpClass = 'auto' | 'lead' | 'human';

export interface ClassifyContext {
  /** Submitter of the proposal: a bot id, or 'extractor'. */
  by: string;
  /** The board's lead bot. */
  lead: string;
  /** True when the proposal comes from the extractor, i.e. from human chat. */
  isExtractor: boolean;
  /** Workstream ids owned by the submitter. */
  ownWorkstreams: string[];
  /** The board the op will be applied to. */
  board: ProjectBoard;
  /** Ids of items touched by other submitters since the proposal's baseVersion. */
  touchedByOthersSince: Set<string>;
}

/** Ids of existing items or workstreams an op modifies (new items have none yet). */
export function opTargets(op: BoardOp): string[] {
  switch (op.op) {
    case 'supersede':
    case 'closeQuestion':
    case 'setWorkstreamStatus':
    case 'updateContract':
      return [op.id];
    case 'addDeliverable':
      return [op.workstreamId];
    default:
      return [];
  }
}

/**
 * Classify one op per design spec section 3:
 * - human: setGoal, setConstraints (always, even for the lead);
 * - lead: ops on an item someone else modified since baseVersion, a bot superseding a
 *   human item, updateContract, addDecision whose affects reach beyond the submitter's
 *   own workstreams. The lead's own ops skip this class; extractor addDecision is a
 *   human decision and is auto, and the extractor is not a bot for the supersede rule;
 * - auto: everything else.
 */
export function classifyOp(op: BoardOp, ctx: ClassifyContext): OpClass {
  if (op.op === 'setGoal' || op.op === 'setConstraints') return 'human';
  if (ctx.by === ctx.lead) return 'auto';

  if (opTargets(op).some((id) => ctx.touchedByOthersSince.has(id))) return 'lead';

  switch (op.op) {
    case 'updateContract':
      return 'lead';
    case 'supersede': {
      if (ctx.isExtractor) return 'auto';
      const list: Item[] = ctx.board[op.section];
      const target = list.find((i) => i.id === op.id);
      return target?.authority === 'human' ? 'lead' : 'auto';
    }
    case 'addDecision': {
      if (ctx.isExtractor) return 'auto';
      const own = new Set(ctx.ownWorkstreams);
      return op.decision.affects.every((w) => own.has(w)) ? 'auto' : 'lead';
    }
    default:
      return 'auto';
  }
}
