import { describe, expect, test } from 'vitest';
import { AnthropicModel, ProbeModelError, buildMessagesBody, cacheBreakpoints, resolveApiKey, PROXY_KEY_FLAG } from '../src/models/anthropic.js';
import { CostAccumulator, CostGuardModel, estimateProbeCost, priceFor, usageCost } from '../src/cost.js';
import type { Model, ModelRequest } from '../src/model.js';
import { MAX_CONSECUTIVE_NETWORK_FAILURES, probeErrorMessage, ProbeStop } from '../src/probe.js';
import type { ModelUsage } from '../src/types.js';

const KEY = 'sk-ant-api03-SECRETSECRETSECRET';

const seg = (text: string, cacheable: boolean) => ({ text, cacheable });

function okResponse(text: string, usage = { input_tokens: 11, cache_creation_input_tokens: 600, cache_read_input_tokens: 0, output_tokens: 7 }) {
  return new Response(JSON.stringify({ id: 'msg_1', type: 'message', role: 'assistant', content: [{ type: 'text', text }], stop_reason: 'end_turn', usage }), {
    status: 200, headers: { 'content-type': 'application/json' },
  });
}

function errResponse(status: number, type: string, message: string, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify({ type: 'error', error: { type, message } }), { status, headers: { 'content-type': 'application/json', ...headers } });
}

/** A fetch stub that replays `responses` in order and records each call. */
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

const request = (segments: { text: string; cacheable: boolean }[]): ModelRequest => ({ botId: 'art', segments, scripted: null });
const noSleep = async () => {};

describe('cacheBreakpoints', () => {
  test('marks the last segment of each cacheable run', () => {
    expect(cacheBreakpoints([true, true, false, false])).toEqual([1]);
    expect(cacheBreakpoints([true, false, true, true, false])).toEqual([0, 3]);
    expect(cacheBreakpoints([false, false])).toEqual([]);
    expect(cacheBreakpoints([true, true])).toEqual([1]);
  });
  test('keeps at most four: the first run end and the last three', () => {
    const flags = [true, false, true, false, true, false, true, false, true, false, true, false];
    expect(cacheBreakpoints(flags)).toEqual([0, 6, 8, 10]);
  });
});

describe('buildMessagesBody', () => {
  test('one text block per segment in one user message, cache_control on cacheable run ends, no temperature', () => {
    const body = buildMessagesBody('claude-haiku-5-5', 200, [seg('template', true), seg('history', true), seg('tail', false), seg('Question: q', false)]);
    expect(body).toEqual({
      model: 'claude-haiku-5-5',
      max_tokens: 200,
      thinking: { type: 'disabled' },
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: 'template' },
          { type: 'text', text: 'history', cache_control: { type: 'ephemeral' } },
          { type: 'text', text: 'tail' },
          { type: 'text', text: 'Question: q' },
        ],
      }],
    });
    expect(body).not.toHaveProperty('temperature');
  });
  test('whitespace-only segments are left out (the API rejects them); breakpoints follow the kept blocks', () => {
    const body = buildMessagesBody('m', 200, [seg('a', true), seg('  ', true), seg('', false), seg('q', false)]);
    expect(body.messages[0]!.content).toEqual([{ type: 'text', text: 'a', cache_control: { type: 'ephemeral' } }, { type: 'text', text: 'q' }]);
  });
});

describe('resolveApiKey', () => {
  test('reads ANTHROPIC_API_KEY only', () => {
    expect(resolveApiKey({ ANTHROPIC_API_KEY: KEY })).toEqual({ key: KEY, placeholder: false });
  });
  test('a placeholder only when the documented proxy flag is set', () => {
    expect(resolveApiKey({ [PROXY_KEY_FLAG]: '1' })).toEqual({ key: 'proxy-injected', placeholder: true });
  });
  test('otherwise a clear error that names the variable and the flag, without any value', () => {
    expect(() => resolveApiKey({})).toThrow(/ANTHROPIC_API_KEY is not set.*BENCH_PROXY_INJECTS_API_KEY=1/);
  });
});

describe('AnthropicModel', () => {
  test('posts to /v1/messages with version and key headers and parses the answer and usage', async () => {
    const { fetch, calls } = stubFetch([okResponse('12x12')]);
    const m = new AnthropicModel({ model: 'claude-haiku-5-5', apiKey: KEY, fetch, sleep: noSleep });
    const out = await m.complete(request([seg('ctx', true), seg('Question: q', false)]));
    expect(out).toEqual({ reply: '12x12', ops: [], usage: { inputTokens: 11, cacheWriteTokens: 600, cacheReadTokens: 0, outputTokens: 7 } });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://api.anthropic.com/v1/messages');
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers['x-api-key']).toBe(KEY);
    expect(headers['anthropic-version']).toBe('2026-10-21');
    expect(headers['content-type']).toBe('application/json');
    expect(JSON.parse(calls[0]!.init.body as string).messages[0].content[0].cache_control).toEqual({ type: 'ephemeral' });
  });

  test('joins several text blocks and ignores non-text blocks', async () => {
    const res = new Response(JSON.stringify({
      content: [{ type: 'thinking', thinking: '', signature: 's' }, { type: 'text', text: 'a' }, { type: 'text', text: 'b' }],
      stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 },
    }), { status: 200 });
    const { fetch } = stubFetch([res]);
    const out = await new AnthropicModel({ model: 'm', apiKey: KEY, fetch, sleep: noSleep }).complete(request([seg('q', false)]));
    expect(out.reply).toBe('ab');
    expect(out.usage).toEqual({ inputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 1 });
  });

  test('retries 429, 5xx, 529 and network errors with bounded backoff, honouring retry-after', async () => {
    const waits: number[] = [];
    const { fetch, calls } = stubFetch([
      errResponse(429, 'rate_limit_error', 'slow down', { 'retry-after': '3' }),
      errResponse(529, 'overloaded_error', 'overloaded'),
      new TypeError('fetch failed'),
      errResponse(500, 'api_error', 'oops'),
      okResponse('ok'),
    ]);
    const m = new AnthropicModel({ model: 'm', apiKey: KEY, fetch, sleep: async ms => { waits.push(ms); }, maxRetries: 4 });
    expect((await m.complete(request([seg('q', false)]))).reply).toBe('ok');
    expect(calls).toHaveLength(5);
    expect(waits[0]).toBe(3000);
    expect(waits.slice(1)).toEqual([2000, 4000, 8000]);
  });

  test('gives up after maxRetries with an error that carries status and type but not the key', async () => {
    const { fetch, calls } = stubFetch([errResponse(503, 'api_error', 'down'), errResponse(503, 'api_error', `down for ${KEY}`)]);
    const m = new AnthropicModel({ model: 'm', apiKey: KEY, fetch, sleep: noSleep, maxRetries: 1 });
    const err = await m.complete(request([seg('q', false)])).catch((e: unknown) => e);
    expect(calls).toHaveLength(2);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(ProbeStop);
    expect(String((err as Error).message)).toMatch(/503 api_error/);
    expect(JSON.stringify(err) + String(err) + probeErrorMessage(err)).not.toContain('SECRET');
  });

  test('400 is not retried and fails only that probe', async () => {
    const { fetch, calls } = stubFetch([errResponse(400, 'invalid_request_error', 'prompt is too long'), okResponse('fine')]);
    const m = new AnthropicModel({ model: 'm', apiKey: KEY, fetch, sleep: noSleep });
    await expect(m.complete(request([seg('q', false)]))).rejects.toThrow(/400 invalid_request_error: prompt is too long/);
    expect((await m.complete(request([seg('q', false)]))).reply).toBe('fine');
    expect(calls).toHaveLength(2);
  });

  test('401/403/404 stop probing for good (ProbeStop), without further requests', async () => {
    const { fetch, calls } = stubFetch([errResponse(401, 'authentication_error', `invalid x-api-key ${KEY}`)]);
    const m = new AnthropicModel({ model: 'm', apiKey: KEY, fetch, sleep: noSleep });
    const first = await m.complete(request([seg('q', false)])).catch((e: unknown) => e);
    expect(first).toBeInstanceOf(ProbeStop);
    expect((first as Error).message).toMatch(/401 authentication_error/);
    expect((first as Error).message).not.toContain('SECRET');
    await expect(m.complete(request([seg('q', false)]))).rejects.toBeInstanceOf(ProbeStop);
    expect(calls).toHaveLength(1);
  });

  test('an unreachable host stops probing after the retries, with the cause code and without the key', async () => {
    const down = () => Object.assign(new TypeError(`fetch failed ${KEY}`), { cause: { code: 'ENOTFOUND' } });
    const { fetch, calls } = stubFetch(Array.from({ length: 5 }, down));
    const m = new AnthropicModel({ model: 'm', apiKey: KEY, fetch, sleep: noSleep });
    const err = await m.complete(request([seg('q', false)])).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProbeStop);
    expect((err as Error).message).toContain('ENOTFOUND');
    expect((err as Error).message).not.toContain(KEY);
    await expect(m.complete(request([seg('q', false)]))).rejects.toBeInstanceOf(ProbeStop);
    expect(calls).toHaveLength(5);
  });

  test('replay requests: network failure is a plain masked error; 10 in a row stop; an HTTP response resets', async () => {
    const down = () => Object.assign(new TypeError(`fetch failed ${KEY}`), { cause: { code: 'ECONNRESET' } });
    const rr = (): ModelRequest => ({ ...request([seg('q', false)]), purpose: 'replay' });
    const seq: (Response | Error)[] = [];
    for (let i = 0; i < MAX_CONSECUTIVE_NETWORK_FAILURES - 1; i++) seq.push(...Array.from({ length: 5 }, down));
    seq.push(errResponse(400, 'invalid_request_error', 'too long'));
    for (let i = 0; i < MAX_CONSECUTIVE_NETWORK_FAILURES; i++) seq.push(...Array.from({ length: 5 }, down));
    const { fetch } = stubFetch(seq);
    const m = new AnthropicModel({ model: 'm', apiKey: KEY, fetch, sleep: noSleep });
    for (let i = 0; i < MAX_CONSECUTIVE_NETWORK_FAILURES - 1; i++) {
      const e = await m.complete(rr()).catch((x: unknown) => x);
      expect(e).not.toBeInstanceOf(ProbeStop);
      expect((e as Error).message).toContain('ECONNRESET');
      expect((e as Error).message).not.toContain(KEY);
    }
    await expect(m.complete(rr())).rejects.not.toBeInstanceOf(ProbeStop); // the 400 resets the counter
    for (let i = 0; i < MAX_CONSECUTIVE_NETWORK_FAILURES; i++) {
      expect(await m.complete(rr()).catch((x: unknown) => x)).not.toBeInstanceOf(ProbeStop);
    }
    await expect(m.complete(rr())).rejects.toBeInstanceOf(ProbeStop);
    await expect(m.complete(request([seg('q', false)]))).rejects.toBeInstanceOf(ProbeStop);
  });

  test('a refusal is an error, not an empty answer, and carries the usage it was billed', async () => {
    const res = new Response(JSON.stringify({ content: [], stop_reason: 'refusal', usage: { input_tokens: 1000, output_tokens: 3 } }), { status: 200 });
    const { fetch } = stubFetch([res]);
    const err = await new AnthropicModel({ model: 'm', apiKey: KEY, fetch, sleep: noSleep }).complete(request([seg('q', false)])).catch((e: unknown) => e);
    expect((err as Error).message).toMatch(/refusal/);
    expect(err).toBeInstanceOf(ProbeModelError);
    expect((err as ProbeModelError).usage).toEqual({ inputTokens: 1000, cacheWriteTokens: 0, cacheReadTokens: 0, outputTokens: 3 });
  });

  test('a malformed 200 body (no content array) is an error that still carries its usage', async () => {
    const res = new Response(JSON.stringify({ stop_reason: 'end_turn', usage: { input_tokens: 5, output_tokens: 2 } }), { status: 200 });
    const { fetch } = stubFetch([res]);
    const err = await new AnthropicModel({ model: 'm', apiKey: KEY, fetch, sleep: noSleep }).complete(request([seg('q', false)])).catch((e: unknown) => e);
    expect((err as Error).message).toMatch(/malformed/);
    expect((err as ProbeModelError).usage).toEqual({ inputTokens: 5, cacheWriteTokens: 0, cacheReadTokens: 0, outputTokens: 2 });
  });

  test('a refusal through the cost guard counts toward spent cost', async () => {
    const res = new Response(JSON.stringify({ content: [], stop_reason: 'refusal', usage: { input_tokens: 1_000_000, output_tokens: 0 } }), { status: 200 });
    const { fetch } = stubFetch([res]);
    const guard = new CostGuardModel(new AnthropicModel({ model: 'claude-haiku-5-5', apiKey: KEY, fetch, sleep: noSleep }), priceFor('claude-haiku-5-5'), { maxCost: 5, maxTokens: 200 });
    await expect(guard.complete(request([seg('q', false)]))).rejects.toThrow(/refusal/);
    expect(guard.spent.cost).toBeCloseTo(0.5, 10);
  });
});

describe('cost', () => {
  const haiku = priceFor('claude-haiku-5-5');
  test('claude-haiku-5-5 prices (USD per million tokens), two rate cards split at 100K prompt tokens', () => {
    expect(haiku.short).toEqual({ input: 0.1, cacheWrite: 0.125, cacheRead: 0.01, output: 0.5 });
    expect(haiku.long).toEqual({ input: 0.5, cacheWrite: 0.625, cacheRead: 0.05, output: 2.5 });
    expect(haiku.longPromptAbove).toBe(100_000);
    expect(() => priceFor('gpt-x')).toThrow(/no price for model "gpt-x"/);
  });
  test('usageCost prices each usage field; the prompt length picks the rate card', () => {
    const u: ModelUsage = { inputTokens: 1_000_000, cacheWriteTokens: 1_000_000, cacheReadTokens: 1_000_000, outputTokens: 1_000_000 };
    // 3M prompt tokens: the long card.
    expect(usageCost(haiku, u)).toBeCloseTo(0.5 + 0.625 + 0.05 + 2.5, 10);
    expect(usageCost(haiku, { inputTokens: 50_000, cacheWriteTokens: 0, cacheReadTokens: 50_000, outputTokens: 100 })).toBeCloseTo(
      (50_000 * 0.1 + 50_000 * 0.01 + 100 * 0.5) / 1e6, 12);
  });
  test('the high estimate picks the long card once inputTokens x margin passes 100K; low keeps the plain count', () => {
    // 80K bench tokens x 1.5 = 120K > 100K: high on the long card, low on the short one.
    const e = estimateProbeCost(haiku, { inputTokens: 80_000, cacheableTokens: 60_000 }, 200);
    expect(e.high).toBeCloseTo((60_000 * 0.625 + 20_000 * 0.5 + 200 * 2.5) / 1e6, 12);
    expect(e.low).toBeCloseTo((60_000 * 0.01 + 20_000 * 0.1 + 200 * 0.5) / 1e6, 12);
    // 66,666 x 1.5 < 100K: both short.
    const s = estimateProbeCost(haiku, { inputTokens: 66_666, cacheableTokens: 0 }, 200);
    expect(s.high).toBeCloseTo((66_666 * 0.1 + 200 * 0.5) / 1e6, 12);
    // An explicit margin of 1 restores the plain count.
    expect(estimateProbeCost(haiku, { inputTokens: 80_000, cacheableTokens: 60_000 }, 200, 1).high).toBeCloseTo((60_000 * 0.125 + 20_000 * 0.1 + 200 * 0.5) / 1e6, 12);
  });
  test('estimateProbeCost: low reads every cacheable token, high writes it; output at max_tokens', () => {
    const e = estimateProbeCost(haiku, { inputTokens: 10_000, cacheableTokens: 8_000 }, 200);
    expect(e.low).toBeCloseTo((8_000 * 0.01 + 2_000 * 0.1 + 200 * 0.5) / 1e6, 12);
    expect(e.high).toBeCloseTo((8_000 * 0.125 + 2_000 * 0.1 + 200 * 0.5) / 1e6, 12);
  });
  test('CostAccumulator sums usage and cost', () => {
    const acc = new CostAccumulator(haiku);
    acc.add({ inputTokens: 100, cacheWriteTokens: 0, cacheReadTokens: 0, outputTokens: 10 });
    acc.add({ inputTokens: 100, cacheWriteTokens: 0, cacheReadTokens: 0, outputTokens: 10 });
    expect(acc.requests).toBe(2);
    expect(acc.usage).toEqual({ inputTokens: 200, cacheWriteTokens: 0, cacheReadTokens: 0, outputTokens: 20 });
    expect(acc.cost).toBeCloseTo((200 * 0.1 + 20 * 0.5) / 1e6, 12);
  });
});

describe('CostGuardModel', () => {
  // Deliberately unrealistic (200,000 output tokens, $0.10 per request) so that a few requests reach the budget.
  const usage: ModelUsage = { inputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0, outputTokens: 200_000 };
  const inner = (): Model & { n: number } => ({ n: 0, async complete() { this.n++; return { reply: 'x', ops: [], usage }; } });
  test('throws ProbeStop before the probe whose estimate would pass --max-cost, and keeps stopping', async () => {
    const m = inner();
    const guard = new CostGuardModel(m, priceFor('claude-haiku-5-5'), { maxCost: 0.25, maxTokens: 200 });
    const r = request([seg('ctx', true), seg('q', false)]);
    await guard.complete(r);
    await guard.complete(r);
    expect(guard.spent.cost).toBeCloseTo(0.2, 10);
    // The guard estimates from the request (a few tokens: well under $0.01), not from past usage, so with
    // $0.20 spent the third request still fits the $0.25 budget and is sent ...
    await guard.complete(r);
    // ... and costs $0.10, so $0.30 is spent: the budget is overshot by one request, and every later call stops
    // without reaching the model.
    await expect(guard.complete(r)).rejects.toBeInstanceOf(ProbeStop);
    await expect(guard.complete(r)).rejects.toThrow(/max-cost/);
    expect(m.n).toBe(3);
  });
  test("the guard's pre-check prices an 80K-token request on the long card", async () => {
    const m = inner();
    // 80K counted tokens, all uncached: long card x margin = 80,000 x 0.5 / 1e6 x 1.5 = $0.06 (+ output); short card would be $0.012.
    const count = (t: string) => (t === 'big' ? 80_000 : 0);
    const guard = new CostGuardModel(m, priceFor('claude-haiku-5-5'), { maxCost: 0.05, maxTokens: 200, count });
    await expect(guard.complete(request([seg('big', false)]))).rejects.toBeInstanceOf(ProbeStop);
    expect(m.n).toBe(0);
  });
  test('usage carried by a failed request (a refusal) is counted', async () => {
    const failing: Model = { async complete() { throw Object.assign(new Error('declined'), { usage }); } };
    const guard = new CostGuardModel(failing, priceFor('claude-haiku-5-5'), { maxCost: 1, maxTokens: 200 });
    await expect(guard.complete(request([seg('q', false)]))).rejects.toThrow(/declined/);
    expect(guard.spent.requests).toBe(1);
    expect(guard.spent.cost).toBeCloseTo(0.1, 10);
  });
  test('stops before a request whose estimate alone would pass the budget', async () => {
    const m = inner();
    const guard = new CostGuardModel(m, priceFor('claude-haiku-5-5'), { maxCost: 0.0001, maxTokens: 200, count: () => 1_000_000 });
    await expect(guard.complete(request([seg('huge', false)]))).rejects.toBeInstanceOf(ProbeStop);
    expect(m.n).toBe(0);
  });
});

describe('per-request max_tokens and purpose', () => {
  const sent = (c: { init: RequestInit }) => JSON.parse(String(c.init.body)) as { max_tokens: number };
  test('the body takes r.maxTokens; without it the adapter default (200)', async () => {
    const s = stubFetch([okResponse('a'), okResponse('b'), okResponse('c')]);
    const m = new AnthropicModel({ model: 'claude-haiku-5-5', apiKey: KEY, fetch: s.fetch, sleep: noSleep });
    await m.complete({ ...request([seg('q', false)]), maxTokens: 16, purpose: 'replay' });
    await m.complete(request([seg('q', false)]));
    await new AnthropicModel({ model: 'claude-haiku-5-5', apiKey: KEY, maxTokens: 50, fetch: s.fetch, sleep: noSleep }).complete(request([seg('q', false)]));
    expect(s.calls.map(c => sent(c).max_tokens)).toEqual([16, 200, 50]);
  });
  test('the guard estimates output at r.maxTokens, and its stop message says requests', async () => {
    // High estimates: 200 tokens x $0.5/MTok x 1.5 = $0.00015 and 16 tokens x ... = $0.000012; the budget sits between them.
    const g2 = new CostGuardModel({ async complete() { return { reply: 'x', ops: [] }; } }, priceFor('claude-haiku-5-5'), { maxCost: 0.00005, maxTokens: 200, count: () => 0 });
    await expect(g2.complete(request([seg('q', false)]))).rejects.toThrow(/requests/);
    await expect(g2.complete({ ...request([seg('q', false)]), maxTokens: 16 })).rejects.toThrow(ProbeStop); // sticky
    const g3 = new CostGuardModel({ async complete() { return { reply: 'x', ops: [] }; } }, priceFor('claude-haiku-5-5'), { maxCost: 0.00005, maxTokens: 200, count: () => 0 });
    await expect(g3.complete({ ...request([seg('q', false)]), maxTokens: 16 })).resolves.toMatchObject({ reply: 'x' });
  });
});
