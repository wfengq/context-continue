import { ContextError } from './errors.js';
import { exportMemoryMarkdown } from './markdown.js';
import type { Store } from './store/store.js';
import type { EmployeeMemory } from './types.js';

export interface EmployeeProfile {
  botId: string;
  persona: string;
  skills: string[];
}

export interface EmployeeRegistry {
  /** Creates the employee if absent; otherwise updates persona and skills only (memories are untouched). */
  upsert(e: EmployeeProfile): Promise<void>;
  get(botId: string): Promise<EmployeeMemory | null>;
  roster(): Promise<EmployeeProfile[]>;
  /** The employee's memory as Markdown for people to read and delete from (spec 2.4). Throws NOT_FOUND for an unknown bot. */
  exportMarkdown(botId: string): Promise<string>;
}

export function createEmployeeRegistry(deps: { store: Store }): EmployeeRegistry {
  const { store } = deps;
  return {
    async upsert(e) {
      const existing = await store.getMemory(e.botId);
      const next: EmployeeMemory = existing
        ? { ...existing, persona: e.persona, skills: [...e.skills] }
        : { botId: e.botId, persona: e.persona, skills: [...e.skills], memories: [], condensed: '' };
      await store.saveMemory(next);
    },
    get: botId => store.getMemory(botId),
    async exportMarkdown(botId) {
      const m = await store.getMemory(botId);
      if (!m) throw new ContextError('NOT_FOUND', `Employee "${botId}" not found`);
      return exportMemoryMarkdown(m);
    },
    async roster() {
      const all = await store.listMemories();
      return all.map(m => ({ botId: m.botId, persona: m.persona, skills: [...m.skills] }));
    },
  };
}
