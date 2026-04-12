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
 * Idle timeout: both complete() and stream() use an idle-reset timer that
 * resets whenever the primary backend reports activity (any streaming chunk,
 * including reasoning/thinking tokens). Only fires if no data arrives for
 * the configured timeout, preventing false switches for reasoning models
 * that stream thinking tokens for extended periods.
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

    // Idle timeout: resets whenever the primary backend reports chunk activity
    // (any streaming data, including reasoning/thinking tokens).
    // This replaces the old wall-clock Promise.race timeout that couldn't
    // distinguish "model actively thinking" from "connection dead", causing
    // false fallback switches for reasoning models like GLM-5.1.
    const timeoutMs = this.getTimeoutMs(options);
    const controller = new AbortController();
    let timer = setTimeout(() => controller.abort(), timeoutMs);
    if (timer.unref) timer.unref();

    const resetTimer = () => {
      clearTimeout(timer);
      timer = setTimeout(() => controller.abort(), timeoutMs);
      if (timer.unref) timer.unref();
    };

    // Link user's abort signal to our controller so Esc propagates
    const userSignal = options?.signal;
    const onUserAbort = () => controller.abort();
    if (userSignal?.aborted) {
      clearTimeout(timer);
      throw new DOMException('The operation was aborted.', 'AbortError');
    }
    userSignal?.addEventListener('abort', onUserAbort, { once: true });

    try {
      const result = await this.primary.complete(messages, {
        ...options,
        signal: controller.signal,
        onActivity: resetTimer,
      });
      clearTimeout(timer);
      userSignal?.removeEventListener('abort', onUserAbort);
      return result;
    } catch (err) {
      clearTimeout(timer);
      userSignal?.removeEventListener('abort', onUserAbort);
      // User-initiated abort — don't switch to fallback, just re-throw
      if (userSignal?.aborted) {
        throw err;
      }
      // Idle timeout or other error → switch to fallback
      const errMsg = err instanceof Error
        ? (err.name === 'AbortError'
          ? `Primary backend idle timeout after ${timeoutMs / 1000}s`
          : err.message)
        : String(err);
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

    // Link user's abort signal to our controller so Esc propagates
    const userSignal = options?.signal;
    const onUserAbort = () => controller.abort();
    if (userSignal?.aborted) {
      clearTimeout(timer);
      throw new DOMException('The operation was aborted.', 'AbortError');
    }
    userSignal?.addEventListener('abort', onUserAbort, { once: true });

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
      userSignal?.removeEventListener('abort', onUserAbort);
      if (firstChunk) return;
    } catch (err) {
      clearTimeout(timer);
      userSignal?.removeEventListener('abort', onUserAbort);
      // User-initiated abort — don't switch to fallback, just re-throw
      if (userSignal?.aborted) {
        throw err;
      }
      // Idle timeout or other error → switch to fallback
      const errMsg = err instanceof Error
        ? (err.name === 'AbortError'
          ? `Primary stream idle timeout after ${timeoutMs / 1000}s`
          : err.message)
        : String(err);
      this.switchToFallback(errMsg);
      yield* this.fallback.stream(messages, options);
    }
  }
}
