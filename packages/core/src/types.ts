// Types from design spec sections 2.1-2.5, plus the extra types the core library needs.

// ---------------------------------------------------------------------------
// 2.1 L0 project ledger
// ---------------------------------------------------------------------------

export interface LedgerEntry {
  id: string;
  projectId: string;
  seq: number; // monotonically increasing within a project
  createdAt: number;
  author: { kind: 'human' | 'bot' | 'system'; id: string };
  body:
    | {
        type: 'chat';
        text: string;
        mentions: string[];
        replyTo?: string;
        act?: SpeechAct; // required on bot messages; optional on human messages
        hops: number; // reply chain length: replied-to message's hops + 1, otherwise 0
      }
    | { type: 'event'; event: ProjectEvent };
}

// Speech acts: only request, query and propose expect a reply; inform, agree,
// refuse and done are terminal and should not be answered.
export type SpeechAct = 'request' | 'query' | 'propose' | 'inform' | 'agree' | 'refuse' | 'done';

export type ProjectEvent =
  | { kind: 'projectStarted' }
  | { kind: 'planProposed'; proposalId: string }
  | { kind: 'planApproved'; proposalId: string }
  | { kind: 'planRejected'; proposalId: string; feedback: string }
  | { kind: 'deliverableSubmitted'; workstreamId: string; deliverableId: string }
  | { kind: 'reviewPassed' | 'reviewFailed'; deliverableId: string; notes: string }
  | { kind: 'blocked'; workstreamId: string; reason: string }
  | { kind: 'boardMerged'; version: number }
  | { kind: 'archived'; what: string; ref: string }
  | { kind: 'projectClosed'; forced: boolean };

// ---------------------------------------------------------------------------
// 2.2 L1 project board
// ---------------------------------------------------------------------------

export interface ProjectBoard {
  projectId: string;
  version: number;
  updatedAt: number;
  status: 'active' | 'closed';
  owner: string; // project owner, i.e. the `by` of `start`; human-confirmed ops only accept this id
  lead: string; // lead bot
  goal: string;
  constraints: string[];
  planStatus: 'none' | 'draft' | 'approved';
  conventions: Item[]; // naming, style, format rules everyone follows
  workstreams: Workstream[];
  contracts: Contract[];
  /** Contracts a replan no longer contains (last version); absent on older boards. Not rendered. */
  retiredContracts?: Contract[];
  decisions: Decision[];
  facts: Fact[];
  failures: Failure[]; // approaches that were tried and did not work
  openQuestions: Item[];
}

export interface Item {
  id: string;
  text: string;
  source: { entryIds: string[]; by: string };
  supersedes?: string;
  authority: 'human' | 'bot'; // set by the core from the source; human wins on conflict
}

export interface Decision extends Item {
  rationale: string;
  rejected: string[]; // alternatives that were rejected
  affects: string[]; // affected workstream ids
}

export interface Fact extends Item {
  affects: string[];
}

export interface Failure extends Item {
  // text says what was tried
  reason: string; // why it does not work
  affects: string[];
}

export interface Workstream {
  id: string;
  title: string;
  brief: string;
  owner: string; // responsible bot (the lead may own workstreams too)
  dependsOn: string[];
  writeScopes: string[]; // planned path prefixes (may be empty); only used for overlap warnings
  status: 'pending' | 'active' | 'blocked' | 'delivered';
  reviewRounds: number;
  deliverables: { id: string; summary: string; ref: string; version: number }[];
}

export interface Contract {
  id: string;
  from: string; // providing workstream
  to: string; // consuming workstream
  spec: string; // what is delivered, in what format
  version: number;
}

// ---------------------------------------------------------------------------
// 2.3 L2a project workspace (per bot x project, private)
// ---------------------------------------------------------------------------

export interface Workspace {
  projectId: string;
  botId: string;
  notes: string; // working notes and draft points
  pinnedNotes: string[]; // pinned notes, untouched by condensing
  condensed: string; // rolling summary from three-part condensing
  seenItemIds: string[]; // board items shown in full in a brief and confirmed by a later tool call; later shown as id/title/status only
  /** Keys shown in full by the latest brief, moved to `seenItemIds` when the bot next calls a tool. Missing in old data: []. */
  pendingSeenItemIds?: string[];
  lastSeenSeq: number;
  lastSeenBoardVersion: number;
  promotionsThisTurn: number;
}

// ---------------------------------------------------------------------------
// 2.4 L2b employee long-term memory (per bot, cross-project)
// ---------------------------------------------------------------------------

export interface EmployeeMemory {
  botId: string;
  persona: string;
  skills: string[];
  memories: { id: string; text: string; fromProject: string; createdAt: number; pinned: boolean }[];
  condensed: string; // rolling summary from three-part condensing
}

// ---------------------------------------------------------------------------
// 2.5 Proposals
// ---------------------------------------------------------------------------

export interface PlanProposal {
  id: string;
  projectId: string;
  by: string; // lead bot
  workstreams: Omit<Workstream, 'status' | 'reviewRounds' | 'deliverables'>[];
  contracts: Omit<Contract, 'version'>[];
  status: 'pending' | 'approved' | 'rejected';
  rejectCount: number;
}

export interface Proposal {
  id: string;
  projectId: string;
  baseVersion: number;
  by: string; // botId, or 'extractor'
  ops: BoardOp[];
}

export type BoardOp =
  | { op: 'add'; section: 'conventions' | 'openQuestions'; item: Omit<Item, 'id' | 'authority'> }
  | { op: 'addFact'; fact: Omit<Fact, 'id' | 'authority'> } // promotion lands here too
  | { op: 'addDecision'; decision: Omit<Decision, 'id' | 'authority'> }
  | { op: 'addFailure'; failure: Omit<Failure, 'id' | 'authority'> } // promotion may land here too
  | {
      op: 'supersede';
      section: 'conventions' | 'decisions' | 'facts' | 'failures';
      id: string;
      // Type-specific fields are optional; omitted ones are inherited from the superseded item.
      item: Omit<Item, 'id' | 'authority'> & {
        rationale?: string;
        rejected?: string[];
        affects?: string[];
        reason?: string;
      };
    }
  | { op: 'closeQuestion'; id: string }
  | { op: 'setWorkstreamStatus'; id: string; status: Workstream['status'] }
  | { op: 'addDeliverable'; workstreamId: string; summary: string; ref: string }
  | { op: 'updateContract'; id: string; spec: string }
  | { op: 'setGoal'; goal: string }
  | { op: 'setConstraints'; constraints: string[] };

// ---------------------------------------------------------------------------
// Additional types used across the core library
// ---------------------------------------------------------------------------

/** One op as applied by a merge. `touched` lists ids of items added or modified, including workstream ids. */
export interface AppliedOp {
  op: BoardOp;
  by: string;
  authority: 'human' | 'bot';
  touched: string[];
}

/** Record of one merge, used to build the "board changes" digest. */
export interface BoardChange {
  version: number;
  mergedAt: number;
  ops: AppliedOp[];
}

export interface PendingProposal {
  id: string;
  projectId: string;
  proposalId: string;
  by: string;
  ops: BoardOp[];
  needs: 'lead' | 'human';
  createdAt: number;
}

export type WakeReason =
  | 'assigned'
  | 'upstreamDelivered'
  | 'decisionChanged'
  | 'contractChanged'
  | 'reviewFailed'
  | 'mentioned'
  | 'needsLead'
  | 'routed';

export interface Wake {
  botId: string;
  reason: WakeReason;
  detail?: string;
}

export type SegmentKind = 'common' | 'memory' | 'workspace' | 'board' | 'projection' | 'delta' | 'trigger';

export interface Segment {
  kind: SegmentKind;
  text: string;
  cacheable: boolean;
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>; // JSON Schema
}

export interface ContextBundle {
  segments: Segment[];
  tools: ToolDefinition[];
  stats: { bySegment: Partial<Record<SegmentKind, number>>; total: number };
}

/** Stream segments (spec 2026-11-06): the brief's kinds, plus appended project updates and the bot's own output. */
export type StreamSegmentKind = SegmentKind | 'updates' | 'own';

export interface StreamSegment {
  kind: StreamSegmentKind;
  text: string;
  cacheable: boolean;
}

/** What `buildStream` builds the request for; `brief` by default. */
export type StreamRequest = { kind: 'brief' } | { kind: 'review'; deliverableId: string } | { kind: 'planning' };

/**
 * A `buildStream` result. With the stream off it is the existing method's ContextBundle unchanged
 * (no `snapshot`); with it on, every segment is cacheable and `snapshot` says whether this request
 * started a new stream (true) or extended the previous one byte for byte (false).
 */
export interface StreamBundle {
  segments: StreamSegment[];
  tools: ToolDefinition[];
  stats: { bySegment: Partial<Record<StreamSegmentKind, number>>; total: number };
  snapshot?: boolean;
}

export interface ChatInput {
  author: { kind: 'human' | 'bot'; id: string };
  text: string;
  mentions?: string[];
  replyTo?: string;
  act?: SpeechAct;
}
