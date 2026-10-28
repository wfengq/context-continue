import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { sqliteStore } from '../src/store/sqlite.js';
import { runStoreContract } from './store.contract.js';

runStoreContract('sqlite', async () => sqliteStore(':memory:'));

test('data survives reopening a file database', async () => {
  const file = join(mkdtempSync(join(tmpdir(), 'cc-')), 'db.sqlite');
  const a = sqliteStore(file);
  await a.append({
    id: 'e1',
    projectId: 'p1',
    createdAt: 1,
    author: { kind: 'human', id: 'alice' },
    body: { type: 'chat', text: 'persist me', mentions: [], hops: 0 },
  });
  a.close();
  const b = sqliteStore(file);
  expect((await b.read('p1', 1))[0]!.body).toMatchObject({ text: 'persist me' });
  expect(await b.search('p1', 'persist')).toHaveLength(1);
  b.close();
});
