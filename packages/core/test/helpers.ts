// Shared test fixtures. `seedProject` writes straight through a memoryStore (no facade);
// `makeProject` drives a project only through `createProject`.
import { applyOp } from '../src/board/apply.js';
import type { BriefDeps } from '../src/brief.js';
import type { Clock } from '../src/clock.js';
import { createEmployeeRegistry, type EmployeeRegistry } from '../src/employees.js';
import type { CoreEvents } from '../src/events.js';
import { resolveOptions, type Options } from '../src/options.js';
import type { PlanInput } from '../src/plan/validate.js';
import { createProject, type Project, type ProjectConfig } from '../src/project.js';
import { toLedgerEntry } from '../src/route.js';
import { memoryStore } from '../src/store/memory.js';
import type { Store } from '../src/store/store.js';
import { defaultCountTokens } from '../src/tokens.js';
import type {
  AppliedOp,
  BoardOp,
  ChatInput,
  Contract,
  Decision,
  LedgerEntry,
  ProjectBoard,
  ProjectEvent,
  ToolDefinition,
  Workstream,
} from '../src/types.js';
import { localWorkstreamSource, type WorkstreamSource } from '../src/workstreams/source.js';

export const PERSONAS: Record<string, string> = {
  pm: 'Project lead\nKeeps the team on track.',
  art: 'Pixel artist\nDraws sprites and tiles.',
  logic: 'Gameplay programmer\nWrites the game rules.',
  audio: 'Sound designer\nMakes music and effects.',
};

export const TEST_TOOLS: ToolDefinition[] = [
  { name: 'getBoardItem', description: 'Fetch a board item in full', parameters: { type: 'object' } },
];

const ws = (id: string, title: string, owner: string, over: Partial<Workstream> = {}): Workstream => ({
  id,
  title,
  brief: `Brief for ${title}.`,
  owner,
  dependsOn: [],
  writeScopes: [],
  status: 'active',
  reviewRounds: 0,
  deliverables: [],
  ...over,
});

export interface SeededProject {
  store: Store;
  projectId: string;
  source: WorkstreamSource;
  employees: EmployeeRegistry;
  deps: BriefDeps;
  /** Fixed clock: every call advances by one second. */
  now: () => number;
  chat(input: ChatInput): Promise<LedgerEntry>;
  event(event: ProjectEvent, by?: string): Promise<LedgerEntry>;
  /** Applies ops as one board change (version + 1) and returns the touched ids. */
  apply(ops: BoardOp[], by?: string, authority?: 'human' | 'bot'): Promise<string[]>;
  /** Adds a human decision and returns its id. */
  decide(d: { affects: string[]; text: string; rationale?: string; rejected?: string[] }): Promise<string>;
  /** Directly edits the board as one change without ops (for fixture shaping). */
  patchBoard(fn: (b: ProjectBoard) => void): Promise<void>;
}

export async function seedProject(opts: { plan?: boolean } = {}): Promise<SeededProject> {
  const store = memoryStore();
  const projectId = 'p1';
  let t = 1_700_000_000_000;
  const now = () => (t += 1000);
  const employees = createEmployeeRegistry({ store });
  for (const botId of ['pm', 'art', 'logic', 'audio']) {
    await employees.upsert({ botId, persona: PERSONAS[botId]!, skills: [] });
  }
  const source = localWorkstreamSource(store, { now });

  const board: ProjectBoard = {
    projectId,
    version: 0,
    updatedAt: now(),
    status: 'active',
    owner: 'alice',
    lead: 'pm',
    goal: 'Ship a tiny platformer demo.',
    constraints: ['Runs in the browser'],
    planStatus: 'none',
    conventions: [],
    workstreams: [],
    contracts: [],
    decisions: [],
    facts: [],
    failures: [],
    openQuestions: [],
  };
  await store.createBoard(board);

  const append = (e: Omit<LedgerEntry, 'seq' | 'id' | 'createdAt' | 'projectId'>) =>
    store.append({ ...e, id: `e-${t}`, projectId, createdAt: now() });

  const event = (ev: ProjectEvent, by = 'system') => append({ author: { kind: 'system', id: by }, body: { type: 'event', event: ev } });
  await event({ kind: 'projectStarted' });

  const saveChange = async (next: ProjectBoard, ops: AppliedOp[]) => {
    const expected = next.version;
    next.version = expected + 1;
    next.updatedAt = now();
    await store.saveBoard(next, expected, { version: next.version, mergedAt: next.updatedAt, ops });
  };

  if (opts.plan !== false) {
    const b = await store.getBoard(projectId);
    b.planStatus = 'approved';
    b.workstreams = [
      ws('art', 'Sprites', 'art'),
      ws('audio', 'Sound', 'audio'),
      ws('logic', 'Gameplay', 'logic', { status: 'pending', dependsOn: ['art'] }),
    ];
    const contract: Contract = { id: 'c1', from: 'art', to: 'logic', spec: 'PNG sprite sheets, 16x16 tiles', version: 1 };
    b.contracts = [contract];
    await saveChange(
      b,
      b.workstreams.map(w => ({
        op: { op: 'setWorkstreamStatus', id: w.id, status: w.status },
        by: 'system',
        authority: 'bot',
        touched: [w.id],
      })),
    );
    await event({ kind: 'planApproved', proposalId: 'plan-1' });
  }

  const deps: BriefDeps = {
    store,
    projectId,
    source,
    employees,
    count: defaultCountTokens,
    options: resolveOptions(),
    tools: () => TEST_TOOLS,
  };

  const apply = async (ops: BoardOp[], by = 'alice', authority: 'human' | 'bot' = 'human') => {
    let b = await store.getBoard(projectId);
    const applied: AppliedOp[] = [];
    for (const op of ops) {
      const r = applyOp(b, op, { by, authority });
      b = r.board;
      applied.push({ op, by, authority, touched: r.touched });
    }
    await saveChange(b, applied);
    return applied.flatMap(a => a.touched);
  };

  return {
    store,
    projectId,
    source,
    employees,
    deps,
    now,
    chat: async input => {
      let parent: LedgerEntry | null = null;
      if (input.replyTo) parent = (await store.read(projectId, 1)).find(e => e.id === input.replyTo) ?? null;
      return append(toLedgerEntry(input, parent));
    },
    event,
    apply,
    async decide(d) {
      const decision: Omit<Decision, 'id' | 'authority'> = {
        text: d.text,
        rationale: d.rationale ?? 'because',
        rejected: d.rejected ?? [],
        affects: d.affects,
        source: { entryIds: [], by: 'alice' },
      };
      const [id] = await apply([{ op: 'addDecision', decision }]);
      return id!;
    },
    async patchBoard(fn) {
      const b = await store.getBoard(projectId);
      fn(b);
      await saveChange(b, []);
    },
  };
}

// ---------------------------------------------------------------------------
// Facade fixture (Task 12): a project driven only through createProject.
// ---------------------------------------------------------------------------

export interface FakeClock extends Clock {
  /** Moves time forward and runs every timer that falls due, in due order. */
  advance(ms: number): void;
  /** Number of timers scheduled and not yet run or cleared. */
  pendingTimers(): number;
}

export function fakeClock(start = 1_700_000_000_000): FakeClock {
  let t = start;
  let nextId = 1;
  const timers = new Map<number, { at: number; fn: () => void }>();
  return {
    now: () => t,
    setTimeout(fn, ms) {
      const id = nextId++;
      timers.set(id, { at: t + ms, fn });
      return id;
    },
    clearTimeout(h) {
      timers.delete(h as number);
    },
    advance(ms) {
      const until = t + ms;
      for (;;) {
        const due = [...timers.entries()].filter(([, x]) => x.at <= until).sort((a, b) => a[1].at - b[1].at || a[0] - b[0]);
        const first = due[0];
        if (!first) break;
        timers.delete(first[0]);
        t = Math.max(t, first[1].at);
        first[1].fn();
      }
      t = until;
    },
    pendingTimers: () => timers.size,
  };
}

/** The fixture plan: art and audio have no dependencies; logic depends on art; one contract art -> logic. */
export const FIXTURE_PLAN: PlanInput = {
  workstreams: [
    { id: 'art', title: 'Sprites', brief: 'Draw the sprites.', owner: 'art', dependsOn: [] },
    { id: 'audio', title: 'Sound', brief: 'Make the sound.', owner: 'audio', dependsOn: [] },
    { id: 'logic', title: 'Gameplay', brief: 'Write the rules.', owner: 'logic', dependsOn: ['art'] },
  ],
  contracts: [{ id: 'c1', from: 'art', to: 'logic', spec: 'PNG sprite sheets, 16x16 tiles' }],
};

export type RecordedEvent = { [K in keyof CoreEvents]: { kind: K; e: CoreEvents[K] } }[keyof CoreEvents];

export interface FacadeProject {
  p: Project;
  store: Store;
  clock: FakeClock;
  employees: EmployeeRegistry;
  projectId: string;
  /** Every event the project emitted, in order. */
  events: RecordedEvent[];
  eventsOf<K extends keyof CoreEvents>(kind: K): CoreEvents[K][];
  /** Id of the approved plan proposal when `approved: true`. */
  planId?: string;
}

const EVENT_KINDS: (keyof CoreEvents)[] = [
  'boardChanged',
  'wake',
  'merged',
  'needsHuman',
  'extractFailed',
  'wakeLimitReached',
  'writeScopeOverlap',
  'condenseAborted',
];

export async function makeProject(
  opts: {
    approved?: boolean;
    store?: Store;
    options?: Options;
    workstreams?: WorkstreamSource;
    models?: ProjectConfig['models'];
    countTokens?: (s: string) => number;
  } = {},
): Promise<FacadeProject> {
  const store = opts.store ?? memoryStore();
  const projectId = 'p1';
  const clock = fakeClock();
  const employees = createEmployeeRegistry({ store });
  for (const botId of ['pm', 'art', 'logic', 'audio']) {
    await employees.upsert({ botId, persona: PERSONAS[botId]!, skills: [] });
  }
  const p = createProject({
    projectId,
    store,
    employees,
    clock,
    options: opts.options,
    workstreams: opts.workstreams,
    models: opts.models,
    countTokens: opts.countTokens,
  });
  const events: RecordedEvent[] = [];
  for (const kind of EVENT_KINDS) p.on(kind, e => events.push({ kind, e } as RecordedEvent));

  const fx: FacadeProject = {
    p,
    store,
    clock,
    employees,
    projectId,
    events,
    eventsOf: <K extends keyof CoreEvents>(kind: K) =>
      events.filter(x => x.kind === kind).map(x => x.e as CoreEvents[K]),
  };
  if (opts.approved) {
    await p.start({ goal: 'Ship a tiny platformer demo.', constraints: ['Runs in the browser'], lead: 'pm', by: 'alice' });
    const { proposalId } = await p.proposePlan(FIXTURE_PLAN, { by: 'pm' });
    await p.approvePlan(proposalId, { by: 'alice' });
    fx.planId = proposalId;
  }
  return fx;
}
