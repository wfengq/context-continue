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

/**
 * Persistence interface (design spec 6.3 plus the extensions the core library needs).
 * All reads return deep copies; callers may freely mutate what they get back.
 */
export interface Store {
  // Ledger
  /** Assigns the next seq of the project (starting at 1) and stores the entry. */
  append(entry: Omit<LedgerEntry, 'seq'>): Promise<LedgerEntry>;
  /** Entries with seq >= fromSeq, in seq order. */
  read(projectId: string, fromSeq: number, limit?: number): Promise<LedgerEntry[]>;
  /** Case-insensitive match on chat text and on `archived` events' ref; other entries are ignored. */
  search(projectId: string, query: string, limit?: number): Promise<LedgerEntry[]>;
  /** 0 for an unknown project. */
  latestSeq(projectId: string): Promise<number>;

  // Board
  /** Throws ContextError('INVALID_OP') if the board already exists. */
  createBoard(board: ProjectBoard): Promise<void>;
  /** Throws ContextError('NOT_FOUND') if the board does not exist. */
  getBoard(projectId: string): Promise<ProjectBoard>;
  /**
   * Writes the board and the change record together. Throws ContextError('STALE_VERSION')
   * when expectedVersion differs from the stored version (nothing is written).
   */
  saveBoard(board: ProjectBoard, expectedVersion: number, change: BoardChange): Promise<void>;
  /** Changes with version > sinceVersion, in version order. */
  getBoardChanges(projectId: string, sinceVersion: number): Promise<BoardChange[]>;

  // Proposals
  enqueueProposal(p: Proposal): Promise<void>;
  /** Returns the queued proposals in enqueue order and clears the queue. */
  drainProposals(projectId: string): Promise<Proposal[]>;
  savePlanProposal(p: PlanProposal): Promise<void>;
  getPlanProposal(id: string): Promise<PlanProposal | null>;
  savePending(p: PendingProposal): Promise<void>;
  /** Ordered by createdAt ascending. */
  listPending(projectId: string): Promise<PendingProposal[]>;
  deletePending(id: string): Promise<void>;

  // Private layers
  getWorkspace(projectId: string, botId: string): Promise<Workspace | null>;
  saveWorkspace(w: Workspace): Promise<void>;
  getMemory(botId: string): Promise<EmployeeMemory | null>;
  saveMemory(m: EmployeeMemory): Promise<void>;
  /** All employee memories (used for the staff directory). */
  listMemories(): Promise<EmployeeMemory[]>;

  // Deliverables
  /** Stores the content and returns its ref. */
  putDeliverable(projectId: string, content: string): Promise<string>;
  /** Throws ContextError('NOT_FOUND') for an unknown ref. */
  getDeliverable(projectId: string, ref: string): Promise<string>;

  // Project-level key/value
  getMeta<T>(projectId: string, key: string): Promise<T | null>;
  setMeta(projectId: string, key: string, value: unknown): Promise<void>;
}
