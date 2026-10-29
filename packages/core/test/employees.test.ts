import { describe, expect, test } from 'vitest';
import { createEmployeeRegistry } from '../src/employees.js';
import { memoryStore } from '../src/store/memory.js';

describe('employees.deleteMemory (R36)', () => {
  test('removes one memory and keeps the rest; unknown bot or memory id is NOT_FOUND', async () => {
    const store = memoryStore();
    const employees = createEmployeeRegistry({ store });
    await employees.upsert({ botId: 'art', persona: 'Pixel artist', skills: [] });
    const m = (await store.getMemory('art'))!;
    await store.saveMemory({
      ...m,
      memories: [
        { id: 'm1', text: 'Wrong lesson', fromProject: 'p1', createdAt: 1, pinned: false },
        { id: 'm2', text: 'Right lesson', fromProject: 'p1', createdAt: 2, pinned: true },
      ],
    });
    await employees.deleteMemory('art', 'm1');
    expect((await employees.get('art'))!.memories.map(x => x.id)).toEqual(['m2']);
    expect(await employees.exportMarkdown('art')).not.toContain('Wrong lesson');
    await expect(employees.deleteMemory('art', 'm1')).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(employees.deleteMemory('ghost', 'm2')).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});
