import type { ModelUsage, ToolCall } from './types.js';

export interface ModelRequest {
  botId: string;
  segments: { text: string; cacheable: boolean }[];
  /** The step's scripted output for a scripted request; null for an extra request. */
  scripted: { reply: string; ops: ToolCall[] } | null;
  /** Output cap for this request; defaults to the adapter's `maxTokens`. */
  maxTokens?: number;
  /** What the request is for (default 'probe'). A failed 'replay' request never counts toward a stop. */
  purpose?: 'probe' | 'replay';
}

export interface Model {
  /** `usage` is what a real model's provider reports; fake models leave it out. */
  complete(r: ModelRequest): Promise<{ reply: string; ops: ToolCall[]; usage?: ModelUsage }>;
}

/**
 * A failed model request that was still billed (a refusal, a malformed 200 body): `usage` is what the
 * provider reported, so a cost guard can count it.
 */
export class ProbeModelError extends Error {
  constructor(message: string, readonly usage?: ModelUsage) {
    super(message);
  }
}

/** Fake model: replays the script, and answers every extra request with `idleReply`. */
export class ScriptedModel implements Model {
  constructor(private readonly idleReply: string) {}

  async complete(r: ModelRequest): Promise<{ reply: string; ops: ToolCall[] }> {
    return r.scripted ?? { reply: this.idleReply, ops: [] };
  }
}
