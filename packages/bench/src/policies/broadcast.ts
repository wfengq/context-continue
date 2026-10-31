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
 * Group B (Grok Bot style): the group chat is the shared context. Every message, human or bot, is
 * read by the bots it reaches (a human message with mentions wakes only the mentioned bots; all
 * other messages reach every other bot). Each read is an extra request unless merged into the bot's
 * own next scripted step. Each request carries the whole transcript; the cacheable part is exactly
 * the bot's previous request, everything appended since is new.
 *
 * Extra requests answer with `idleReply`. That reply is a bot message in the transcript (later
 * requests read it) but it does NOT wake anyone: otherwise idle replies would trigger reads forever.
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
      const out = await request(ctx, botId, index, 'extra', null);
      transcript.push(fmtBot(botId, out.reply)); // visible to later reads, wakes nobody
    }
  };

  return {
    group: 'B',
    async onStep(step, index, ctx) {
      const everyone = ctx.scenario.employees.map(e => e.botId);
      if (step.kind === 'human') {
        transcript.push(fmtHuman(ctx.scenario.owner, step.text));
        const mentioned = step.mentions;
        const targets = mentioned && mentioned.length > 0 ? everyone.filter(b => mentioned.includes(b)) : everyone;
        await wake(ctx, index, targets);
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
