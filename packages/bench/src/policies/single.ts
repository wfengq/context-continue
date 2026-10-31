import { BASE_TEMPLATE, type Policy, type Segment } from '../runner.js';
import { fmtBot, fmtHuman, fmtOps, fmtTask } from '../text.js';

const SOLO = 'solo';

/**
 * Group A: one agent performs every work, review and replan step. Its history only grows; each
 * request is [template, the lines of its previous request (cacheable), every line added since (not cacheable)].
 * Human messages are appended to the history without a request.
 */
export function singleAgentPolicy(): Policy {
  const history: string[] = [];
  let seen = 0; // history lines that were part of the previous request
  const versions = new Map<string, number>();

  return {
    group: 'A',
    async onStep(step, index, ctx) {
      if (step.kind === 'human') {
        history.push(fmtHuman(ctx.scenario.owner, step.text));
        return;
      }
      history.push(fmtTask(SOLO, step));
      // Cacheable part = exactly this bot's previous request (template + the lines it sent then).
      // Lines added after that request (its reply, tool results, deliverables, human messages) are uncached.
      const segments: Segment[] = [
        { text: BASE_TEMPLATE, cacheable: true },
        ...history.map((text, i) => ({ text, cacheable: i < seen })),
      ];
      seen = history.length;
      const out = await ctx.call({ botId: SOLO, step: index, kind: 'scripted', segments });
      history.push(fmtBot(SOLO, out.reply), ...fmtOps(SOLO, out.ops, versions, false));
    },
    async finish() {
      return { compactions: 0, pauses: 0, coreErrors: 0 };
    },
  };
}
