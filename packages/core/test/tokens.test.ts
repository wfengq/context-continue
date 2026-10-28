import { expect, test } from 'vitest';
import { defaultCountTokens, truncateToTokens } from '../src/tokens.js';

test('CJK counts one token per char, other text ~4 chars per token', () => {
  expect(defaultCountTokens('你好世界')).toBe(4);
  expect(defaultCountTokens('abcdefgh')).toBe(2);
  expect(defaultCountTokens('你好abcd')).toBe(3);
  expect(defaultCountTokens('')).toBe(0);
});

test('truncate never splits a surrogate pair', () => {
  const s = '😀'.repeat(20);
  const t = truncateToTokens(s, 3, defaultCountTokens);
  expect([...t].every(ch => ch === '😀')).toBe(true);
  expect(defaultCountTokens(t)).toBeLessThanOrEqual(3);
});

test('kana and Hangul count one token per char', () => {
  expect(defaultCountTokens('ひらがなカタカナ')).toBe(8);
  expect(defaultCountTokens('한국어')).toBe(3);
});
