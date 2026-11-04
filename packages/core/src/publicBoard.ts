// Optional sections of the public project board (spec 2026-11-04): the switches, their
// validation, and the view shared by every board segment (brief, planning, review, retro).
import { ContextError } from './errors.js';
import type { Store } from './store/store.js';
import type { LedgerEntry } from './types.js';

/** Which optional sections the public board shows. Every switch defaults to off. */
export type PublicBoardSwitches = { directives?: boolean; contracts?: boolean; failures?: boolean };

/** What `renderBoardPublic` needs beyond the board: the switches and the directives to show. */
export interface PublicBoardView {
  switches: Required<PublicBoardSwitches>;
  /** The newest `directivesKeep` human chat entries, oldest first. */
  directives: LedgerEntry[];
  /** How many older human chat entries were left out. */
  directivesOmitted: number;
}

const SWITCHES = ['directives', 'contracts', 'failures'] as const;

/** Defaults filled in; throws INVALID_OP for anything but a plain object of known boolean switches. */
export function resolvePublicBoard(p?: PublicBoardSwitches): Required<PublicBoardSwitches> {
  const resolved = { directives: false, contracts: false, failures: false };
  if (p === undefined) return resolved;
  if (typeof p !== 'object' || p === null || Array.isArray(p)) {
    throw new ContextError('INVALID_OP', `publicBoard must be an object of boolean switches, got ${String(p)}`);
  }
  for (const [key, v] of Object.entries(p)) {
    if (!(SWITCHES as readonly string[]).includes(key)) {
      throw new ContextError('INVALID_OP', `Unknown publicBoard switch "${key}"`);
    }
    if (v === undefined) continue;
    if (typeof v !== 'boolean') throw new ContextError('INVALID_OP', `publicBoard.${key} must be a boolean, got ${String(v)}`);
    resolved[key as (typeof SWITCHES)[number]] = v;
  }
  return resolved;
}

export const isHumanChat = (e: LedgerEntry): boolean => e.author.kind === 'human' && e.body.type === 'chat';

/**
 * The view for the board segment, or `undefined` when every switch is off (the base render).
 * Reads the ledger only when directives are on.
 */
export async function publicBoardView(
  store: Store,
  projectId: string,
  switches: Required<PublicBoardSwitches> | undefined,
  directivesKeep: number,
): Promise<PublicBoardView | undefined> {
  if (!switches || !(switches.directives || switches.contracts || switches.failures)) return undefined;
  let directives: LedgerEntry[] = [];
  let directivesOmitted = 0;
  if (switches.directives) {
    const all = (await store.read(projectId, 1)).filter(isHumanChat);
    const keep = Math.min(all.length, Math.max(0, Math.floor(directivesKeep)));
    directives = all.slice(all.length - keep);
    directivesOmitted = all.length - keep;
  }
  return { switches, directives, directivesOmitted };
}
