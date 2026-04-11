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

/** Default fallback timeout if not derivable from backend config (ms). */
const DEFAULT_FALLBACK_TIMEOUT_MS = 600_000; // 10 minutes

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

  /** Get the effective timeout: from options, primary backend config, or default. */
  private getTimeoutMs(options?: LLMCompleteOptions): number {
    return options?.timeoutMs ?? this.primary.configuredTimeoutMs ?? DEFAULT_FALLBACK_TIMEOUT_MS;
  }

  async complete(messages: Message[], options?: LLMCompleteOptions): Promise<LLMResponse> {
    if (this.useFallback) {
      return this.fallback.complete(messages, options);
    }

    // Safety-net timeout: slightly longer than the backend's own timeout
    // so the backend's error (with detailed message) fires first in normal
    // cases. This only fires if the backend hangs without throwing.
    const timeoutMs = this.getTimeoutMs(options) + 30_000; // +30s margin
    let timer: ReturnType<typeof setTimeout> | undefined;

    try {
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
      clearTimeout(timer);
      return result;
    } catch (err) {
      if (timer) clearTimeout(timer);
      // User-initiated abort — don't switch to fallback, just re-throw
      if (err instanceof Error && (err.name === 'AbortError' || err.message.includes('aborted'))) {
        throw err;
      }
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

    // Idle timeout: resets on each chunk received. Only fires if the
    // primary stream hangs (no data for timeoutMs). Long-but-active
    // streams are not affected.
    const timeoutMs = this.getTimeoutMs(options);
    const controller = new AbortController();
    let timer = setTimeout(() => controller.abort(), timeoutMs);
    if (timer.unref) timer.unref();

    const resetTimer = () => {
      clearTimeout(timer);
      timer = setTimeout(() => controller.abort(), timeoutMs);
      if (timer.unref) timer.unref();
    };

    try {
      const iter = this.primary.stream(messages, {
        ...options,
        signal: controller.signal,
      });
      let firstChunk = true;
      for await (const chunk of iter) {
        firstChunk = false;
        resetTimer();
        yield chunk;
      }
      clearTimeout(timer);
      if (firstChunk) return;
    } catch (err) {
      clearTimeout(timer);
      // User-initiated abort — don't switch to fallback, just re-throw
      if (err instanceof Error && (err.name === 'AbortError' || err.message.includes('aborted'))) {
        throw err;
      }
      const isAbort = err instanceof Error && err.name === 'AbortError';
      const errMsg = isAbort
        ? `Primary stream timed out after ${timeoutMs / 1000}s`
        : (err instanceof Error ? err.message : String(err));
      this.switchToFallback(errMsg);
      yield* this.fallback.stream(messages, options);
    }
  }
}
