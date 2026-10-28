// CJK ideographs (incl. extensions A/B+ and compatibility), kana, Hangul syllables and jamo.
const WIDE_CHAR = /[ᄀ-ᇿ぀-ヿ㄰-㆏㐀-䶿一-鿿가-힯豈-﫿]|[\u{20000}-\u{2FA1F}]/u;

/** Rough token estimate: one token per CJK/kana/Hangul character, ~4 characters per token for the rest. */
export function defaultCountTokens(text: string): number {
  let wide = 0;
  let other = 0;
  for (const ch of text) {
    if (WIDE_CHAR.test(ch)) wide++;
    else other++;
  }
  return wide + Math.ceil(other / 4);
}

/** Longest prefix of `text` (by code point) whose token count is at most `max`. */
export function truncateToTokens(text: string, max: number, count: (s: string) => number): string {
  let out = '';
  for (const ch of text) {
    const next = out + ch;
    if (count(next) > max) break;
    out = next;
  }
  return out;
}
