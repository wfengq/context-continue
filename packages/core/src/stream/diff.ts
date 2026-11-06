// Item-level updates of a bot's own segments (spec 2026-11-06 §2.3): memory, notes and projection
// are compared item by item, from the structured items the brief renders (render.ts), never by
// parsing text. What changed since this stream last showed the segment is appended under its
// heading and part (workstream): new items as the brief shows them, changed items in full (a
// multi-line item is appended whole), and a removal as one `no longer: …` line. A "(seen)" form of
// an item already shown is no change; an item leaving the Recent window or trimmed to fit the
// budget is no removal; reordering is no change; equal items are counted (a multiset).
import type { ItemGroup, ItemPart, ShownItem } from '../render.js';

/** An item as this stream last showed it: its key and its text in full. */
export type KnownItem = [key: string, full: string];

export interface KnownGroup {
  heading: string;
  leaves: ItemGroup['leaves'];
  /** For a `roll` group: every item shown since the snapshot, oldest first (what left the window stays known). */
  items: KnownItem[];
}

export interface KnownPart {
  part: string | null;
  groups: KnownGroup[];
}

/** What a snapshot shows: every item of every part, as known. */
export function knownOf(parts: readonly ItemPart[]): KnownPart[] {
  return parts.map(p => ({
    part: p.part,
    groups: p.groups.map(g => ({ heading: g.heading, leaves: g.leaves, items: g.items.map((x): KnownItem => [x.key, x.full]) })),
  }));
}

/** How a removed item is named: its first line when it starts with its id (`- [id] …`), else its whole text. */
function gone(full: string): string {
  return `no longer: ${full.startsWith('- [') ? full.split('\n')[0]! : full}`;
}

/** Items with the same key, in order, paired by occurrence: the n-th `k` now is the n-th `k` known. */
function multiset(known: readonly KnownItem[], now: readonly ShownItem[], retract: boolean): { lines: string[]; known: KnownItem[] } {
  const before = new Map<string, string[]>();
  for (const [k, f] of known) before.set(k, [...(before.get(k) ?? []), f]);
  const used = new Map<string, number>();
  const lines: string[] = [];
  for (const x of now) {
    const n = used.get(x.key) ?? 0;
    used.set(x.key, n + 1);
    const was = before.get(x.key)?.[n];
    if (was === undefined) lines.push(x.text);
    else if (was !== x.full) lines.push(x.full);
  }
  if (retract) {
    const seen = new Map<string, number>();
    for (const [k, f] of known) {
      const n = seen.get(k) ?? 0;
      seen.set(k, n + 1);
      if (n >= (used.get(k) ?? 0)) lines.push(gone(f));
    }
  }
  return { lines, known: now.map((x): KnownItem => [x.key, x.full]) };
}

/**
 * A window over an append-only list (Recent notes and memories, possibly trimmed to the budget):
 * the window now is a run of what is known followed by new items. The longest start of the window
 * that equals the end of what is known is matched (so an equal item written again counts as new);
 * when nothing matches, items are matched by key as a multiset. Nothing that left is retracted.
 */
function rolling(known: readonly KnownItem[], now: readonly ShownItem[]): { lines: string[]; known: KnownItem[] } {
  const k = known.map((x): KnownItem => [x[0], x[1]]);
  let m = Math.min(k.length, now.length);
  while (m > 0 && !now.slice(0, m).every((x, i) => x.key === k[k.length - m + i]![0])) m--;
  const lines: string[] = [];
  const fresh: ShownItem[] = [];
  if (m > 0 || now.length === 0) {
    now.forEach((x, i) => {
      if (i >= m) return void fresh.push(x);
      const at = k.length - m + i;
      if (k[at]![1] !== x.full) {
        lines.push(x.full);
        k[at] = [x.key, x.full];
      }
    });
  } else {
    const at = new Map<string, number[]>();
    k.forEach(([key], i) => at.set(key, [...(at.get(key) ?? []), i]));
    const used = new Map<string, number>();
    for (const x of now) {
      const n = used.get(x.key) ?? 0;
      used.set(x.key, n + 1);
      const i = at.get(x.key)?.[n];
      if (i === undefined) fresh.push(x);
      else if (k[i]![1] !== x.full) {
        lines.push(x.full);
        k[i] = [x.key, x.full];
      }
    }
  }
  lines.push(...fresh.map(x => x.text));
  return { lines, known: [...k, ...fresh.map((x): KnownItem => [x.key, x.full])] };
}

function groupUpdate(known: KnownGroup | undefined, now: ItemGroup | undefined): { lines: string[]; known: KnownGroup | null } {
  const heading = (now ?? known)!.heading;
  const leaves = (now ?? known)!.leaves;
  const items = now?.items ?? [];
  const r = leaves === 'roll' ? rolling(known?.items ?? [], items) : multiset(known?.items ?? [], items, leaves === 'retract');
  return { lines: r.lines, known: r.known.length > 0 ? { heading, leaves, items: r.known } : null };
}

const partKey = (p: string | null) => (p === null ? '' : `part:${p}`);

/**
 * The `<title> — updates` text for one own segment since `known`, or null when nothing worth
 * appending changed; and what the stream knows after it. Grouped by part (in the order the brief
 * shows them, then parts that are gone), then by heading: a part's head lines under `(part <id>)`,
 * other items under `<heading> (part <id>)`. A part that is gone says `no longer: <its workstream
 * line>` once, not item by item.
 */
export function sectionUpdate(title: string, known: readonly KnownPart[], now: readonly ItemPart[]): { text: string | null; known: KnownPart[] } {
  const blocks: string[] = [];
  const next: KnownPart[] = [];
  const knownParts = new Map(known.map(p => [partKey(p.part), p]));
  const nowParts = new Set(now.map(p => partKey(p.part)));
  const emit = (part: string | null, heading: string, lines: string[]) => {
    if (lines.length === 0) return;
    const suffix = part === null ? '' : ` (part ${part})`;
    const head = heading === '' ? (part === null ? [] : [`(part ${part})`]) : [`${heading}${suffix}`];
    blocks.push([...head, ...lines].join('\n'));
  };
  for (const p of now) {
    const kp = knownParts.get(partKey(p.part));
    const kGroups = new Map((kp?.groups ?? []).map(g => [g.heading, g]));
    const headings = [...new Set([...p.groups.map(g => g.heading), ...(kp?.groups ?? []).map(g => g.heading)])];
    const nGroups = new Map(p.groups.map(g => [g.heading, g]));
    const groups: KnownGroup[] = [];
    for (const h of headings) {
      const r = groupUpdate(kGroups.get(h), nGroups.get(h));
      emit(p.part, h, r.lines);
      if (r.known !== null) groups.push(r.known);
    }
    next.push({ part: p.part, groups });
  }
  for (const kp of known) {
    if (nowParts.has(partKey(kp.part)) || kp.part === null) continue;
    const line = kp.groups.find(g => g.heading === '')?.items.find(([k]) => k === 'line');
    if (line) emit(kp.part, '', [gone(line[1])]);
  }
  return { text: blocks.length > 0 ? [`${title} — updates`, ...blocks].join('\n\n') : null, known: next };
}
