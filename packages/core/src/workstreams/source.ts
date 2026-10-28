import { systemClock, type Clock } from '../clock.js';
import { ContextError } from '../errors.js';
import type { Store } from '../store/store.js';
import type { AppliedOp, ProjectBoard, Workstream } from '../types.js';

/** Design spec 6.4. */
export interface WorkstreamSource {
  list(
    projectId: string,
  ): Promise<Pick<Workstream, 'id' | 'title' | 'owner' | 'dependsOn' | 'writeScopes' | 'status'>[]>;
  /** Called after a plan is confirmed. */
  create(projectId: string, ws: Omit<Workstream, 'status' | 'reviewRounds' | 'deliverables'>[]): Promise<void>;
  setStatus(projectId: string, id: string, status: Workstream['status']): Promise<void>;
  /** Host-side changes notify the core to recompute wakes. Returns an unsubscribe function. */
  onChange(projectId: string, handler: (ids: string[]) => void): () => void;
}

const MAX_ATTEMPTS = 3;

const statusOp = (id: string, status: Workstream['status']): AppliedOp => ({
  op: { op: 'setWorkstreamStatus', id, status },
  by: 'system',
  authority: 'bot',
  touched: [id],
});

/** Default source: workstream state lives in the project board and is written through `saveBoard`. */
export function localWorkstreamSource(store: Store, clock: Pick<Clock, 'now'> = systemClock): WorkstreamSource {
  const handlers = new Map<string, Set<(ids: string[]) => void>>();

  const notify = (projectId: string, ids: string[]) => {
    for (const h of [...(handlers.get(projectId) ?? [])]) {
      try {
        h([...ids]);
      } catch {
        // a faulty subscriber must not affect the write or other subscribers
      }
    }
  };

  /** Read-modify-write with STALE_VERSION re-read-and-retry. */
  async function write(
    projectId: string,
    mutate: (board: ProjectBoard) => AppliedOp[],
  ): Promise<string[]> {
    for (let attempt = 1; ; attempt++) {
      const board = await store.getBoard(projectId);
      const ops = mutate(board);
      const version = board.version + 1;
      const mergedAt = clock.now();
      board.version = version;
      board.updatedAt = mergedAt;
      try {
        await store.saveBoard(board, version - 1, { version, mergedAt, ops });
      } catch (e) {
        if (e instanceof ContextError && e.code === 'STALE_VERSION' && attempt < MAX_ATTEMPTS) continue;
        throw e;
      }
      return ops.flatMap(o => o.touched);
    }
  }

  return {
    async list(projectId) {
      const board = await store.getBoard(projectId);
      return board.workstreams.map(w => ({
        id: w.id,
        title: w.title,
        owner: w.owner,
        dependsOn: [...w.dependsOn],
        writeScopes: [...w.writeScopes],
        status: w.status,
      }));
    },

    async create(projectId, list) {
      const ids = await write(projectId, board => {
        const existing = new Set(board.workstreams.map(w => w.id));
        for (const w of list) {
          if (existing.has(w.id)) {
            throw new ContextError('INVALID_OP', `Workstream "${w.id}" already exists`);
          }
          existing.add(w.id);
        }
        for (const w of list) {
          board.workstreams.push({
            ...structuredClone(w),
            writeScopes: [...(w.writeScopes ?? [])],
            status: 'pending',
            reviewRounds: 0,
            deliverables: [],
          });
        }
        return list.map(w => statusOp(w.id, 'pending'));
      });
      if (ids.length > 0) notify(projectId, ids);
    },

    async setStatus(projectId, id, status) {
      const ids = await write(projectId, board => {
        const w = board.workstreams.find(x => x.id === id);
        if (!w) throw new ContextError('NOT_FOUND', `Workstream "${id}" not found`);
        w.status = status;
        return [statusOp(id, status)];
      });
      notify(projectId, ids);
    },

    onChange(projectId, handler) {
      let set = handlers.get(projectId);
      if (!set) handlers.set(projectId, (set = new Set()));
      set.add(handler);
      return () => {
        set.delete(handler);
      };
    },
  };
}

/**
 * The source owns id, title, owner, dependencies, write scopes and status; brief, deliverables and
 * review rounds come from the board (defaults for workstreams the board has not seen).
 */
export async function resolveWorkstreams(board: ProjectBoard, source: WorkstreamSource): Promise<Workstream[]> {
  const saved = new Map(board.workstreams.map(w => [w.id, w]));
  const listed = await source.list(board.projectId);
  return listed.map(w => {
    const own = saved.get(w.id);
    return {
      id: w.id,
      title: w.title,
      brief: own?.brief ?? '',
      owner: w.owner,
      dependsOn: [...w.dependsOn],
      writeScopes: [...w.writeScopes],
      status: w.status,
      reviewRounds: own?.reviewRounds ?? 0,
      deliverables: structuredClone(own?.deliverables ?? []),
    };
  });
}
