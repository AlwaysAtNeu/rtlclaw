/**
 * Fallback LLM backend wrapper.
 *
 * Tries the primary backend first. On ANY failure, switches to the fallback.
 * If fallback also fails, throws the fallback error.
 *
 * "Sticky" switching: once the primary fails, all subsequent calls go directly
 * to the fallback without retrying the primary. This avoids noisy repeated
 * errors (e.g. Gemini 400 on every tool-calling round).
 */

import { LLMBackend } from './base.js';
import type { LLMResponse, Message, StreamChunk, LLMCompleteOptions } from './types.js';

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
    try {
      return await this.primary.complete(messages, options);
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
