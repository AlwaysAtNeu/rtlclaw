/**
 * Ollama local model backend via HTTP API.
 */

import { LLMBackend, type LLMBackendOptions } from './base.js';
import { getMaxOutputTokens } from './factory.js';
import type { LLMResponse, Message, StreamChunk, ToolCall, ToolSchema, LLMCompleteOptions } from './types.js';

export class OllamaBackend extends LLMBackend {
  private baseApiUrl: string;

  constructor(options: LLMBackendOptions) {
    super(options);
    this.baseApiUrl = (options.baseUrl ?? 'http://localhost:11434') + '/api';
  }

  get providerName(): string {
    return 'ollama';
  }

  private convertMessages(messages: Message[]): Array<{ role: string; content: string }> {
    return messages.map((msg) => ({
      role: msg.role === 'tool' ? 'tool' : msg.role,
      content: msg.role === 'tool' ? msg.toolResult!.content : msg.content,
    }));
  }

  async complete(
    messages: Message[],
    options?: LLMCompleteOptions,
  ): Promise<LLMResponse> {
    const maxTokens = options?.maxTokens ?? getMaxOutputTokens(this.providerName, this.model);
    const ollamaOpts: Record<string, unknown> = {
      temperature: options?.temperature ?? 0.2,
    };
    if (maxTokens !== undefined) {
      ollamaOpts['num_predict'] = maxTokens;
    }
    const body: Record<string, unknown> = {
      model: this.model,
      messages: this.convertMessages(messages),
      stream: false,
      options: ollamaOpts,
    };

    if (options?.tools?.length) {
      body['tools'] = options.tools.map((t) => ({
        type: 'function',
        function: { name: t.name, description: t.description, parameters: t.parameters },
      }));
    }
    if (options?.responseFormat === 'json') {
      body['format'] = 'json';
    }

    // Combine user abort signal with timeout
    const signals = [AbortSignal.timeout(this.timeoutMs)];
    if (options?.signal) signals.push(options.signal);
    const response = await fetch(`${this.baseApiUrl}/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.any(signals),
    });

    if (!response.ok) throw new Error(`Ollama error: ${response.status} ${response.statusText}`);
    const data = await response.json() as Record<string, unknown>;
    const message = data['message'] as Record<string, unknown> | undefined;

    const toolCalls: ToolCall[] = [];
    const rawToolCalls = message?.['tool_calls'] as Array<Record<string, unknown>> | undefined;
    if (rawToolCalls) {
      for (const tc of rawToolCalls) {
        const func = tc['function'] as Record<string, unknown>;
        toolCalls.push({
          id: `ollama_${func['name'] as string}`,
          name: func['name'] as string,
          arguments: (func['arguments'] ?? {}) as Record<string, unknown>,
        });
      }
    }

    return {
      content: (message?.['content'] as string) ?? '',
      toolCalls,
      finishReason: 'stop',
      usage: {
        promptTokens: (data['prompt_eval_count'] as number) ?? 0,
        completionTokens: (data['eval_count'] as number) ?? 0,
      },
    };
  }

  async *stream(
    messages: Message[],
    options?: LLMCompleteOptions,
  ): AsyncIterable<StreamChunk> {
    const maxTokens = options?.maxTokens ?? getMaxOutputTokens(this.providerName, this.model);
    const ollamaOpts: Record<string, unknown> = {
      temperature: options?.temperature ?? 0.2,
    };
    if (maxTokens !== undefined) {
      ollamaOpts['num_predict'] = maxTokens;
    }
    const body = {
      model: this.model,
      messages: this.convertMessages(messages),
      stream: true,
      options: ollamaOpts,
    };

    const signals = [AbortSignal.timeout(this.timeoutMs)];
    if (options?.signal) signals.push(options.signal);
    const response = await fetch(`${this.baseApiUrl}/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.any(signals),
    });

    if (!response.ok || !response.body) {
      throw new Error(`Ollama error: ${response.status}`);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      const text = decoder.decode(value);
      for (const line of text.split('\n').filter(Boolean)) {
        const data = JSON.parse(line) as Record<string, unknown>;
        const message = data['message'] as Record<string, unknown> | undefined;
        yield {
          content: (message?.['content'] as string) ?? '',
          done: (data['done'] as boolean) ?? false,
        };
      }
    }
  }
}
