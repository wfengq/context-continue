// Per-bot stream state (spec 2026-11-06 §2.3), persisted in the store's project meta under
// `stream:<botId>`, so the memory and SQLite stores behave the same and a reopened project resumes
// each stream as an append rather than a garbled prefix.
import type { Store } from '../store/store.js';
import type { StreamSegmentKind } from '../types.js';

/** The project-wide board sections a stream carries, in render order. */
export const BOARD_SECTIONS = ['Goal', 'Constraints', 'Conventions', 'Contracts', 'Decisions', 'Failures', 'Workstreams'] as const;
export type BoardSection = (typeof BOARD_SECTIONS)[number];

/** The bot's own segments: whole in a snapshot, appended again whole when their text changes. */
export const OWN_KINDS = ['common', 'memory', 'workspace', 'projection'] as const;
export type OwnKind = (typeof OWN_KINDS)[number];

/** Ordered (key, rendered text) pairs: ids, not object keys, so the order never depends on what the ids look like. */
export type Shown = [key: string, text: string][];

export interface StreamState {
  version: 1;
  /** Every segment this stream returned (and the own outputs recorded since), in order; all cacheable. */
  segments: { kind: StreamSegmentKind; text: string }[];
  /** Tokens appended since the latest snapshot (that snapshot's own request part included). */
  appended: number;
  /** Per project-wide section: each item as last shown in this stream, by id (contracts render their version). */
  board: Record<BoardSection, Shown>;
  /** Retired contracts as last shown in this stream, by id. */
  retired: Shown;
  /** Seq of the newest human message this stream carries (0: none). */
  humanSeq: number;
  /** The latest text of each own segment in this stream. */
  own: Partial<Record<OwnKind, string>>;
}

export const streamKey = (botId: string) => `stream:${botId}`;

/** The bot's stream state, or null when it has none yet (or an unknown version: the next request is a snapshot). */
export async function loadStreamState(store: Store, projectId: string, botId: string): Promise<StreamState | null> {
  const s = await store.getMeta<StreamState>(projectId, streamKey(botId));
  return s !== null && s.version === 1 ? s : null;
}

export function saveStreamState(store: Store, projectId: string, botId: string, state: StreamState): Promise<void> {
  return store.setMeta(projectId, streamKey(botId), state);
}
