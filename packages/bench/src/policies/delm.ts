import type { Policy, RunContext } from '../runner.js';
import { fmtBot, fmtHuman, fmtOps, fmtTask } from '../text.js';
import { historyReader } from './history.js';

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
  const reader = historyReader();
  const versions = new Map<string, number>();

  const request = (ctx: RunContext, botId: string, step: number, kind: 'scripted' | 'extra', task: string | null) =>
    ctx.call({ botId, step, kind, segments: reader.segmentsFor(botId, log, task) });

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
