import { ContextError } from '../errors.js';
import { newId } from '../ids.js';
import type { BoardOp, Item, ProjectBoard } from '../types.js';

export interface ApplyMeta {
  by: string;
  authority: 'human' | 'bot';
}

export interface ArchivedItem {
  section: string;
  item: unknown;
}

export interface ApplyResult {
  board: ProjectBoard;
  touched: string[];
  archived: ArchivedItem[];
}

type SupersedeSection = 'conventions' | 'decisions' | 'facts' | 'failures';

const ID_PREFIX = {
  conventions: 'cv',
  openQuestions: 'q',
  facts: 'f',
  decisions: 'd',
  failures: 'x',
} as const;

function invalid(message: string, op: BoardOp): never {
  throw new ContextError('INVALID_OP', message, { op });
}

/**
 * Apply one op to a board. Pure: the input is never modified. Does not touch
 * `version` or `updatedAt`; the merger owns those.
 */
export function applyOp(board: ProjectBoard, op: BoardOp, meta: ApplyMeta): ApplyResult {
  const next = structuredClone(board);
  const touched: string[] = [];
  const archived: ArchivedItem[] = [];
  const authority = meta.authority;

  switch (op.op) {
    case 'add': {
      const created: Item = { ...structuredClone(op.item), id: newId(ID_PREFIX[op.section]), authority };
      next[op.section].push(created);
      touched.push(created.id);
      break;
    }
    case 'addFact': {
      const created = { ...structuredClone(op.fact), id: newId(ID_PREFIX.facts), authority };
      next.facts.push(created);
      touched.push(created.id);
      break;
    }
    case 'addDecision': {
      const created = { ...structuredClone(op.decision), id: newId(ID_PREFIX.decisions), authority };
      next.decisions.push(created);
      touched.push(created.id);
      break;
    }
    case 'addFailure': {
      const created = { ...structuredClone(op.failure), id: newId(ID_PREFIX.failures), authority };
      next.failures.push(created);
      touched.push(created.id);
      break;
    }
    case 'supersede': {
      const section: SupersedeSection = op.section;
      const list: Item[] = next[section];
      const index = list.findIndex((i) => i.id === op.id);
      const old = list[index];
      if (!old) invalid(`Cannot supersede unknown ${section} item "${op.id}"`, op);
      // The new item inherits type-specific fields (rationale, rejected, affects, reason)
      // from the old one unless the op's item supplies its own.
      const created = {
        ...structuredClone(old),
        ...structuredClone(op.item),
        id: newId(ID_PREFIX[section]),
        authority,
        supersedes: old.id,
      };
      list[index] = created;
      archived.push({ section, item: old });
      touched.push(created.id, old.id);
      break;
    }
    case 'closeQuestion': {
      const index = next.openQuestions.findIndex((q) => q.id === op.id);
      const [closed] = next.openQuestions.splice(index, 1);
      if (!closed) invalid(`Cannot close unknown open question "${op.id}"`, op);
      archived.push({ section: 'openQuestions', item: closed });
      break;
    }
    case 'setWorkstreamStatus': {
      const w = next.workstreams.find((x) => x.id === op.id);
      if (!w) invalid(`Unknown workstream "${op.id}"`, op);
      w.status = op.status;
      touched.push(w.id);
      break;
    }
    case 'addDeliverable': {
      const w = next.workstreams.find((x) => x.id === op.workstreamId);
      if (!w) invalid(`Unknown workstream "${op.workstreamId}"`, op);
      w.deliverables.push({
        id: newId('dlv'),
        summary: op.summary,
        ref: op.ref,
        version: w.deliverables.length + 1,
      });
      touched.push(w.id);
      break;
    }
    case 'updateContract': {
      const c = next.contracts.find((x) => x.id === op.id);
      if (!c) invalid(`Unknown contract "${op.id}"`, op);
      c.spec = op.spec;
      c.version += 1;
      touched.push(c.id);
      break;
    }
    case 'setGoal':
      next.goal = op.goal;
      break;
    case 'setConstraints':
      next.constraints = [...op.constraints];
      break;
  }

  return { board: next, touched, archived };
}
