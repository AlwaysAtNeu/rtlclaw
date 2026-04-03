/**
 * Fallback LLM backend wrapper.
 *
 * Tries the primary backend first. On ANY failure (including hang/timeout),
 * switches to the fallback. If fallback also fails, throws the fallback error.
 *
 * "Sticky" switching: once the primary fails, all subsequent calls go directly
 * to the fallback without retrying the primary. This avoids noisy repeated
 * errors (e.g. Gemini 400 on every tool-calling round).
 *
 * Wall-clock timeout: complete() races the primary call against a deadline.
 * If the primary hangs (server accepts connection but never responds),
 * the timeout fires and triggers fallback. Without this, a hanging primary
 * blocks forever because no error is thrown for the catch block to handle.
 */

import { LLMBackend } from './base.js';
import type { LLMResponse, Message, StreamChunk, LLMCompleteOptions } from './types.js';

/** Wall-clock timeout for primary backend complete() calls (ms). */
const PRIMARY_TIMEOUT_MS = 300_000; // 5 minutes

export class FallbackBackend extends LLMBackend {
  private primary: LLMBackend;
  private fallback: LLMBackend;
  private onSwitch?: (from: string, to: string, error: string) => void;
  /** Once true, all calls go directly to fallback. */
  private useFallback = false;

  constructor(
    primary: LLMBackend,
    fallback: LLMBackend,
    onSwitch?: (from: string, to: string, error: string) => void,
  ) {
    super({ model: 'fallback', timeoutMs: 600000 });
    this.primary = primary;
    this.fallback = fallback;
    this.onSwitch = onSwitch;
  }

  get providerName(): string {
    if (this.useFallback) return this.fallback.providerName;
    return `${this.primary.providerName}+${this.fallback.providerName}`;
  }

  private switchToFallback(errMsg: string): void {
    if (!this.useFallback) {
      this.useFallback = true;
      this.onSwitch?.(this.primary.providerName, this.fallback.providerName, errMsg);
    }
  }

  async complete(messages: Message[], options?: LLMCompleteOptions): Promise<LLMResponse> {
    if (this.useFallback) {
      return this.fallback.complete(messages, options);
    }

    // Race primary against a wall-clock timeout.
    // This catches the case where the primary hangs indefinitely
    // (server alive but never sends response data) — no error is thrown,
    // so the catch block alone is insufficient.
    //
    // We use Promise.race instead of AbortController because not all
    // backends propagate the signal (e.g. Anthropic SDK doesn't use it).
    // The abandoned primary promise will eventually resolve/reject on its own;
    // its result is simply discarded.
    const timeoutMs = options?.timeoutMs ?? PRIMARY_TIMEOUT_MS;

    try {
      let timer: ReturnType<typeof setTimeout>;
      const timeoutPromise = new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`Primary backend timed out after ${timeoutMs / 1000}s`)),
          timeoutMs,
        );
        if (timer.unref) timer.unref();
      });

      const result = await Promise.race([
        this.primary.complete(messages, options),
        timeoutPromise,
      ]);
      clearTimeout(timer!);
      return result;
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      this.switchToFallback(errMsg);
      return this.fallback.complete(messages, options);
    }
  }

  async *stream(
    messages: Message[],
    options?: LLMCompleteOptions & { signal?: AbortSignal },
  ): AsyncIterable<StreamChunk> {
    if (this.useFallback) {
      yield* this.fallback.stream(messages, options);
      return;
    }
    try {
      const iter = this.primary.stream(messages, options);
      let firstChunk = true;
      for await (const chunk of iter) {
        firstChunk = false;
        yield chunk;
      }
      if (firstChunk) return;
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      this.switchToFallback(errMsg);
      yield* this.fallback.stream(messages, options);
    }
  }
}
