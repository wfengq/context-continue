import type { Policy } from '../runner.js';
import type { Group } from '../types.js';
import { broadcastPolicy } from './broadcast.js';
import { singleAgentPolicy } from './single.js';

export interface PolicyOptions {
  /** Group E: assumed context window in tokens. */
  window: number;
  /** Group E: compact when history exceeds window × compactRatio. */
  compactRatio: number;
  /** Group E: size of the summary that replaces compacted history. */
  summaryTokens: number;
}

export function createPolicy(group: Group, _opts: PolicyOptions): Policy {
  switch (group) {
    case 'A':
      return singleAgentPolicy();
    case 'B':
      return broadcastPolicy();
    default:
      throw new Error(`group ${group} is not implemented yet`);
  }
}
