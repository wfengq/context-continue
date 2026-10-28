import type { ProjectBoard } from '../types.js';
import type { ArchivedItem } from './apply.js';

/**
 * Keep the public part of the board within `maxTokens`. Eviction order: the oldest
 * bot-authored convention first, then the oldest open question. Goal, constraints,
 * workstreams and human conventions are never evicted. Pure: the input is not modified.
 */
export function enforceBoardSize(
  board: ProjectBoard,
  maxTokens: number,
  count: (s: string) => number,
  renderPublic: (b: ProjectBoard) => string,
): { board: ProjectBoard; archived: ArchivedItem[] } {
  const next = structuredClone(board);
  const archived: ArchivedItem[] = [];

  while (count(renderPublic(next)) > maxTokens) {
    const convIndex = next.conventions.findIndex((c) => c.authority === 'bot');
    if (convIndex >= 0) {
      const [evicted] = next.conventions.splice(convIndex, 1);
      archived.push({ section: 'conventions', item: evicted });
      continue;
    }
    const evicted = next.openQuestions.shift();
    if (!evicted) break;
    archived.push({ section: 'openQuestions', item: evicted });
  }

  return { board: next, archived };
}
