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

/** True when `args` has the `submitDeliverable` shape `{ workstreamId, summary, content }` (all strings). */
export function isDeliverableArgs(args: unknown): args is { workstreamId: string; summary: string; content: string } {
  if (typeof args !== 'object' || args === null) return false;
  const a = args as Record<string, unknown>;
  return typeof a.workstreamId === 'string' && typeof a.summary === 'string' && typeof a.content === 'string';
}

/** A `submitDeliverable` call's workstream and content, or null for any other call; throws on malformed args. */
export function deliverableIn(op: ToolCall): { workstreamId: string; content: string } | null {
  if (op.name !== 'submitDeliverable') return null;
  if (!isDeliverableArgs(op.args)) throw new Error(`malformed submitDeliverable args: ${JSON.stringify(op.args)}`);
  return { workstreamId: op.args.workstreamId, content: op.args.content };
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
const rec = (v: unknown): Record<string, unknown> => (typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : {});

/**
 * A tool call's arguments in a compact field layout (R-L4; same style as group F's page entries):
 * readable `field: value` lines, no raw JSON. Null when the call has nothing to show
 * (`submitDeliverable`: its content is rendered as the deliverable line).
 */
export function fmtToolArgs(op: ToolCall): string | null {
  const a = rec(op.args);
  const join = (lines: string[]): string => lines.map(l => `  ${l}`).join('\n');
  switch (op.name) {
    case 'submitDeliverable':
      return null;
    case 'submitReview': {
      const conventions = strs(a.conventions);
      return join([
        `verdict: ${a.passed === true ? 'passed' : 'failed'}`,
        `notes: ${str(a.notes)}`,
        ...(conventions.length > 0 ? [`conventions: ${conventions.join('; ')}`] : []),
      ]);
    }
    case 'proposePlan': {
      const plan = rec(a.plan);
      const ws = Array.isArray(plan.workstreams) ? plan.workstreams.map(rec) : [];
      const cs = Array.isArray(plan.contracts) ? plan.contracts.map(rec) : [];
      return join([
        ...ws.map(w => `workstream ${str(w.id)} (${str(w.owner)}): ${str(w.brief)}`),
        ...cs.map(c => `contract ${str(c.id)} ${str(c.from)} -> ${str(c.to)}: ${str(c.spec)}`),
      ]);
    }
    case 'recordFailure':
      return join([`tried: ${str(a.text)}`, `why it failed: ${str(a.reason)}`, `affects: ${strs(a.affects).join(', ')}`]);
    case 'proposeDecision': {
      const rejected = strs(a.rejected);
      return join([
        `decision: ${str(a.text)}`,
        `why: ${str(a.rationale)}`,
        ...(rejected.length > 0 ? [`rejected: ${rejected.join('; ')}`] : []),
        `affects: ${strs(a.affects).join(', ')}`,
      ]);
    }
    case 'sendMessage':
      return join([`to: ${strs(a.mentions).join(', ') || 'all'}`, `act: ${str(a.act)}`, `text: ${str(a.text)}`]);
    case 'updateNotes':
      return join([`text: ${str(a.text)}`]);
    default: {
      const fields = Object.entries(a).filter((e): e is [string, string] => typeof e[1] === 'string').map(([k, v]) => `${k}: ${v}`);
      return fields.length > 0 ? join(fields) : null;
    }
  }
}

/** The text of every `sendMessage` call: a message posted to the project chat. */
export const messagesIn = (ops: ToolCall[]): string[] =>
  ops.filter(op => op.name === 'sendMessage').map(op => str(rec(op.args).text)).filter(t => t !== '');

/**
 * History lines for a bot's tool calls: one tool result line per call (followed by the call's
 * arguments unless `args` is false), then the deliverable line for each `submitDeliverable`
 * (`versions` counts deliverables per workstream and is updated).
 */
export function fmtOps(botId: string, ops: ToolCall[], versions: Map<string, number>, refOnly: boolean, args = true): string[] {
  const lines: string[] = [];
  for (const op of ops) {
    const shown = args ? fmtToolArgs(op) : null;
    lines.push(shown === null ? fmtTool(botId, op.name) : `${fmtTool(botId, op.name)}\n${shown}`);
    const d = deliverableIn(op);
    if (d) {
      const v = (versions.get(d.workstreamId) ?? 0) + 1;
      versions.set(d.workstreamId, v);
      lines.push(fmtDeliverable(d.workstreamId, v, refOnly ? null : d.content));
    }
  }
  return lines;
}
