import { expect, test } from 'vitest';
import { ContextError } from '../src/errors.js';
import type { WorkstreamSource } from '../src/workstreams/source.js';

const newWs = (id: string, owner = 'art', dependsOn: string[] = []) => ({
  id,
  title: `Title ${id}`,
  brief: `brief ${id}`,
  owner,
  dependsOn,
  writeScopes: [`${id}/`],
});

export function runWorkstreamContract(
  name: string,
  make: () => Promise<{ source: WorkstreamSource; projectId: string }>,
): void {
  test(`[${name}] create then list returns the workstreams with status pending`, async () => {
    const { source, projectId } = await make();
    expect(await source.list(projectId)).toEqual([]);
    await source.create(projectId, [newWs('w1'), newWs('w2', 'code', ['w1'])]);
    expect(await source.list(projectId)).toEqual([
      { id: 'w1', title: 'Title w1', owner: 'art', dependsOn: [], writeScopes: ['w1/'], status: 'pending' },
      { id: 'w2', title: 'Title w2', owner: 'code', dependsOn: ['w1'], writeScopes: ['w2/'], status: 'pending' },
    ]);
  });

  test(`[${name}] create defaults writeScopes to empty`, async () => {
    const { source, projectId } = await make();
    const { writeScopes: _omit, ...noScopes } = newWs('w1');
    // the interface requires writeScopes, but hosts built from loosely typed plans may omit it
    await source.create(projectId, [noScopes as Parameters<WorkstreamSource['create']>[1][number]]);
    expect((await source.list(projectId))[0]!.writeScopes).toEqual([]);
  });

  test(`[${name}] create with an existing id throws INVALID_OP`, async () => {
    const { source, projectId } = await make();
    await source.create(projectId, [newWs('w1')]);
    await expect(source.create(projectId, [newWs('w1')])).rejects.toMatchObject({ code: 'INVALID_OP' });
    await expect(source.create(projectId, [newWs('w1')])).rejects.toBeInstanceOf(ContextError);
    expect(await source.list(projectId)).toHaveLength(1);
  });

  test(`[${name}] setStatus is visible in list and fires onChange with the id`, async () => {
    const { source, projectId } = await make();
    await source.create(projectId, [newWs('w1'), newWs('w2')]);
    const seen: string[][] = [];
    source.onChange(projectId, ids => seen.push(ids));
    await source.setStatus(projectId, 'w2', 'active');
    const list = await source.list(projectId);
    expect(list.find(w => w.id === 'w2')!.status).toBe('active');
    expect(list.find(w => w.id === 'w1')!.status).toBe('pending');
    expect(seen).toEqual([['w2']]);
  });

  test(`[${name}] setStatus on an unknown id throws NOT_FOUND`, async () => {
    const { source, projectId } = await make();
    await expect(source.setStatus(projectId, 'nope', 'active')).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  test(`[${name}] onChange unsubscribe stops notifications`, async () => {
    const { source, projectId } = await make();
    await source.create(projectId, [newWs('w1')]);
    const seen: string[][] = [];
    const off = source.onChange(projectId, ids => seen.push(ids));
    await source.setStatus(projectId, 'w1', 'active');
    off();
    await source.setStatus(projectId, 'w1', 'delivered');
    expect(seen).toEqual([['w1']]);
  });

  test(`[${name}] a throwing onChange handler does not break the write or other handlers`, async () => {
    const { source, projectId } = await make();
    await source.create(projectId, [newWs('w1')]);
    const seen: string[][] = [];
    source.onChange(projectId, () => {
      throw new Error('boom');
    });
    source.onChange(projectId, ids => seen.push(ids));
    await expect(source.setStatus(projectId, 'w1', 'blocked')).resolves.toBeUndefined();
    expect((await source.list(projectId))[0]!.status).toBe('blocked');
    expect(seen).toEqual([['w1']]);
  });
}
