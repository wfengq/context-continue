import { containsTerm } from '../src/probe.js';
import { stepText } from '../src/scenario.js';
import type { Scenario } from '../src/types.js';

/**
 * Everything wrong with the probes of a scenario's facts, as readable strings (empty when fine):
 * a fact without a probe; an empty question or expect; an expect that is not in its step's text, that
 * contains the marker, or that is in the question; a reject in the text of a later step.
 * Matching is the grader's own `containsTerm`.
 */
export function probeProblems(s: Scenario): string[] {
  const out: string[] = [];
  const facts = s.facts ?? [];
  if (facts.length === 0) out.push('scenario has no facts');
  for (const f of facts) {
    const p = f.probe;
    if (p === undefined) {
      out.push(`${f.id}: no probe`);
      continue;
    }
    if (p.question.trim() === '') out.push(`${f.id}: empty question`);
    if (p.expect.length === 0 || p.expect.some(e => e.trim() === '')) out.push(`${f.id}: empty expect`);
    const text = stepText(s.steps[f.step]!);
    for (const e of p.expect) {
      if (!containsTerm(text, e)) out.push(`${f.id}: expect "${e}" is not in step ${f.step}`);
      if (containsTerm(e, f.marker)) out.push(`${f.id}: expect "${e}" contains the marker`);
      if (containsTerm(p.question, e)) out.push(`${f.id}: the question contains expect "${e}"`);
    }
    for (const r of p.reject ?? []) {
      s.steps.forEach((st, i) => {
        if (i > f.step && containsTerm(stepText(st), r)) out.push(`${f.id}: reject "${r}" occurs in later step ${i}`);
      });
    }
  }
  return out;
}
