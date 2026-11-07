import { describe, expect, test } from 'vitest';
import { AnthropicModel, buildMessagesBody, cacheBreakpoints, resolveApiKey, PROXY_KEY_FLAG } from '../src/models/anthropic.js';
import { CostAccumulator, CostGuardModel, estimateProbeCost, priceFor, usageCost } from '../src/cost.js';
import type { Model, ModelRequest } from '../src/model.js';
import { probeErrorMessage, ProbeStop } from '../src/probe.js';
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

  test('a refusal is an error, not an empty answer', async () => {
    const res = new Response(JSON.stringify({ content: [], stop_reason: 'refusal', usage: { input_tokens: 1, output_tokens: 0 } }), { status: 200 });
    const { fetch } = stubFetch([res]);
    await expect(new AnthropicModel({ model: 'm', apiKey: KEY, fetch, sleep: noSleep }).complete(request([seg('q', false)]))).rejects.toThrow(/refusal/);
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
  const usage: ModelUsage = { inputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0, outputTokens: 200_000 }; // $0.10 each
  const inner = (): Model & { n: number } => ({ n: 0, async complete() { this.n++; return { reply: 'x', ops: [], usage }; } });
  test('throws ProbeStop before the probe whose estimate would pass --max-cost, and keeps stopping', async () => {
    const m = inner();
    const guard = new CostGuardModel(m, priceFor('claude-haiku-5-5'), { maxCost: 0.25, maxTokens: 200 });
    const r = request([seg('ctx', true), seg('q', false)]);
    await guard.complete(r);
    await guard.complete(r);
    expect(guard.spent.cost).toBeCloseTo(0.2, 10);
    // 0.20 spent + 0.10 is not used for the estimate: the estimate is of the request (tiny), so the third one fits ...
    await guard.complete(r);
    // ... and now 0.30 > 0.25: every later call stops without reaching the model.
    await expect(guard.complete(r)).rejects.toBeInstanceOf(ProbeStop);
    await expect(guard.complete(r)).rejects.toThrow(/max-cost/);
    expect(m.n).toBe(3);
  });
  test('stops before a request whose estimate alone would pass the budget', async () => {
    const m = inner();
    const guard = new CostGuardModel(m, priceFor('claude-haiku-5-5'), { maxCost: 0.0001, maxTokens: 200, count: () => 1_000_000 });
    await expect(guard.complete(request([seg('huge', false)]))).rejects.toBeInstanceOf(ProbeStop);
    expect(m.n).toBe(0);
  });
});
