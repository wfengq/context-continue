import type { Step, ToolCall } from './types.js';

// Message formats shared by the history-based groups (A/B/D/E/F).

export const fmtHuman = (id: string, text: string): string => `[human ${id}] ${text}`;

export const fmtBot = (id: string, reply: string): string => `[bot ${id}] ${reply}`;

/** Tool result line. History groups do not check tool arguments, so every call succeeds. */
export const fmtTool = (botId: string, name: string): string => `[tool ${botId}] ${name}: ok`;

/** Full deliverable, or a reference only when `content` is null (group D). */
export const fmtDeliverable = (wsId: string, version: number, content: string | null): string =>
  content === null ? `[deliverable ${wsId} v${version} ref]` : `[deliverable ${wsId} v${version}] ${content}`;

/** The trigger line of a scripted request: what `botId` is asked to do at this step. */
export function fmtTask(botId: string, step: Step): string {
  switch (step.kind) {
    case 'work':
      return `[task ${botId}] work on workstream ${step.workstreamId}`;
    case 'review':
      return `[task ${botId}] review the deliverable of ${step.deliverableOf}`;
    case 'replan':
      return `[task ${botId}] replan`;
    case 'human':
      throw new Error('a human step has no task line');
  }
}

/** A `submitDeliverable` call's workstream and content, or null for any other call. */
export function deliverableIn(op: ToolCall): { workstreamId: string; content: string } | null {
  if (op.name !== 'submitDeliverable' || typeof op.args !== 'object' || op.args === null) return null;
  const { workstreamId, content } = op.args as Record<string, unknown>;
  return typeof workstreamId === 'string' && typeof content === 'string' ? { workstreamId, content } : null;
}

/**
 * History lines for a bot's tool calls: one tool result line per call, followed by the deliverable
 * line for each `submitDeliverable` (`versions` counts deliverables per workstream and is updated).
 */
export function fmtOps(botId: string, ops: ToolCall[], versions: Map<string, number>, refOnly: boolean): string[] {
  const lines: string[] = [];
  for (const op of ops) {
    lines.push(fmtTool(botId, op.name));
    const d = deliverableIn(op);
    if (d) {
      const v = (versions.get(d.workstreamId) ?? 0) + 1;
      versions.set(d.workstreamId, v);
      lines.push(fmtDeliverable(d.workstreamId, v, refOnly ? null : d.content));
    }
  }
  return lines;
}
