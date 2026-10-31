import type { PlanInput } from '@context-continue/core';

export type Group = 'A' | 'B' | 'C' | 'D' | 'E' | 'F';

export interface ToolCall {
  name: string;
  args: unknown;
}

export type Step =
  | { kind: 'human'; text: string; mentions?: string[] }
  | { kind: 'work'; botId: string; workstreamId: string; reply: string; ops?: ToolCall[] }
  | { kind: 'review'; deliverableOf: string; passed: boolean; notes: string; conventions?: string[] }
  | { kind: 'replan'; plan: PlanInput };

export interface Scenario {
  id: string;
  goal: string;
  constraints: string[];
  owner: string;
  lead: string;
  employees: { botId: string; persona: string; skills: string[] }[];
  /** The core library's PlanInput; group A does not use it. */
  plan: PlanInput;
  /** Fixed reply for extra requests; defaults to "Noted.". */
  idleReply?: string;
  steps: Step[];
}

export interface CallRecord {
  group: Group;
  scenario: string;
  step: number;
  botId: string;
  kind: 'scripted' | 'extra';
  inputTokens: number;
  /** Always <= inputTokens. */
  cacheableTokens: number;
  segments?: { kind: string; tokens: number; cacheable: boolean }[];
}

export interface PolicyStats {
  compactions: number;
  pauses: number;
  coreErrors: number;
}
