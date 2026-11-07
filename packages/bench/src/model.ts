import type { ModelUsage, ToolCall } from './types.js';

export interface ModelRequest {
  botId: string;
  segments: { text: string; cacheable: boolean }[];
  /** The step's scripted output for a scripted request; null for an extra request. */
  scripted: { reply: string; ops: ToolCall[] } | null;
}

export interface Model {
  /** `usage` is what a real model's provider reports; fake models leave it out. */
  complete(r: ModelRequest): Promise<{ reply: string; ops: ToolCall[]; usage?: ModelUsage }>;
}

/** Fake model: replays the script, and answers every extra request with `idleReply`. */
export class ScriptedModel implements Model {
  constructor(private readonly idleReply: string) {}

  async complete(r: ModelRequest): Promise<{ reply: string; ops: ToolCall[] }> {
    return r.scripted ?? { reply: this.idleReply, ops: [] };
  }
}
