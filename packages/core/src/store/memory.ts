import { ContextError } from '../errors.js';
import { newId as defaultNewId, type IdGenerator } from '../ids.js';
import type {
  BoardChange,
  EmployeeMemory,
  LedgerEntry,
  PendingProposal,
  PlanProposal,
  ProjectBoard,
  Proposal,
  Workspace,
} from '../types.js';
import type { Store } from './store.js';

const copy = <T>(v: T): T => structuredClone(v);

function searchableText(e: LedgerEntry): string | null {
  if (e.body.type === 'chat') return e.body.text;
  if (e.body.event.kind === 'archived') return e.body.event.ref;
  return null;
}

/** In-memory Store, used for tests and as the reference implementation of the contract. */
/** In-memory store; `newId` makes deliverable refs (default: random `newId`). */
export function memoryStore(opts: { newId?: IdGenerator } = {}): Store {
  const newId = opts.newId ?? defaultNewId;
  const ledgers = new Map<string, LedgerEntry[]>();
  const boards = new Map<string, ProjectBoard>();
  const changes = new Map<string, BoardChange[]>();
  const proposals = new Map<string, Proposal[]>();
  const plans = new Map<string, PlanProposal>();
  const pendings = new Map<string, PendingProposal>();
  const workspaces = new Map<string, Workspace>();
  const memories = new Map<string, EmployeeMemory>();
  const deliverables = new Map<string, string>();
  const meta = new Map<string, unknown>();

  const key = (a: string, b: string) => JSON.stringify([a, b]);

  return {
    async append(entry) {
      const list = ledgers.get(entry.projectId) ?? [];
      ledgers.set(entry.projectId, list);
      const stored: LedgerEntry = { ...copy(entry), seq: list.length + 1 };
      list.push(stored);
      return copy(stored);
    },
    async read(projectId, fromSeq, limit) {
      const out = (ledgers.get(projectId) ?? []).filter(e => e.seq >= fromSeq);
      return copy(limit === undefined ? out : out.slice(0, limit));
    },
    async search(projectId, query, limit) {
      const words = query.toLowerCase().split(/\s+/).filter(w => w !== '');
      if (words.length === 0) return [];
      const out: LedgerEntry[] = [];
      for (const e of ledgers.get(projectId) ?? []) {
        if (limit !== undefined && out.length >= limit) break;
        const text = searchableText(e);
        if (text === null) continue;
        const lower = text.toLowerCase();
        if (words.every(w => lower.includes(w))) out.push(e);
      }
      return copy(out);
    },
    async latestSeq(projectId) {
      return ledgers.get(projectId)?.length ?? 0;
    },

    async createBoard(board) {
      if (boards.has(board.projectId)) {
        throw new ContextError('INVALID_OP', `Board for project ${board.projectId} already exists`);
      }
      boards.set(board.projectId, copy(board));
    },
    async getBoard(projectId) {
      const b = boards.get(projectId);
      if (!b) throw new ContextError('NOT_FOUND', `No board for project ${projectId}`);
      return copy(b);
    },
    async saveBoard(board, expectedVersion, change) {
      const current = boards.get(board.projectId);
      if (!current) throw new ContextError('NOT_FOUND', `No board for project ${board.projectId}`);
      if (current.version !== expectedVersion) {
        throw new ContextError('STALE_VERSION', `Expected board version ${expectedVersion}, found ${current.version}`, {
          expected: expectedVersion,
          actual: current.version,
        });
      }
      boards.set(board.projectId, copy(board));
      const list = changes.get(board.projectId) ?? [];
      list.push(copy(change));
      changes.set(board.projectId, list);
    },
    async getBoardChanges(projectId, sinceVersion) {
      return copy((changes.get(projectId) ?? []).filter(c => c.version > sinceVersion));
    },

    async enqueueProposal(p) {
      const list = proposals.get(p.projectId) ?? [];
      list.push(copy(p));
      proposals.set(p.projectId, list);
    },
    async drainProposals(projectId) {
      const list = proposals.get(projectId) ?? [];
      proposals.delete(projectId);
      return list;
    },
    async savePlanProposal(p) {
      plans.set(p.id, copy(p));
    },
    async getPlanProposal(id) {
      const p = plans.get(id);
      return p ? copy(p) : null;
    },
    async savePending(p) {
      pendings.set(p.id, copy(p));
    },
    async listPending(projectId) {
      const out = [...pendings.values()].filter(p => p.projectId === projectId);
      out.sort((a, b) => a.createdAt - b.createdAt);
      return copy(out);
    },
    async deletePending(id) {
      pendings.delete(id);
    },

    async getWorkspace(projectId, botId) {
      const w = workspaces.get(key(projectId, botId));
      return w ? copy(w) : null;
    },
    async saveWorkspace(w) {
      workspaces.set(key(w.projectId, w.botId), copy(w));
    },
    async getMemory(botId) {
      const m = memories.get(botId);
      return m ? copy(m) : null;
    },
    async saveMemory(m) {
      memories.set(m.botId, copy(m));
    },
    async listMemories() {
      return copy([...memories.values()]);
    },

    async putDeliverable(projectId, content) {
      const ref = newId('del');
      deliverables.set(key(projectId, ref), content);
      return ref;
    },
    async getDeliverable(projectId, ref) {
      const c = deliverables.get(key(projectId, ref));
      if (c === undefined) throw new ContextError('NOT_FOUND', `No deliverable ${ref} in project ${projectId}`);
      return c;
    },

    async getMeta<T>(projectId: string, k: string) {
      const v = meta.get(key(projectId, k));
      return v === undefined ? null : (copy(v) as T);
    },
    async setMeta(projectId, k, value) {
      meta.set(key(projectId, k), copy(value));
    },
  };
}
