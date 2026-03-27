/**
 * Unified message types for LLM communication.
 */

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface ToolResult {
  toolCallId: string;
  content: string;
  isError: boolean;
}

export interface Message {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  toolCalls?: ToolCall[];
  toolResult?: ToolResult;
}

export interface LLMResponse {
  content: string;
  toolCalls: ToolCall[];
  finishReason: string;
  usage: { promptTokens: number; completionTokens: number };
  /** Number of retries needed (0 = succeeded on first attempt) */
  retryCount?: number;
}

export interface StreamChunk {
  content: string;
  done: boolean;
}

export interface ToolSchema {
  name: string;
  description: string;
  parameters: {
    type: 'object';
    properties: Record<string, {
      type: string;
      description: string;
      enum?: string[];
      items?: { type: string };
    }>;
    required?: string[];
  };
}

export interface LLMCompleteOptions {
  tools?: ToolSchema[];
  temperature?: number;
  maxTokens?: number;
  /** Force JSON output when function calling is unavailable */
  responseFormat?: 'json' | 'text';
  /** Per-request timeout in ms (overrides client default) */
  timeoutMs?: number;
  /** Abort signal for cancelling the request */
  signal?: AbortSignal;
}
