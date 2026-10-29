// Markdown export for people (design spec 2.4, 6.1): to read the project board, and to review or
// delete an employee's long-term memories. Pure and deterministic: no clock, no locale formatting.
import type { Contract, Decision, EmployeeMemory, Fact, Failure, Item, ProjectBoard, Workstream } from './types.js';

const NONE = '(none)';

/** Indents continuation lines so multi-line text stays inside its list item. */
const indent = (text: string): string => text.replace(/\r?\n/g, '\n  ');

const section = (heading: string, lines: string[]): string[] => [`## ${heading}`, '', ...(lines.length > 0 ? lines : [NONE]), ''];

const origin = (x: Item): string => `${x.source.by}, ${x.authority}`;

function itemLine(x: Item): string {
  return `- [${x.id}] ${indent(x.text)} (${origin(x)})`;
}

function decisionBlock(d: Decision): string[] {
  const lines = [`- [${d.id}] ${indent(d.text)} (${origin(d)})`, `  - Rationale: ${indent(d.rationale)}`];
  lines.push(...(d.rejected.length > 0 ? ['  - Rejected:', ...d.rejected.map(r => `    - ${r}`)] : ['  - Rejected: (none)']));
  lines.push(`  - Affects: ${d.affects.join(', ')}`);
  return lines;
}

function factBlock(f: Fact): string[] {
  return [itemLine(f), `  - Affects: ${f.affects.join(', ')}`];
}

function failureBlock(f: Failure): string[] {
  return [itemLine(f), `  - Why it failed: ${indent(f.reason)}`, `  - Affects: ${f.affects.join(', ')}`];
}

function contractLine(c: Contract): string {
  return `- [${c.id}] v${c.version}, ${c.from} -> ${c.to}: ${indent(c.spec)}`;
}

function workstreamBlock(w: Workstream): string[] {
  const lines = [`- [${w.id}] ${w.title} (owner: ${w.owner}, status: ${w.status})`, `  - Brief: ${indent(w.brief)}`];
  if (w.dependsOn.length > 0) lines.push(`  - Depends on: ${w.dependsOn.join(', ')}`);
  if (w.writeScopes.length > 0) lines.push(`  - Write scopes: ${w.writeScopes.join(', ')}`);
  lines.push(`  - Review rounds: ${w.reviewRounds}`);
  for (const d of w.deliverables) lines.push(`  - Deliverable ${d.id} v${d.version}: ${indent(d.summary)} (ref: ${d.ref})`);
  return lines;
}

/** Every section of the project board, in board order. Decisions carry their rationale and rejected options. */
export function exportMarkdown(board: ProjectBoard, workstreams: Workstream[]): string {
  return [
    `# Project ${board.projectId}`,
    '',
    `- Status: ${board.status}`,
    `- Owner: ${board.owner}`,
    `- Lead: ${board.lead}`,
    `- Plan: ${board.planStatus}`,
    `- Board version: ${board.version}`,
    '',
    ...section('Goal', board.goal.trim().length > 0 ? [board.goal] : []),
    ...section('Constraints', board.constraints.map(c => `- ${indent(c)}`)),
    ...section('Conventions', board.conventions.map(itemLine)),
    ...section('Workstreams', workstreams.flatMap(workstreamBlock)),
    ...section('Contracts', board.contracts.map(contractLine)),
    ...section('Decisions', board.decisions.flatMap(decisionBlock)),
    ...section('Facts', board.facts.flatMap(factBlock)),
    ...section('Failures', board.failures.flatMap(failureBlock)),
    ...section('Open questions', board.openQuestions.map(itemLine)),
  ]
    .join('\n')
    .trimEnd()
    .concat('\n');
}

function memoryLine(m: EmployeeMemory['memories'][number]): string {
  return `- [${m.id}] ${indent(m.text)} (from project ${m.fromProject}, ${new Date(m.createdAt).toISOString()})`;
}

/** An employee's persona, skills, pinned memories, rolling summary and every memory with its source project. */
export function exportMemoryMarkdown(m: EmployeeMemory): string {
  return [
    `# Employee memory: ${m.botId}`,
    '',
    ...section('Persona', m.persona.trim().length > 0 ? [m.persona] : []),
    ...section('Skills', m.skills.map(s => `- ${s}`)),
    ...section('Pinned memories', m.memories.filter(x => x.pinned).map(memoryLine)),
    ...section('Summary', m.condensed.trim().length > 0 ? [m.condensed] : []),
    ...section('Memories', m.memories.filter(x => !x.pinned).map(memoryLine)),
  ]
    .join('\n')
    .trimEnd()
    .concat('\n');
}
