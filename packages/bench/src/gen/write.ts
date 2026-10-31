// Writes the generated long scenarios to packages/bench/scenarios/ (`pnpm gen:scenarios`).
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Scenario } from '../types.js';
import { generateLongApp } from './long-app.js';

/** A scenario as committed: JSON with 2-space indentation and a trailing newline. */
export function scenarioJson(s: Scenario): string {
  return `${JSON.stringify(s, null, 2)}\n`;
}

export function writeScenario(s: Scenario, path: string): void {
  writeFileSync(path, scenarioJson(s));
}

/** `scenarios/` at the package root; this module sits two levels below it in both `src/gen/` and `dist/gen/`. */
const SCENARIO_DIR = new URL('../../scenarios/', import.meta.url);

const isMain = process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  for (const s of [generateLongApp()]) {
    const path = fileURLToPath(new URL(`${s.id}.json`, SCENARIO_DIR));
    writeScenario(s, path);
    console.log(`wrote ${path} (${s.steps.length} steps, ${(s.facts ?? []).length} facts)`);
  }
}
