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

  abstract get providerName(): string;
}
