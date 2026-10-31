import type { Policy, RunContext } from '../runner.js';
import { fmtBot, fmtHuman, fmtOps, fmtTask } from '../text.js';
import { historyReader } from './history.js';

/**
 * Group B (Grok Bot style): the group chat is the shared context. Every message, human (mentioned
 * or not) or bot, is read by every other bot (R-B22), which decides itself whether to reply. Each
 * read is an extra request unless merged into the bot's own next scripted step. Each request carries the whole transcript; the cacheable part is exactly
 * the bot's previous request, everything appended since is new.
 *
 * Extra requests answer with `idleReply`. An idle reply is a pass (R-B10): it costs the request's
 * input tokens but is never posted to the transcript, so it wakes nobody and nobody reads it.
 * Task trigger lines are private to the requested bot and are not group messages.
 */
export function broadcastPolicy(): Policy {
  const transcript: string[] = [];
  const reader = historyReader();
  const versions = new Map<string, number>();

  const request = (ctx: RunContext, botId: string, step: number, kind: 'scripted' | 'extra', task: string | null) =>
    ctx.call({ botId, step, kind, segments: reader.segmentsFor(botId, transcript, task) });

  const wake = async (ctx: RunContext, index: number, targets: string[]): Promise<void> => {
    for (const botId of targets) {
      if (ctx.isMerged(botId, index)) continue;
      await request(ctx, botId, index, 'extra', null); // idle reply = pass, not posted (R-B10)
    }
  };

  return {
    group: 'B',
    async onStep(step, index, ctx) {
      const everyone = ctx.scenario.employees.map(e => e.botId);
      if (step.kind === 'human') {
        // Every message, mentioned or not, is read by every bot (R-B22, spec §5 B).
        transcript.push(fmtHuman(ctx.scenario.owner, step.text));
        await wake(ctx, index, everyone);
        return;
      }
      const actor = ctx.actorOf(step);
      const out = await request(ctx, actor, index, 'scripted', fmtTask(actor, step));
      transcript.push(fmtBot(actor, out.reply), ...fmtOps(actor, out.ops, versions, false));
      await wake(ctx, index, everyone.filter(b => b !== actor));
    },
    async finish() {
      return { compactions: 0, pauses: 0, coreErrors: 0 };
    },
  };
}
