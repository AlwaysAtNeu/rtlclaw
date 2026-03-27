/**
 * OpenAI / OpenAI-compatible backend.
 */

import OpenAI from 'openai';
import { LLMBackend, type LLMBackendOptions } from './base.js';
import { getMaxOutputTokens } from './factory.js';
import { createH2Fetch } from './h2-fetch.js';
import type { LLMResponse, Message, StreamChunk, ToolCall, ToolSchema, LLMCompleteOptions } from './types.js';

export class OpenAIBackend extends LLMBackend {
  private client: OpenAI;

  constructor(options: LLMBackendOptions) {
    super(options);
    this.client = new OpenAI({
      apiKey: this.apiKey,
      baseURL: this.baseUrl,
      timeout: 300_000,  // 5 min — streaming keeps connection alive; 5 min silence = dead connection, retry faster
      maxRetries: 0,
      // Use HTTP/2 with PING keep-alive to prevent idle connection drops.
      // Thinking models (Gemini 3.x, o3) have long idle periods during
      // reasoning; HTTP/2 PING frames keep the connection alive.
      fetch: createH2Fetch(),
    });
  }

  get providerName(): string {
    if (!this.baseUrl) return 'openai';
    if (this.baseUrl.includes('generativelanguage.googleapis')) return 'gemini';
    if (this.baseUrl.includes('deepseek')) return 'deepseek';
    if (this.baseUrl.includes('moonshot')) return 'kimi';
    if (this.baseUrl.includes('dashscope')) return 'qwen';
    if (this.baseUrl.includes('bigmodel')) return 'zhipu';
    return 'openai-compat';
  }

  private convertMessages(messages: Message[]): OpenAI.ChatCompletionMessageParam[] {
    return messages.map((msg): OpenAI.ChatCompletionMessageParam => {
      if (msg.role === 'system') {
        return { role: 'system', content: msg.content };
      }
      if (msg.role === 'user') {
        return { role: 'user', content: msg.content };
      }
      if (msg.role === 'assistant') {
        const result: OpenAI.ChatCompletionAssistantMessageParam = {
          role: 'assistant',
          content: msg.content || null,
        };
        if (msg.toolCalls?.length) {
          result.tool_calls = msg.toolCalls.map((tc) => ({
            id: tc.id,
            type: 'function' as const,
            function: { name: tc.name, arguments: JSON.stringify(tc.arguments) },
          }));
        }
        return result;
      }
      // tool
      return {
        role: 'tool',
        tool_call_id: msg.toolResult!.toolCallId,
        content: msg.toolResult!.content,
      };
    });
  }

  private convertTools(tools: ToolSchema[]): OpenAI.ChatCompletionTool[] {
    return tools.map((t) => ({
      type: 'function' as const,
      function: {
        name: t.name,
        description: t.description,
        parameters: t.parameters,
      },
    }));
  }

  async complete(
    messages: Message[],
    options?: LLMCompleteOptions,
  ): Promise<LLMResponse> {
    const maxTokens = options?.maxTokens ?? getMaxOutputTokens(this.providerName, this.model);

    // Use streaming internally to keep the connection alive.
    // Non-streaming requests sit idle while the server "thinks", causing
    // network middleboxes (NAT, proxy, firewall) to drop the connection
    // after their idle timeout (often 30–120 s).  Streaming sends chunks
    // continuously, preventing idle-connection drops.
    const params: OpenAI.ChatCompletionCreateParamsStreaming = {
      model: this.model,
      messages: this.convertMessages(messages),
      temperature: options?.temperature ?? 0.2,
      ...(maxTokens !== undefined ? { max_tokens: maxTokens } : {}),
      stream: true,
      stream_options: { include_usage: true },
    };
    if (options?.tools?.length) {
      params.tools = this.convertTools(options.tools);
    }
    if (options?.responseFormat === 'json') {
      params.response_format = { type: 'json_object' };
    }

    // Retry with exponential backoff for transient errors
    const MAX_RETRIES = 2;
    let lastError: unknown;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      const startMs = Date.now();
      try {
        const reqOptions: Record<string, unknown> = { maxRetries: 0 };
        if (options?.timeoutMs) reqOptions.timeout = options.timeoutMs;
        if (options?.signal) reqOptions.signal = options.signal;

        const stream = await this.client.chat.completions.create(params, reqOptions);

        // Collect streamed chunks into a complete response
        let content = '';
        let finishReason = 'stop';
        let promptTokens = 0;
        let completionTokens = 0;
        // Tool call accumulation: index → {id, name, arguments}
        const toolCallMap = new Map<number, { id: string; name: string; args: string }>();

        for await (const chunk of stream) {
          const choice = chunk.choices[0];
          if (choice) {
            if (choice.delta?.content) {
              content += choice.delta.content;
            }
            // Accumulate tool calls from deltas
            if (choice.delta?.tool_calls) {
              for (const tc of choice.delta.tool_calls) {
                const existing = toolCallMap.get(tc.index);
                if (existing) {
                  if (tc.function?.arguments) existing.args += tc.function.arguments;
                } else {
                  toolCallMap.set(tc.index, {
                    id: tc.id ?? '',
                    name: tc.function?.name ?? '',
                    args: tc.function?.arguments ?? '',
                  });
                }
              }
            }
            if (typeof choice.finish_reason === 'string') {
              finishReason = choice.finish_reason;
            }
          }
          // Usage comes in the final chunk (stream_options: include_usage)
          if (chunk.usage) {
            promptTokens = chunk.usage.prompt_tokens ?? 0;
            completionTokens = chunk.usage.completion_tokens ?? 0;
          }
        }

        // Convert accumulated tool calls
        const toolCalls: ToolCall[] = [];
        for (const [, tc] of [...toolCallMap.entries()].sort((a, b) => a[0] - b[0])) {
          try {
            toolCalls.push({
              id: tc.id,
              name: tc.name,
              arguments: tc.args ? JSON.parse(tc.args) as Record<string, unknown> : {},
            });
          } catch {
            // If JSON parse fails, still include the tool call with raw args
            toolCalls.push({ id: tc.id, name: tc.name, arguments: { _raw: tc.args } });
          }
        }

        return { content, toolCalls, finishReason, usage: { promptTokens, completionTokens }, retryCount: attempt };
      } catch (err) {
        lastError = err;
        const elapsedSec = ((Date.now() - startMs) / 1000).toFixed(1);
        const msg = err instanceof Error ? err.message : String(err);
        const cause = (err as any)?.cause;
        const causeMsg = cause ? ` (cause: ${cause instanceof Error ? cause.message : String(cause)})` : '';
        const errType = err?.constructor?.name ?? 'Error';
        const detail = `[${errType}] ${msg}${causeMsg}`;
        // Retry on transient errors (timeout, network, 5xx)
        const fullMsg = msg + causeMsg;
        const isTransient = /terminated|timed?\s*out|ECONNRESET|ETIMEDOUT|socket hang up|499|5\d\d|Connection error|ENOTFOUND|EAI_AGAIN|fetch failed/i.test(fullMsg);
        if (!isTransient || attempt >= MAX_RETRIES) {
          process.stderr.write(`\n  [LLM] Request failed after ${elapsedSec}s (attempt ${attempt + 1}/${MAX_RETRIES + 1}): ${detail}\n`);
          throw err;
        }
        process.stderr.write(`\n  [LLM] Request failed after ${elapsedSec}s (attempt ${attempt + 1}/${MAX_RETRIES + 1}): ${detail} — retrying in ${(attempt + 1) * 5}s...\n`);
        const delay = (attempt + 1) * 5000; // 5s, 10s
        await new Promise(r => setTimeout(r, delay));
      }
    }
    throw lastError;
  }

  async *stream(
    messages: Message[],
    options?: LLMCompleteOptions & { signal?: AbortSignal },
  ): AsyncIterable<StreamChunk> {
    const maxTokens = options?.maxTokens ?? getMaxOutputTokens(this.providerName, this.model);
    const params: OpenAI.ChatCompletionCreateParamsStreaming = {
      model: this.model,
      messages: this.convertMessages(messages),
      temperature: options?.temperature ?? 0.2,
      ...(maxTokens !== undefined ? { max_tokens: maxTokens } : {}),
      stream: true,
    };

    // Retry stream creation on transient errors
    const MAX_RETRIES = 2;
    let lastError: unknown;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      const startMs = Date.now();
      try {
        const stream = await this.client.chat.completions.create(params, {
          signal: options?.signal ?? null,
          maxRetries: 0,
        });
        for await (const chunk of stream) {
          const delta = chunk.choices[0]?.delta;
          const finishReason = chunk.choices[0]?.finish_reason;
          yield {
            content: delta?.content ?? '',
            done: typeof finishReason === 'string',
          };
        }
        return; // Stream completed successfully
      } catch (err) {
        lastError = err;
        const elapsedSec = ((Date.now() - startMs) / 1000).toFixed(1);
        const msg = err instanceof Error ? err.message : String(err);
        const cause = (err as any)?.cause;
        const causeMsg = cause ? ` (cause: ${cause instanceof Error ? cause.message : String(cause)})` : '';
        const errType = err?.constructor?.name ?? 'Error';
        const detail = `[${errType}] ${msg}${causeMsg}`;
        const fullMsg = msg + causeMsg;
        const isTransient = /terminated|timed?\s*out|ECONNRESET|ETIMEDOUT|socket hang up|499|5\d\d|Connection error|ENOTFOUND|EAI_AGAIN|fetch failed/i.test(fullMsg);
        if (!isTransient || attempt >= MAX_RETRIES) {
          process.stderr.write(`\n  [LLM] Stream failed after ${elapsedSec}s (attempt ${attempt + 1}/${MAX_RETRIES + 1}): ${detail}\n`);
          throw err;
        }
        process.stderr.write(`\n  [LLM] Stream failed after ${elapsedSec}s (attempt ${attempt + 1}/${MAX_RETRIES + 1}): ${detail} — retrying in ${(attempt + 1) * 5}s...\n`);
        const delay = (attempt + 1) * 5000;
        await new Promise(r => setTimeout(r, delay));
      }
    }
    throw lastError;
  }
}
