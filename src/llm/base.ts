/**
 * Abstract LLM backend interface.
 */

import type { LLMResponse, Message, StreamChunk, LLMCompleteOptions } from './types.js';

export interface LLMBackendOptions {
  model: string;
  apiKey?: string;
  baseUrl?: string;
  timeoutMs?: number;
}

/** Shared transient error detection pattern for retry logic. */
export const TRANSIENT_PATTERN =
  /terminated|timed?\s*out|ECONNRESET|ETIMEDOUT|socket hang up|overloaded|499|5\d\d|Connection error|ENOTFOUND|EAI_AGAIN|fetch failed/i;

/**
 * Models that fix temperature internally (reasoning / thinking models).
 * Sending a non-default temperature causes 400 errors on these models.
 */
const FIXED_TEMPERATURE_PATTERN =
  /\bo[34]-?\w*|reasoner|thinking|^kimi-k2/i;

/** Returns true if the model does not support user-specified temperature. */
export function isFixedTemperatureModel(model: string): boolean {
  return FIXED_TEMPERATURE_PATTERN.test(model);
}

export abstract class LLMBackend {
  protected model: string;
  protected apiKey?: string;
  protected baseUrl?: string;
  protected timeoutMs: number;

  constructor(options: LLMBackendOptions) {
    this.model = options.model;
    this.apiKey = options.apiKey;
    this.baseUrl = options.baseUrl;
    this.timeoutMs = options.timeoutMs ?? 600000;
  }

  abstract complete(
    messages: Message[],
    options?: LLMCompleteOptions,
  ): Promise<LLMResponse>;

  abstract stream(
    messages: Message[],
    options?: LLMCompleteOptions & { signal?: AbortSignal },
  ): AsyncIterable<StreamChunk>;

  /** Configured timeout in ms — used by FallbackBackend for layered timeout. */
  get configuredTimeoutMs(): number { return this.timeoutMs; }

  abstract get providerName(): string;

  /** Sleep that rejects immediately on abort signal, so Esc during retry delay works. */
  protected abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
    if (!signal) return new Promise(r => setTimeout(r, ms));
    if (signal.aborted) return Promise.reject(new DOMException('The operation was aborted.', 'AbortError'));
    return new Promise<void>((resolve, reject) => {
      const onAbort = () => {
        clearTimeout(timer);
        reject(new DOMException('The operation was aborted.', 'AbortError'));
      };
      const timer = setTimeout(() => {
        signal.removeEventListener('abort', onAbort);
        resolve();
      }, ms);
      signal.addEventListener('abort', onAbort, { once: true });
    });
  }
}
