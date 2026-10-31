import { describe, expect, test } from 'vitest';
import { historyReader, historySegments, prefixCacheable } from '../src/policies/history.js';
import { BASE_TEMPLATE } from '../src/runner.js';

const flags = (segs: { cacheable: boolean }[]) => segs.map(s => s.cacheable);
const texts = (segs: { text: string }[]) => segs.map(s => s.text);

describe('history helpers', () => {
  test('historySegments: template (cacheable) + lines, the first prevLen lines cacheable', () => {
    const segs = historySegments(['a', 'b', 'c'], 2);
    expect(texts(segs)).toEqual([BASE_TEMPLATE, 'a', 'b', 'c']);
    expect(flags(segs)).toEqual([true, true, true, false]);
  });

  test('historyReader: each bot appends unread log entries and its task; cacheable = its previous request', () => {
    const log: string[] = ['h1'];
    const r = historyReader();
    const first = r.segmentsFor('x', log, 't1');
    expect(texts(first)).toEqual([BASE_TEMPLATE, 'h1', 't1']);
    expect(flags(first)).toEqual([true, false, false]);
    log.push('b1', 'b2');
    // another bot reads independently from the start
    expect(texts(r.segmentsFor('y', log, null))).toEqual([BASE_TEMPLATE, 'h1', 'b1', 'b2']);
    const second = r.segmentsFor('x', log, null);
    expect(texts(second)).toEqual([BASE_TEMPLATE, 'h1', 't1', 'b1', 'b2']);
    expect(flags(second)).toEqual([true, true, true, false, false]);
    // entries are never read twice
    expect(texts(r.segmentsFor('x', log, 't2'))).toEqual([BASE_TEMPLATE, 'h1', 't1', 'b1', 'b2', 't2']);
  });

  test('prefixCacheable: first request → the first `firstRequest` segments; later → longest identical leading run', () => {
    expect(prefixCacheable(null, ['T', 'a', 'b'], 1)).toEqual([true, false, false]);
    expect(prefixCacheable(null, ['T', 'a', 'b'], 0)).toEqual([false, false, false]);
    expect(prefixCacheable(['T', 'a', 'b'], ['T', 'a', 'b', 'c'], 1)).toEqual([true, true, true, false]);
    // a changed segment ends the run, even when later segments match again
    expect(prefixCacheable(['T', 'a', 'b'], ['T', 'X', 'b'], 1)).toEqual([true, false, false]);
    // a shorter previous request caches only what it had
    expect(prefixCacheable(['T'], ['T', 'a'], 1)).toEqual([true, false]);
    // the first segment changed → nothing cacheable
    expect(prefixCacheable(['T', 'a'], ['U', 'a'], 1)).toEqual([false, false]);
  });
});
