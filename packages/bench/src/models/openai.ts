import { ProbeModelError, type Model, type ModelRequest } from '../model.js';
import { backoff, realSleep } from './anthropic.js';
import { probeErrorMessage, ProbeStop } from '../probe.js';
import type { ModelUsage, ToolCall } from '../types.js';

/**
 * Real-model adapter for OpenAI-compatible Chat Completions servers (DeepSeek, local servers), raw
 * HTTP with Node's fetch. Used only for fact probes.
 *
 * Request: POST `<base-url>/chat/completions`, one user message holding the segments joined with a
 * newline (as the bench counts them); `max_tokens`, `temperature` 0, `stream` false. No cache
 * markers: such servers cache prefixes by themselves.
 */

export const DEFAULT_API_KEY_ENV = 'OPENAI_API_KEY';
const RETRY_STATUS = new Set([408, 409, 429, 500, 502, 503, 504]);
/** Errors that every later request would hit too: stop probing instead of failing each probe. */
const FATAL_STATUS = new Set([401, 402, 403, 404]);

export function buildChatBody(model: string, maxTokens: number, segments: { text: string }[]) {
  return {
    model,
    max_tokens: maxTokens,
    temperature: 0,
    stream: false,
    messages: [{ role: 'user' as const, content: segments.map(s => s.text).join('\n') }],
  };
}

/** `<base>/chat/completions`, with trailing slashes of the base path removed and any query kept after the path. */
export function chatCompletionsUrl(baseUrl: string): string {
  const u = new URL(baseUrl);
  u.pathname = `${u.pathname.replace(/\/+$/, '')}/chat/completions`;
  u.hash = '';
  return u.toString();
}

/** The host (with the port, if any) of a base URL: all that results record of it. Throws unless it is http(s). */
export function baseUrlHost(raw: string): string {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new Error('not a valid URL');
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('must start with http:// or https://');
  return u.host;
}

export interface OpenAIOptions {
  model: string;
  baseUrl: string;
  /** Sent as `Authorization: Bearer`; undefined sends no header (local servers). Never logged or recorded. */
  apiKey?: string;
  maxTokens?: number;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  /** Retries after the first attempt for 408/409/429/5xx and network errors (default 4). */
  maxRetries?: number;
  timeoutMs?: number;
}

interface ChatResponse {
  choices?: { message?: { content?: string | null }; finish_reason?: string | null }[];
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    prompt_cache_hit_tokens?: number;
    prompt_cache_miss_tokens?: number;
    prompt_tokens_details?: { cached_tokens?: number } | null;
  };
}

export class OpenAIModel implements Model {
  private readonly fetchFn: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private fatal: string | undefined;

  constructor(private readonly o: OpenAIOptions) {
    this.fetchFn = o.fetch ?? fetch;
    this.sleep = o.sleep ?? realSleep;
  }

  /** An error message with the key removed and the usual masking applied. */
  private clean(msg: string): string {
    const k = this.o.apiKey;
    return probeErrorMessage(k !== undefined && k.length >= 4 ? msg.split(k).join('***') : msg).replace(/^Error: /, '');
  }

  async complete(r: ModelRequest): Promise<{ reply: string; ops: ToolCall[]; usage: ModelUsage }> {
    if (this.fatal !== undefined) throw new ProbeStop(this.fatal);
    const body = JSON.stringify(buildChatBody(this.o.model, this.o.maxTokens ?? 200, r.segments));
    const url = chatCompletionsUrl(this.o.baseUrl);
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (this.o.apiKey !== undefined) headers.authorization = `Bearer ${this.o.apiKey}`;
    const maxRetries = this.o.maxRetries ?? 4;
    for (let attempt = 0; ; attempt++) {
      let res: Response;
      try {
        res = await this.fetchFn(url, { method: 'POST', headers, body, signal: AbortSignal.timeout(this.o.timeoutMs ?? 120_000) });
      } catch (e) {
        if (attempt < maxRetries) {
          await this.sleep(backoff(attempt, null));
          continue;
        }
        const c = (e as { cause?: { code?: unknown } } | null)?.cause?.code;
        const why = `${e instanceof Error ? e.message : String(e)}${typeof c === 'string' ? ` (${c})` : ''}`;
        // Every later request would fail the same way: stop probing for the rest of the run.
        this.fatal = this.clean(`OpenAI-compatible API unreachable after ${attempt + 1} attempts: ${why}`);
        throw new ProbeStop(this.fatal);
      }
      if (res.ok) {
        let j: ChatResponse;
        try {
          j = (await res.json()) as ChatResponse;
        } catch {
          throw new ProbeModelError('OpenAI-compatible API: malformed response (not JSON)');
        }
        return this.parse(j);
      }
      const text = await res.text().catch(() => '');
      let detail = text.slice(0, 300);
      try {
        const j = JSON.parse(text) as { error?: { type?: string; message?: string } | string };
        if (typeof j.error === 'string') detail = j.error;
        else if (j.error) detail = `${j.error.type ?? 'error'}: ${j.error.message ?? ''}`;
      } catch {
        // not JSON: keep the raw (truncated) text
      }
      const msg = this.clean(`OpenAI-compatible API ${res.status} ${detail}`);
      if (RETRY_STATUS.has(res.status) && attempt < maxRetries) {
        await this.sleep(backoff(attempt, res.headers.get('retry-after')));
        continue;
      }
      if (FATAL_STATUS.has(res.status)) {
        this.fatal = msg;
        throw new ProbeStop(msg);
      }
      throw new Error(attempt > 0 ? `${msg} (after ${attempt + 1} attempts)` : msg);
    }
  }

  private parse(j: ChatResponse): { reply: string; ops: ToolCall[]; usage: ModelUsage } {
    const u = j.usage ?? {};
    const cacheRead = u.prompt_cache_hit_tokens ?? u.prompt_tokens_details?.cached_tokens ?? 0;
    const usage: ModelUsage = {
      inputTokens: u.prompt_cache_miss_tokens ?? Math.max(0, (u.prompt_tokens ?? 0) - cacheRead),
      cacheWriteTokens: 0,
      cacheReadTokens: cacheRead,
      outputTokens: u.completion_tokens ?? 0,
    };
    // Failed but possibly billed: the error carries the usage so the cost guard counts it.
    const billed = j.usage === undefined ? undefined : usage;
    const choice = Array.isArray(j.choices) ? j.choices[0] : undefined;
    if (choice === undefined) throw new ProbeModelError('OpenAI-compatible API: malformed response (no choices)', billed);
    if (choice.finish_reason === 'content_filter') throw new ProbeModelError('OpenAI-compatible API: blocked by a content filter (finish_reason content_filter)', billed);
    const reply = choice.message?.content;
    if (typeof reply !== 'string' || reply.trim() === '') throw new ProbeModelError('OpenAI-compatible API: empty answer (no message content)', billed);
    return { reply, ops: [], usage };
  }
}
