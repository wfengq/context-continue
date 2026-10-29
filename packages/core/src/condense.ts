// Three-region condensing (spec section 2.3.1): pinned items | rolling summary | last K raw segments.
// Pure: no I/O. The result is only ever a new state or a failure; nothing is written here, so
// "backup then replace" is guaranteed by the caller keeping its original until `ok: true`.

export type CondenseFn = (input: { pinned: string[]; condensed: string; evicted: string[] }) => Promise<string>;

export interface CondenseState {
  pinned: string[];
  condensed: string;
  recent: string[];
}

export type CondenseResult = { ok: true; state: CondenseState } | { ok: false; reason: string };

/** Fixed instruction text (no variables) for hosts to place at the very front of the prompt. */
export const CONDENSE_INSTRUCTION =
  'You maintain a rolling summary of working notes. You are given the pinned items, the existing summary, ' +
  'and a list of older segments that are being evicted. Merge the evicted segments into the existing summary ' +
  'and reply with the new summary only. Keep durable facts, decisions and open threads; drop chatter, ' +
  'greetings and anything superseded. Never restate pinned items; they are kept separately and verbatim. ' +
  'Keep the summary as short as possible.';

/** Size of the whole content: pinned, then the summary (when non-empty), then recent, joined with '\n\n'. */
function totalTokens(s: CondenseState, count: (t: string) => number): number {
  const parts = [...s.pinned, ...(s.condensed === '' ? [] : [s.condensed]), ...s.recent];
  return count(parts.join('\n\n'));
}

export async function condenseSegments(
  state: CondenseState,
  deps: { maxTokens: number; recentKeep: number; count: (s: string) => number; condense?: CondenseFn },
): Promise<CondenseResult> {
  const { maxTokens, count, condense } = deps;
  if (totalTokens(state, count) <= maxTokens) return { ok: true, state };

  // Snapshots: neither a misbehaving condense function nor the caller's later mutation can alter what we verify.
  const pinned = [...state.pinned];
  const original = { pinned, condensed: state.condensed, recent: [...state.recent] };
  if (count(pinned.join('\n\n')) > maxTokens) {
    return { ok: false, reason: 'pinned items alone exceed the token budget' };
  }

  const startKeep = Math.min(Math.max(1, Math.floor(deps.recentKeep)), original.recent.length);
  for (let keep = startKeep; keep >= 1; keep--) {
    const evicted = original.recent.slice(0, original.recent.length - keep);
    if (evicted.length === 0) continue; // nothing to evict at this K; a smaller K may help

    let condensed = original.condensed;
    if (condense) {
      let out: unknown;
      try {
        out = await condense({ pinned: [...pinned], condensed: original.condensed, evicted: [...evicted] });
      } catch (e) {
        return { ok: false, reason: `condense failed: ${e instanceof Error ? e.message : String(e)}` };
      }
      if (typeof out !== 'string' || out.trim() === '') {
        return { ok: false, reason: 'condense returned an empty or non-string summary' };
      }
      condensed = out;
    }

    const next: CondenseState = { pinned: [...pinned], condensed, recent: original.recent.slice(-keep) };
    const pinnedIntact = next.pinned.length === pinned.length && next.pinned.every((p, i) => p === pinned[i]);
    if (pinnedIntact && totalTokens(next, count) <= maxTokens) return { ok: true, state: next };
  }
  return { ok: false, reason: 'content still exceeds the token budget with recentKeep reduced to 1' };
}
