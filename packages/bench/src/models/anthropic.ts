import type { Model, ModelRequest } from '../model.js';
import { probeErrorMessage, ProbeStop } from '../probe.js';
import type { ModelUsage, ToolCall } from '../types.js';

/**
 * Real-model adapter for the Anthropic Messages API (raw HTTP with Node's fetch; the bench adds no
 * dependencies). Used only for fact probes: the scripted run never calls it.
 *
 * Request: one user message with one text block per non-blank segment, in order; a
 * `cache_control: {type: "ephemeral"}` breakpoint on the last block of each cacheable run (at most
 * four, the API's limit); `thinking: {type: "disabled"}` so a short `max_tokens` holds the answer;
 * no `temperature` (Claude Haiku 5.5 rejects non-default sampling values, and API version 2026-10-21
 * rejects the parameter on every model).
 */

export const API_VERSION = '2026-10-21';
export const DEFAULT_BASE_URL = 'https://api.anthropic.com';
export const DEFAULT_MAX_TOKENS = 200;
/** Set to 1 when the environment's proxy injects the API key: requests then carry a placeholder. */
export const PROXY_KEY_FLAG = 'BENCH_PROXY_INJECTS_API_KEY';
const MAX_BREAKPOINTS = 4;
const RETRY_STATUS = new Set([408, 409, 429, 500, 502, 503, 504, 529]);
/** Errors that every later request would hit too: stop probing instead of failing each probe. */
const FATAL_STATUS = new Set([401, 402, 403, 404]);

/**
 * The key, from ANTHROPIC_API_KEY only; with BENCH_PROXY_INJECTS_API_KEY=1 and no key, a placeholder
 * that the proxy replaces. Otherwise throws (the message never contains a value).
 */
export function resolveApiKey(env: Record<string, string | undefined> = process.env): { key: string; placeholder: boolean } {
  const key = env.ANTHROPIC_API_KEY;
  if (key !== undefined && key.trim() !== '') return { key, placeholder: false };
  if (env[PROXY_KEY_FLAG] === '1') return { key: 'proxy-injected', placeholder: true };
  throw new Error(
    `ANTHROPIC_API_KEY is not set. Export it for a real probe run, or set ${PROXY_KEY_FLAG}=1 if the environment's proxy injects the key ` +
      '(or use --dry-run, which sends nothing).',
  );
}

/**
 * Indices of the blocks that get a cache breakpoint: the last block of each run of cacheable blocks.
 * With more than four runs, the first run's end (the stable prefix) and the last three are kept.
 */
export function cacheBreakpoints(cacheable: boolean[]): number[] {
  const ends = cacheable.flatMap((c, i) => (c && !cacheable[i + 1] ? [i] : []));
  return ends.length <= MAX_BREAKPOINTS ? ends : [ends[0]!, ...ends.slice(-(MAX_BREAKPOINTS - 1))];
}

type TextBlock = { type: 'text'; text: string; cache_control?: { type: 'ephemeral' } };

export function buildMessagesBody(model: string, maxTokens: number, segments: { text: string; cacheable: boolean }[]) {
  // The API rejects empty or whitespace-only text blocks; they count 0 tokens in the bench anyway.
  const kept = segments.filter(s => s.text.trim() !== '');
  const marks = new Set(cacheBreakpoints(kept.map(s => s.cacheable)));
  const content: TextBlock[] = kept.map((s, i) => (marks.has(i) ? { type: 'text', text: s.text, cache_control: { type: 'ephemeral' } } : { type: 'text', text: s.text }));
  return {
    model,
    max_tokens: maxTokens,
    thinking: { type: 'disabled' as const },
    messages: [{ role: 'user' as const, content }],
  };
}

export interface AnthropicOptions {
  model: string;
  /** Sent as x-api-key; never logged or recorded. */
  apiKey: string;
  baseUrl?: string;
  maxTokens?: number;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  /** Retries after the first attempt for 408/409/429/5xx/529 and network errors (default 4). */
  maxRetries?: number;
  timeoutMs?: number;
}

const realSleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

/** Backoff before retry `attempt` (0-based): retry-after seconds if given (at most 60 s), else 1 s x 2^attempt (at most 30 s). */
function backoff(attempt: number, retryAfter: string | null): number {
  const s = retryAfter === null ? NaN : Number(retryAfter);
  if (Number.isFinite(s) && s >= 0) return Math.min(s * 1000, 60_000);
  return Math.min(1000 * 2 ** attempt, 30_000);
}

interface ApiResponse {
  content?: { type: string; text?: string }[];
  stop_reason?: string;
  usage?: { input_tokens?: number; cache_creation_input_tokens?: number | null; cache_read_input_tokens?: number | null; output_tokens?: number };
}

export class AnthropicModel implements Model {
  private readonly fetchFn: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private fatal: string | undefined;

  constructor(private readonly o: AnthropicOptions) {
    this.fetchFn = o.fetch ?? fetch;
    this.sleep = o.sleep ?? realSleep;
  }

  /** An error message with the key removed and the usual masking applied. */
  private clean(msg: string): string {
    const k = this.o.apiKey;
    return probeErrorMessage(k.length >= 4 ? msg.split(k).join('***') : msg).replace(/^Error: /, '');
  }

  async complete(r: ModelRequest): Promise<{ reply: string; ops: ToolCall[]; usage: ModelUsage }> {
    if (this.fatal !== undefined) throw new ProbeStop(this.fatal);
    const body = JSON.stringify(buildMessagesBody(this.o.model, this.o.maxTokens ?? DEFAULT_MAX_TOKENS, r.segments));
    const url = `${(this.o.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '')}/v1/messages`;
    const maxRetries = this.o.maxRetries ?? 4;
    for (let attempt = 0; ; attempt++) {
      let res: Response;
      try {
        res = await this.fetchFn(url, {
          method: 'POST',
          headers: { 'x-api-key': this.o.apiKey, 'anthropic-version': API_VERSION, 'content-type': 'application/json' },
          body,
          signal: AbortSignal.timeout(this.o.timeoutMs ?? 120_000),
        });
      } catch (e) {
        // Network error or timeout: retryable. Only the message is kept, never the request.
        if (attempt < maxRetries) {
          await this.sleep(backoff(attempt, null));
          continue;
        }
        throw new Error(this.clean(`Anthropic API request failed after ${attempt + 1} attempts: ${e instanceof Error ? e.message : String(e)}`));
      }
      if (res.ok) return this.parse((await res.json()) as ApiResponse);
      const text = await res.text().catch(() => '');
      let detail = text.slice(0, 300);
      try {
        const j = JSON.parse(text) as { error?: { type?: string; message?: string } };
        if (j.error) detail = `${j.error.type ?? 'error'}: ${j.error.message ?? ''}`;
      } catch {
        // not JSON: keep the raw (truncated) text
      }
      const msg = this.clean(`Anthropic API ${res.status} ${detail}`);
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

  private parse(j: ApiResponse): { reply: string; ops: ToolCall[]; usage: ModelUsage } {
    if (j.stop_reason === 'refusal') throw new Error('Anthropic API: the model declined (stop_reason refusal)');
    const reply = (j.content ?? []).filter(b => b.type === 'text').map(b => b.text ?? '').join('');
    const u = j.usage ?? {};
    return {
      reply,
      ops: [],
      usage: {
        inputTokens: u.input_tokens ?? 0,
        cacheWriteTokens: u.cache_creation_input_tokens ?? 0,
        cacheReadTokens: u.cache_read_input_tokens ?? 0,
        outputTokens: u.output_tokens ?? 0,
      },
    };
  }
}
