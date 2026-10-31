import { randomUUID } from 'node:crypto';

/** Makes a new id with the given prefix (e.g. `e`, `prop`, `dlv`). */
export type IdGenerator = (prefix: string) => string;

/** The default generator: `<prefix>-<8 random hex chars>`. */
export function newId(prefix: string): string {
  return `${prefix}-${randomUUID().slice(0, 8)}`;
}
