import { z } from 'zod';
import type { BoardOp } from '../types.js';

const str = z.string().min(1);
const source = z.object({ entryIds: z.array(str), by: str });
const baseItem = z.object({ text: str, source, supersedes: str.optional() });
const affects = z.array(str).min(1);
const SUPERSEDE_FIELDS = {
  conventions: [],
  decisions: ['rationale', 'rejected', 'affects'],
  facts: ['affects'],
  failures: ['reason', 'affects'],
} as const satisfies Record<string, readonly string[]>;

export const boardOpSchema = z.discriminatedUnion('op', [
  z.object({
    op: z.literal('add'),
    section: z.enum(['conventions', 'openQuestions']),
    item: baseItem,
  }),
  z.object({
    op: z.literal('addFact'),
    fact: baseItem.extend({ affects }),
  }),
  z.object({
    op: z.literal('addDecision'),
    decision: baseItem.extend({ rationale: str, rejected: z.array(str), affects }),
  }),
  z.object({
    op: z.literal('addFailure'),
    failure: baseItem.extend({ reason: str, affects }),
  }),
  z
    .object({
      op: z.literal('supersede'),
      section: z.enum(['conventions', 'decisions', 'facts', 'failures']),
      id: str,
      // Type-specific fields are optional here; omitted ones are inherited from the superseded item.
      item: baseItem.extend({
        rationale: str.optional(),
        rejected: z.array(str).optional(),
        affects: affects.optional(),
        reason: str.optional(),
      }),
    })
    .superRefine((val, ctx) => {
      const allowed: readonly string[] = SUPERSEDE_FIELDS[val.section];
      for (const key of ['rationale', 'rejected', 'affects', 'reason'] as const) {
        if (val.item[key] !== undefined && !allowed.includes(key)) {
          ctx.addIssue({
            code: 'custom',
            path: ['item', key],
            message: `"${key}" is not valid for section ${val.section}`,
          });
        }
      }
    }),
  z.object({ op: z.literal('closeQuestion'), id: str }),
  z.object({
    op: z.literal('setWorkstreamStatus'),
    id: str,
    status: z.enum(['pending', 'active', 'blocked', 'delivered']),
  }),
  z.object({ op: z.literal('addDeliverable'), workstreamId: str, summary: str, ref: str }),
  z.object({ op: z.literal('updateContract'), id: str, spec: str }),
  z.object({ op: z.literal('setGoal'), goal: str }),
  z.object({ op: z.literal('setConstraints'), constraints: z.array(str) }),
]) as unknown as z.ZodType<BoardOp>;

export function parseOps(raw: unknown[]): { ok: BoardOp[]; rejected: { index: number; reason: string }[] } {
  const ok: BoardOp[] = [];
  const rejected: { index: number; reason: string }[] = [];
  raw.forEach((value, index) => {
    const r = boardOpSchema.safeParse(value);
    if (r.success) {
      ok.push(r.data);
    } else {
      const reason = r.error.issues
        .map((i) => (i.path.length ? `${i.path.join('.')}: ${i.message}` : i.message))
        .join('; ');
      rejected.push({ index, reason });
    }
  });
  return { ok, rejected };
}
