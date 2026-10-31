import { BASE_TEMPLATE, type Policy, type RunContext, type Segment } from '../runner.js';
import { fmtBot, fmtHuman, fmtOps, fmtTask } from '../text.js';

interface BotView {
  /** The bot's own append-only history: log entries it has read, plus its private task lines, in order. */
  lines: string[];
  /** Read cursor: how many shared-log entries are already in `lines`. */
  cursor: number;
  /** Length of `lines` at its previous request; those lines are the cacheable part of the next one. */
  prevLen: number;
}

/**
 * Group D (DeLM style): no lead and no routing. All activity goes into one shared log: human
 * messages, scripted bot replies, tool lines and deliverables in reference form
 * (`[deliverable <ws> v<n> ref]`). Each bot has a read cursor; whenever it makes a request, every
 * log entry after its cursor (no relevance filter) is appended to its own history and the cursor
 * moves to the end.
 *
 * The spec's "already-seen items shown compactly" applies to task-board items. In this text-log
 * simulation it is realized by the reference form for deliverables plus never re-sending entries a
 * bot has already read (the cursor).
 *
 * Wakes: a human message with mentions wakes the mentioned bots; without mentions it wakes every
 * bot. Bot messages wake nobody (DeLM agents read the board when they act). A wake is an extra
 * request unless merged into the bot's own next scripted step; it is answered with `idleReply`,
 * which is a pass (R-B10): never posted to the log. Task trigger lines are private to the requester.
 */
export function delmPolicy(): Policy {
  const log: string[] = [];
  const views = new Map<string, BotView>();
  const versions = new Map<string, number>();

  const viewOf = (botId: string): BotView => {
    let v = views.get(botId);
    if (!v) {
      v = { lines: [], cursor: 0, prevLen: 0 };
      views.set(botId, v);
    }
    return v;
  };

  const request = (ctx: RunContext, botId: string, step: number, kind: 'scripted' | 'extra', task: string | null) => {
    const v = viewOf(botId);
    v.lines.push(...log.slice(v.cursor));
    v.cursor = log.length;
    if (task !== null) v.lines.push(task);
    const segments: Segment[] = [
      { text: BASE_TEMPLATE, cacheable: true },
      ...v.lines.map((text, i) => ({ text, cacheable: i < v.prevLen })),
    ];
    v.prevLen = v.lines.length;
    return ctx.call({ botId, step, kind, segments });
  };

  return {
    group: 'D',
    async onStep(step, index, ctx) {
      if (step.kind === 'human') {
        log.push(fmtHuman(ctx.scenario.owner, step.text));
        const everyone = ctx.scenario.employees.map(e => e.botId);
        const mentioned = step.mentions;
        const targets = mentioned && mentioned.length > 0 ? everyone.filter(b => mentioned.includes(b)) : everyone;
        for (const botId of targets) {
          if (ctx.isMerged(botId, index)) continue;
          await request(ctx, botId, index, 'extra', null); // idle reply = pass, not posted (R-B10)
        }
        return;
      }
      const actor = ctx.actorOf(step);
      const out = await request(ctx, actor, index, 'scripted', fmtTask(actor, step));
      log.push(fmtBot(actor, out.reply), ...fmtOps(actor, out.ops, versions, true));
    },
    async finish() {
      return { compactions: 0, pauses: 0, coreErrors: 0 };
    },
  };
}
