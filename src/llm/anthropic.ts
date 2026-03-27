/**
 * Anthropic Claude backend.
 */

import Anthropic from '@anthropic-ai/sdk';
import { LLMBackend, type LLMBackendOptions } from './base.js';
import { getMaxOutputTokens } from './factory.js';
import type { LLMResponse, Message, StreamChunk, ToolCall, ToolSchema, LLMCompleteOptions } from './types.js';

export class AnthropicBackend extends LLMBackend {
  private client: Anthropic;

  constructor(options: LLMBackendOptions) {
    super(options);
    this.client = new Anthropic({
      apiKey: this.apiKey,
      baseURL: this.baseUrl,
      timeout: this.timeoutMs,
    });
  }

  get providerName(): string {
    return 'anthropic';
  }

  private convertMessages(messages: Message[]): { system: string; msgs: Anthropic.MessageParam[] } {
    let system = '';
    const msgs: Anthropic.MessageParam[] = [];

    for (const msg of messages) {
      if (msg.role === 'system') {
        system = msg.content;
      } else if (msg.role === 'user') {
        msgs.push({ role: 'user', content: msg.content });
      } else if (msg.role === 'assistant') {
        const content: Anthropic.ContentBlockParam[] = [];
        if (msg.content) content.push({ type: 'text', text: msg.content });
        if (msg.toolCalls) {
          for (const tc of msg.toolCalls) {
            content.push({
              type: 'tool_use',
              id: tc.id,
              name: tc.name,
              input: tc.arguments,
            });
          }
        }
        msgs.push({ role: 'assistant', content });
      } else if (msg.role === 'tool' && msg.toolResult) {
        msgs.push({
          role: 'user',
          content: [{
            type: 'tool_result',
            tool_use_id: msg.toolResult.toolCallId,
            content: msg.toolResult.content,
            is_error: msg.toolResult.isError,
          }],
        });
      }
    }

    return { system, msgs };
  }

  private convertTools(tools: ToolSchema[]): Anthropic.Tool[] {
    return tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.parameters as Anthropic.Tool.InputSchema,
    }));
  }

  async complete(
    messages: Message[],
    options?: LLMCompleteOptions,
  ): Promise<LLMResponse> {
    const { system, msgs } = this.convertMessages(messages);

    const maxTokens = options?.maxTokens ?? getMaxOutputTokens(this.providerName, this.model) ?? 4096;
    const params: Anthropic.MessageCreateParamsNonStreaming = {
      model: this.model,
      messages: msgs,
      max_tokens: maxTokens,
      temperature: options?.temperature ?? 0.2,
    };
    if (system) params.system = system;
    if (options?.tools?.length) params.tools = this.convertTools(options.tools);

    // Retry with exponential backoff for transient errors
    const MAX_RETRIES = 2;
    let lastError: unknown;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        const response = await this.client.messages.create(params);

        let content = '';
        const toolCalls: ToolCall[] = [];

        for (const block of response.content) {
          if (block.type === 'text') {
            content += block.text;
          } else if (block.type === 'tool_use') {
            toolCalls.push({
              id: block.id,
              name: block.name,
              arguments: block.input as Record<string, unknown>,
            });
          }
        }

        return {
          content,
          toolCalls,
          finishReason: response.stop_reason ?? 'end_turn',
          usage: {
            promptTokens: response.usage.input_tokens,
            completionTokens: response.usage.output_tokens,
          },
        };
      } catch (err) {
        lastError = err;
        const msg = err instanceof Error ? err.message : String(err);
        const isTransient = /terminated|timed?\s*out|ECONNRESET|ETIMEDOUT|socket hang up|overloaded|499|5\d\d|Connection error|ENOTFOUND|EAI_AGAIN|fetch failed/i.test(msg);
        if (!isTransient || attempt >= MAX_RETRIES) throw err;
        const delay = (attempt + 1) * 2000;
        await new Promise(r => setTimeout(r, delay));
      }
    }
    throw lastError;
  }

  async *stream(
    messages: Message[],
    options?: LLMCompleteOptions,
  ): AsyncIterable<StreamChunk> {
    const { system, msgs } = this.convertMessages(messages);

    const maxTokens = options?.maxTokens ?? getMaxOutputTokens(this.providerName, this.model) ?? 4096;
    const params: Anthropic.MessageCreateParamsStreaming = {
      model: this.model,
      messages: msgs,
      max_tokens: maxTokens,
      temperature: options?.temperature ?? 0.2,
      stream: true,
    };
    if (system) params.system = system;

    const MAX_RETRIES = 2;
    let lastError: unknown;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        const stream = this.client.messages.stream(params);
        for await (const event of stream) {
          if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
            yield { content: event.delta.text, done: false };
          }
        }
        yield { content: '', done: true };
        return;
      } catch (err) {
        lastError = err;
        const msg = err instanceof Error ? err.message : String(err);
        const isTransient = /terminated|timed?\s*out|ECONNRESET|ETIMEDOUT|socket hang up|overloaded|499|5\d\d|Connection error|ENOTFOUND|EAI_AGAIN|fetch failed/i.test(msg);
        if (!isTransient || attempt >= MAX_RETRIES) throw err;
        const delay = (attempt + 1) * 2000;
        await new Promise(r => setTimeout(r, delay));
      }
    }
    throw lastError;
  }
}
