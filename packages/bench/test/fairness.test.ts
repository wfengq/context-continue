import { describe, expect, test } from 'vitest';
import { ScriptedModel, type ModelRequest } from '../src/model.js';
import { createPolicy } from '../src/policies/index.js';
import { runScenario } from '../src/runner.js';
import { validateScenario } from '../src/scenario.js';
import type { CallRecord, Group } from '../src/types.js';

const ws = (id: string, owner: string) => ({ id, title: id, brief: `do ${id}`, owner, dependsOn: [] as string[] });
const defaults = { window: 128000, compactRatio: 0.8, summaryTokens: 1500 };

const REQUIREMENT = 'Requirement change: the bird must be blue.';
const CONTENT = 'SOUND-CONTENT-v1 eight beeps and a jingle';
const HUMAN_STEP = 1;
const REVIEW_STEP = 4;

/** Replan adds a workstream, an unmentioned human requirement change, then a review of the new workstream. */
const fair = () => validateScenario({
  id: 'fair', goal: 'Build a tiny game', constraints: ['Runs in the browser'], owner: 'human', lead: 'pm',
  employees: [
    { botId: 'pm', persona: 'Lead', skills: [] },
    { botId: 'art', persona: 'Artist', skills: [] },
    { botId: 'logic', persona: 'Coder', skills: [] },
  ],
  plan: { workstreams: [ws('art', 'art'), ws('logic', 'logic')], contracts: [] },
  steps: [
    { kind: 'work', botId: 'art', workstreamId: 'art', reply: 'Drew sprites.', ops: [{ name: 'submitDeliverable', args: { workstreamId: 'art', summary: 'sprites', content: 'ART-CONTENT-v1' } }] },
    { kind: 'human', text: REQUIREMENT },
    { kind: 'replan', plan: { workstreams: [ws('art', 'art'), ws('logic', 'logic'), ws('sound', 'logic')], contracts: [] } },
    { kind: 'work', botId: 'logic', workstreamId: 'sound', reply: 'Made beeps.', ops: [{ name: 'submitDeliverable', args: { workstreamId: 'sound', summary: 'beeps', content: CONTENT } }] },
    { kind: 'review', deliverableOf: 'sound', passed: true, notes: 'Good.' },
  ],
});

async function run(group: Group): Promise<{ records: CallRecord[]; seen: ModelRequest[] }> {
  const seen: ModelRequest[] = [];
  const inner = new ScriptedModel('Noted.');
  const model = { complete: async (r: ModelRequest) => (seen.push(r), inner.complete(r)) };
  const { records } = await runScenario(fair(), createPolicy(group, defaults), { model });
  return { records, seen }; // records[i] and seen[i] are the same request
}

const text = (r: ModelRequest) => r.segments.map(s => s.text).join('\n');
const reviewer = (g: Group) => (g === 'A' ? 'solo' : 'pm');

describe('cross-group fairness: the reviewer sees the deliverable and the requirement change', () => {
  for (const g of ['A', 'B', 'C', 'D', 'E', 'F'] as Group[]) {
    test(`${g}: the review request carries the deliverable (C, D, E: a reference to it)`, async () => {
      const { records, seen } = await run(g);
      const i = records.findIndex(r => r.step === REVIEW_STEP && r.kind === 'scripted');
      expect(records[i]!.botId).toBe(reviewer(g));
      const review = text(seen[i]!);
      switch (g) {
        case 'A':
        case 'B':
        case 'F':
          expect(review).toContain(CONTENT);
          break;
        case 'C':
          // the core's delta names the submitted deliverable by id; content is fetched with getDeliverable
          expect(review).toMatch(/\[deliverableSubmitted\] \{"workstreamId":"sound","deliverableId":"dlv-[0-9a-f]{8}"\}/);
          expect(review).not.toContain(CONTENT);
          break;
        case 'D':
          expect(review).toContain('[deliverable sound v1 ref]');
          expect(review).not.toContain(CONTENT);
          break;
        case 'E':
          // DS Bot keeps deliverables in the author's private history (R-B21); the reviewer sees the
          // author's room message and its own task naming the workstream — the weakest reference.
          expect(review).toContain('[bot logic] Made beeps.');
          expect(review).toContain('review the deliverable of sound');
          expect(review).not.toContain(CONTENT);
          break;
      }
    });

    test(`${g}: the unmentioned requirement change reaches the reviewer between the message and the review`, async () => {
      // No ruling exempts any group: R-B20 puts it on F's project page; C's host delivers the routed message.
      const { records, seen } = await run(g);
      const mine = records
        .map((r, i) => ({ r, req: seen[i]! }))
        .filter(x => x.r.botId === reviewer(g) && x.r.step >= HUMAN_STEP && x.r.step <= REVIEW_STEP);
      expect(mine.length).toBeGreaterThan(0);
      expect(mine.some(x => text(x.req).includes(REQUIREMENT))).toBe(true);
    });
  }
});
