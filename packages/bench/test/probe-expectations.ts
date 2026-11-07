import { containsTerm } from '../src/probe.js';
import { stepText } from '../src/scenario.js';
import type { Scenario } from '../src/types.js';

/**
 * Everything wrong with the probes of a scenario's facts, as readable strings (empty when fine):
 * a fact without a probe; an empty question or expect; no expect in its step's text (at least one
 * must be there, the others may be synonyms); an expect that contains the marker or is in the
 * question; a change-* question that does not end "Give only the current value."; a reject in the
 * text of a later step.
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
    if (!p.expect.some(e => containsTerm(text, e))) out.push(`${f.id}: no expect string is in step ${f.step}`);
    if (f.id.startsWith('change-') && !p.question.endsWith('Give only the current value.')) out.push(`${f.id}: a change question must end "Give only the current value."`);
    for (const e of p.expect) {
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
