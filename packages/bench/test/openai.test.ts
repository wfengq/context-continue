import { describe, expect, test } from 'vitest';
import { OpenAIModel, baseUrlHost, buildChatBody, chatCompletionsUrl } from '../src/models/openai.js';
import { ProbeModelError } from '../src/model.js';
import { CostGuardModel, customPrice, estimateProbeCost, usageCost } from '../src/cost.js';
import { ProbeStop } from '../src/probe.js';
import type { ModelRequest } from '../src/model.js';

const KEY = 'sk-deepseek-SECRETSECRETSECRET';
const BASE = 'https://api.example.com/v1/';
const seg = (text: string, cacheable = false) => ({ text, cacheable });
const request = (segments = [seg('a', true), seg('b'), seg('Question: q')]): ModelRequest => ({ botId: 'art', segments, scripted: null });
const noSleep = async () => {};

const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
const chat = (content: string | null, usage: unknown = { prompt_tokens: 100, completion_tokens: 7, prompt_cache_hit_tokens: 60, prompt_cache_miss_tokens: 40 }, finish = 'stop') =>
  ok({ choices: [{ message: { role: 'assistant', content, reasoning_content: 'secret thoughts' }, finish_reason: finish }], usage });
const err = (status: number, message: string, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify({ error: { message, type: 'invalid_request_error' } }), { status, headers });

function stubFetch(responses: (Response | Error)[]) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fn = async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const next = responses.shift();
    if (next === undefined) throw new Error('unexpected fetch');
    if (next instanceof Error) throw next;
    return next;
  };
  return { fetch: fn as typeof fetch, calls };
}
const model = (f: typeof fetch, extra: object = {}) => new OpenAIModel({ model: 'deepseek-chat', baseUrl: BASE, apiKey: KEY, fetch: f, sleep: noSleep, ...extra });

describe('request', () => {
  test('body joins segments with a newline; fixed sampling; no cache markers', () => {
    expect(buildChatBody('m', 200, [seg('a'), seg('b')])).toEqual({
      model: 'm', max_tokens: 200, temperature: 0, stream: false, thinking: { type: 'disabled' },
      messages: [{ role: 'user', content: 'a\nb' }],
    });
  });
  test('thinking omit leaves the field out of the body', () => {
    expect('thinking' in buildChatBody('m', 200, [seg('a')], 'omit')).toBe(false);
    expect(buildChatBody('m', 200, [seg('a')], 'disabled').thinking).toEqual({ type: 'disabled' });
  });
  test('url: trailing slashes removed, query kept after the path', () => {
    expect(chatCompletionsUrl('https://h.com/v1///')).toBe('https://h.com/v1/chat/completions');
    expect(chatCompletionsUrl('http://localhost:11434/v1')).toBe('http://localhost:11434/v1/chat/completions');
    expect(chatCompletionsUrl('https://h.com/v1/?x=1')).toBe('https://h.com/v1/chat/completions?x=1');
  });
  test('baseUrlHost keeps host and port only; rejects non-http(s)', () => {
    expect(baseUrlHost('http://localhost:11434/v1?key=zzz')).toBe('localhost:11434');
    expect(baseUrlHost('https://api.deepseek.com')).toBe('api.deepseek.com');
    expect(() => baseUrlHost('ftp://x.com')).toThrow();
    expect(() => baseUrlHost('nonsense')).toThrow();
  });
  test('sends a bearer header with a key, none without', async () => {
    const a = stubFetch([chat('hi')]);
    await model(a.fetch).complete(request());
    expect(a.calls[0]!.url).toBe('https://api.example.com/v1/chat/completions');
    const h = a.calls[0]!.init.headers as Record<string, string>;
    expect(h.authorization).toBe(`Bearer ${KEY}`);
    const b = stubFetch([chat('hi')]);
    await new OpenAIModel({ model: 'm', baseUrl: BASE, fetch: b.fetch }).complete(request());
    expect(Object.keys(b.calls[0]!.init.headers as object).map(k => k.toLowerCase())).not.toContain('authorization');
  });
});

describe('usage and answer', () => {
  test('DeepSeek fields; reasoning_content ignored', async () => {
    const r = await model(stubFetch([chat('answer')]).fetch).complete(request());
    expect(r.reply).toBe('answer');
    expect(r.usage).toEqual({ inputTokens: 40, cacheWriteTokens: 0, cacheReadTokens: 60, outputTokens: 7 });
  });
  test('falls back to prompt_tokens_details.cached_tokens, then to no cache', async () => {
    const a = await model(stubFetch([chat('x', { prompt_tokens: 100, completion_tokens: 3, prompt_tokens_details: { cached_tokens: 30 } })]).fetch).complete(request());
    expect(a.usage).toEqual({ inputTokens: 70, cacheWriteTokens: 0, cacheReadTokens: 30, outputTokens: 3 });
    const b = await model(stubFetch([chat('x', { prompt_tokens: 100, completion_tokens: 3 })]).fetch).complete(request());
    expect(b.usage).toEqual({ inputTokens: 100, cacheWriteTokens: 0, cacheReadTokens: 0, outputTokens: 3 });
  });
  test('empty content and content_filter are errors that carry the usage', async () => {
    for (const r of [chat(''), chat('text', undefined, 'content_filter')]) {
      const e = await model(stubFetch([r]).fetch).complete(request()).catch(x => x);
      expect(e).toBeInstanceOf(ProbeModelError);
      expect((e as ProbeModelError).usage).toEqual({ inputTokens: 40, cacheWriteTokens: 0, cacheReadTokens: 60, outputTokens: 7 });
    }
    const m = await model(stubFetch([ok({ nope: 1 })]).fetch).complete(request()).catch(x => x);
    expect(m).toBeInstanceOf(ProbeModelError);
    expect((m as ProbeModelError).usage).toBeUndefined();
  });
});

describe('errors and retries', () => {
  test.each([401, 402, 403, 404])('%i stops all later probes without another request', async status => {
    const s = stubFetch([err(status, 'nope')]);
    const m = model(s.fetch);
    await expect(m.complete(request())).rejects.toBeInstanceOf(ProbeStop);
    await expect(m.complete(request())).rejects.toBeInstanceOf(ProbeStop);
    expect(s.calls).toHaveLength(1);
  });
  test.each([400, 422])('%i fails only that probe', async status => {
    const s = stubFetch([err(status, 'bad'), chat('fine')]);
    const m = model(s.fetch);
    const e = await m.complete(request()).catch(x => x);
    expect(e).not.toBeInstanceOf(ProbeStop);
    expect((e as Error).message).toMatch(new RegExp(`${status}`));
    expect((await m.complete(request())).reply).toBe('fine');
  });
  test.each([400, 422])('three %i in a row stop the run with a sticky ProbeStop that suggests --thinking omit', async status => {
    const s = stubFetch([err(status, 'unknown field thinking'), err(status, 'unknown field thinking'), err(status, `unknown field thinking ${KEY}`)]);
    const m = model(s.fetch);
    for (let i = 0; i < 2; i++) expect(await m.complete(request()).catch(x => x)).not.toBeInstanceOf(ProbeStop);
    const e = await m.complete(request()).catch(x => x);
    expect(e).toBeInstanceOf(ProbeStop);
    expect((e as Error).message).toMatch(/rejected the request 3 times in a row/);
    expect((e as Error).message).toContain(String(status));
    expect((e as Error).message).toContain('unknown field thinking');
    expect((e as Error).message).toContain('--thinking omit');
    expect((e as Error).message).not.toContain(KEY);
    await expect(m.complete(request())).rejects.toBeInstanceOf(ProbeStop);
    expect(s.calls).toHaveLength(3);
  });
  test('a success between 400s resets the counter', async () => {
    const s = stubFetch([err(400, 'bad'), err(422, 'bad'), chat('fine'), err(400, 'bad'), err(400, 'bad'), chat('fine')]);
    const m = model(s.fetch);
    for (let i = 0; i < 2; i++) expect(await m.complete(request()).catch(x => x)).not.toBeInstanceOf(ProbeStop);
    expect((await m.complete(request())).reply).toBe('fine');
    for (let i = 0; i < 2; i++) expect(await m.complete(request()).catch(x => x)).not.toBeInstanceOf(ProbeStop);
    expect((await m.complete(request())).reply).toBe('fine');
  });
  test.each([408, 409, 429, 500, 503])('%i is retried with backoff', async status => {
    const sleeps: number[] = [];
    const s = stubFetch([err(status, 'busy', { 'retry-after': '3' }), err(status, 'busy'), chat('done')]);
    const r = await model(s.fetch, { sleep: async (ms: number) => void sleeps.push(ms) }).complete(request());
    expect(r.reply).toBe('done');
    expect(sleeps).toEqual([3000, 2000]);
  });
  test('network errors are retried, then fail', async () => {
    const s = stubFetch([new Error('boom'), new Error('boom'), chat('ok')]);
    expect((await model(s.fetch).complete(request())).reply).toBe('ok');
    const t = stubFetch(Array.from({ length: 5 }, () => new Error('down')));
    await expect(model(t.fetch).complete(request())).rejects.toThrow(/after 5 attempts/);
  });
  test('unreachable host: after the retries a sticky ProbeStop with the cause code and no key', async () => {
    const down = () => Object.assign(new TypeError(`fetch failed ${KEY}`), { cause: { code: 'ECONNREFUSED' } });
    const s = stubFetch(Array.from({ length: 5 }, down));
    const m = model(s.fetch);
    const e = await m.complete(request()).catch(x => x);
    expect(e).toBeInstanceOf(ProbeStop);
    expect((e as Error).message).toContain('ECONNREFUSED');
    expect((e as Error).message).not.toContain(KEY);
    await expect(m.complete(request())).rejects.toBeInstanceOf(ProbeStop);
    expect(s.calls).toHaveLength(5);
  });
  test('the key never appears in an error message', async () => {
    const s = stubFetch([err(400, `bad key ${KEY} here`)]);
    const e = (await model(s.fetch).complete(request()).catch(x => x)) as Error;
    expect(e.message).not.toContain(KEY);
    const t = stubFetch(Array.from({ length: 5 }, () => new Error(`connect failed ${KEY}`)));
    const e2 = (await model(t.fetch).complete(request()).catch(x => x)) as Error;
    expect(e2.message).not.toContain(KEY);
  });
});

describe('customPrice', () => {
  const p = customPrice(2, 0.5, 8);
  test('one tier, no cache write; cost from reported usage', () => {
    expect(p.short).toBe(p.long);
    expect(p.short.cacheWrite).toBe(0);
    expect(usageCost(p, { inputTokens: 1_000_000, cacheWriteTokens: 0, cacheReadTokens: 1_000_000, outputTokens: 1_000_000 })).toBeCloseTo(10.5, 10);
    // never switches to a long card
    expect(usageCost(p, { inputTokens: 500_000, cacheWriteTokens: 0, cacheReadTokens: 0, outputTokens: 0 })).toBeCloseTo(1, 10);
  });
  test('estimate: low reads cacheable from cache, high prices everything at the input rate', () => {
    const e = estimateProbeCost(p, { inputTokens: 1_000_000, cacheableTokens: 800_000 }, 200);
    expect(e.low).toBeCloseTo((800_000 * 0.5 + 200_000 * 2 + 200 * 8) / 1e6, 10);
    expect(e.high).toBeCloseTo((1_000_000 * 2 + 200 * 8) / 1e6, 10);
  });
  test('cost guard stops before overspending and counts usage of a failed probe', async () => {
    const s = stubFetch([chat('x'), chat('x')]);
    const g = new CostGuardModel(model(s.fetch), customPrice(1000, 0, 1000), { maxCost: 1, maxTokens: 200 });
    await expect(g.complete(request([seg('x'.repeat(4000))]))).rejects.toBeInstanceOf(ProbeStop);
    expect(s.calls).toHaveLength(0);
    const s2 = stubFetch([chat('')]);
    const g2 = new CostGuardModel(model(s2.fetch), customPrice(1, 0, 1), { maxCost: 1, maxTokens: 200 });
    await g2.complete(request()).catch(() => {});
    expect(g2.spent.usage.outputTokens).toBe(7);
  });
});
