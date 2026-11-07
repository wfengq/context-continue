import type { PublicBoardSwitches } from '@context-continue/core';
import type { Policy } from '../runner.js';
import type { Group } from '../types.js';
import { broadcastPolicy } from './broadcast.js';
import { delmPolicy } from './delm.js';
import { dsBotPolicy } from './dsbot.js';
import { projectPolicy } from './project.js';
import { singleAgentPolicy } from './single.js';
import { spacePolicy } from './space.js';

export interface PolicyOptions {
  /** Group E: assumed context window in tokens. */
  window: number;
  /** Group E: compact when history exceeds window × compactRatio. */
  compactRatio: number;
  /** Group E: size of the summary that replaces compacted history. */
  summaryTokens: number;
  /** Group C: which optional public-board sections the core renders (default none). */
  publicBoard?: PublicBoardSwitches;
  /** Group C: the `--c-stream on` prototype (append-only, scope-routed request text); absent means off. */
  stream?: { restreamTokens: number; own?: boolean };
  /** Group C: the core library's stream mode (`--c-stream core` / `auto`); absent means the plain core methods. */
  coreStream?: { mode: 'on' | 'auto'; restreamTokens: number; autoAfterEntries?: number };
}

export function createPolicy(group: Group, opts: PolicyOptions): Policy {
  switch (group) {
    case 'A':
      return singleAgentPolicy();
    case 'B':
      return broadcastPolicy();
    case 'C':
      return projectPolicy({
        ...(opts.publicBoard === undefined ? {} : { publicBoard: opts.publicBoard }),
        ...(opts.stream === undefined ? {} : { stream: opts.stream }),
        ...(opts.coreStream === undefined ? {} : { coreStream: opts.coreStream }),
      });
    case 'D':
      return delmPolicy();
    case 'E':
      return dsBotPolicy(opts);
    case 'F':
      return spacePolicy();
    default:
      throw new Error(`group ${group} is not implemented yet`);
  }
}
