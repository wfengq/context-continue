import { BASE_TEMPLATE, type Policy, type RunContext, type Segment } from '../runner.js';
import { fmtBot, fmtHuman, fmtOps, fmtTask } from '../text.js';

interface BotView {
  /** What this bot has read so far: group transcript lines plus its own private task lines, in order. */
  lines: string[];
  /** How many group transcript lines are already in `lines`. */
  synced: number;
  /** Length of `lines` at its previous request; those lines are the cacheable part of the next one. */
  prevLen: number;
}

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
  const views = new Map<string, BotView>();
  const versions = new Map<string, number>();

  const viewOf = (botId: string): BotView => {
    let v = views.get(botId);
    if (!v) {
      v = { lines: [], synced: 0, prevLen: 0 };
      views.set(botId, v);
    }
    return v;
  };

  const request = (ctx: RunContext, botId: string, step: number, kind: 'scripted' | 'extra', task: string | null) => {
    const v = viewOf(botId);
    v.lines.push(...transcript.slice(v.synced));
    v.synced = transcript.length;
    if (task !== null) v.lines.push(task);
    const segments: Segment[] = [
      { text: BASE_TEMPLATE, cacheable: true },
      ...v.lines.map((text, i) => ({ text, cacheable: i < v.prevLen })),
    ];
    v.prevLen = v.lines.length;
    return ctx.call({ botId, step, kind, segments });
  };

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
