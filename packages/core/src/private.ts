// Writes to the private layers (spec 2.3, 2.4): workspace notes and employee memories, each
// condensed when over budget (R19). On a failed condense the original content is kept, the new
// paragraph or memory is still saved, and `condenseAborted` is emitted.
import { condenseSegments, type CondenseFn } from './condense.js';
import type { EmployeeRegistry } from './employees.js';
import type { CoreEvents } from './events.js';
import { newId } from './ids.js';
import { defaultMemory, defaultWorkspace } from './members.js';
import type { Options } from './options.js';
import { splitParagraphs } from './render.js';
import type { Store } from './store/store.js';
import type { EmployeeMemory, Workspace } from './types.js';

export interface PrivateDeps {
  store: Store;
  projectId: string;
  employees: EmployeeRegistry;
  options: Required<Options>;
  count: (s: string) => number;
  now: () => number;
  condense?: CondenseFn;
  aborted: (e: CoreEvents['condenseAborted']) => void;
}

/** Appends a paragraph to the bot's notes (or a pinned note) and condenses; one save. */
export async function appendNote(deps: PrivateDeps, botId: string, text: string, pinned: boolean): Promise<void> {
  const { store, projectId, options } = deps;
  const prev = (await store.getWorkspace(projectId, botId)) ?? defaultWorkspace(projectId, botId, await store.latestSeq(projectId));
  const next: Workspace = pinned
    ? { ...prev, pinnedNotes: [...prev.pinnedNotes, text] }
    : { ...prev, notes: prev.notes.trim() === '' ? text : `${prev.notes}\n\n${text}` };
  const recent = splitParagraphs(next.notes);
  const r = await condenseSegments(
    { pinned: next.pinnedNotes, condensed: next.condensed, recent },
    { maxTokens: options.notesMaxTokens, recentKeep: options.recentKeep, count: deps.count, condense: deps.condense },
  );
  if (r.ok && (r.state.recent.length !== recent.length || r.state.condensed !== next.condensed)) {
    next.notes = r.state.recent.join('\n\n');
    next.condensed = r.state.condensed;
  }
  await store.saveWorkspace(next);
  if (!r.ok) deps.aborted({ target: 'notes', botId, reason: r.reason });
}

/** Adds retro memories to the bot's own long-term memory (tagged with this project) and condenses; one save. */
export async function addMemories(deps: PrivateDeps, botId: string, memories: { text: string; pinned?: boolean }[]): Promise<void> {
  const prev: EmployeeMemory = (await deps.employees.get(botId)) ?? defaultMemory(botId);
  const now = deps.now();
  const added = memories.map(m => ({ id: newId('m'), text: m.text, fromProject: deps.projectId, createdAt: now, pinned: m.pinned ?? false }));
  const next: EmployeeMemory = { ...prev, memories: [...prev.memories, ...added] };
  const recent = next.memories.filter(m => !m.pinned);
  const r = await condenseSegments(
    { pinned: next.memories.filter(m => m.pinned).map(m => m.text), condensed: next.condensed, recent: recent.map(m => m.text) },
    { maxTokens: deps.options.memoryMaxTokens, recentKeep: deps.options.recentKeep, count: deps.count, condense: deps.condense },
  );
  if (r.ok && (r.state.recent.length !== recent.length || r.state.condensed !== next.condensed)) {
    // condensing keeps the newest non-pinned memories; the evicted ones now live in the summary
    const keep = new Set(recent.slice(recent.length - r.state.recent.length).map(m => m.id));
    next.memories = next.memories.filter(m => m.pinned || keep.has(m.id));
    next.condensed = r.state.condensed;
  }
  await deps.store.saveMemory(next);
  if (!r.ok) deps.aborted({ target: 'memory', botId, reason: r.reason });
}
