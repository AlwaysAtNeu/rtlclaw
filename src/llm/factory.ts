/**
 * LLM backend factory.
 *
 * Providers like Gemini, DeepSeek, Kimi, Qwen expose OpenAI-compatible APIs,
 * so we route them through the OpenAI backend with different base URLs.
 */

import type { LLMConfig, LLMProvider } from '../config/schema.js';
import type { LLMBackend } from './base.js';
import { FallbackBackend } from './fallback.js';

// ---------------------------------------------------------------------------
// Provider → OpenAI-compatible base URL mapping
// ---------------------------------------------------------------------------

const OPENAI_COMPAT_PROVIDERS: Record<string, string> = {
  gemini:   'https://generativelanguage.googleapis.com/v1beta/openai/',
  deepseek: 'https://api.deepseek.com/v1',
  kimi:     'https://api.moonshot.cn/v1',
  qwen:     'https://dashscope.aliyuncs.com/compatible-mode/v1',
  zhipu:    'https://open.bigmodel.cn/api/coding/paas/v4/',
};

/** Default model for each provider (used when user doesn't specify). */
export const DEFAULT_MODELS: Record<LLMProvider, string> = {
  openai:              'gpt-4.1',
  anthropic:           'claude-sonnet-4-20250514',
  gemini:              'gemini-3.1-pro-preview',
  deepseek:            'deepseek-chat',
  kimi:                'moonshot-v1-128k',
  qwen:                'qwen-max',
  zhipu:               'glm-4.7',
  ollama:              'llama3',
  'openai-compatible': 'gpt-4o',
};

// ---------------------------------------------------------------------------
// Per-model max output tokens
// ---------------------------------------------------------------------------

const MODEL_MAX_TOKENS: Record<string, number> = {
  'gemini-3.1-pro-preview': 65536,
  'gemini-3-pro-preview': 65536,
  'gemini-2.5-flash': 65535,
  'gemini-2.5-pro': 65536,
  'gpt-4.1': 32768,
  'gpt-4o': 16384,
  'o3': 100000,
  'o3-mini': 100000,
  'claude-opus-4-20250514': 128000,
  'claude-sonnet-4-20250514': 64000,
  'claude-haiku-4-5-20251001': 64000,
  'glm-4.7': 16384,
  'glm-5': 16384,
  'glm-5-turbo': 8192,
  'deepseek-chat': 8192,
  'moonshot-v1-128k': 4096,
  'qwen-max': 8192,
};

/**
 * Returns the known max output tokens for the given model, or undefined if
 * the model is not in the map (in which case the API default should be used).
 */
export function getMaxOutputTokens(_provider: string, model: string): number | undefined {
  return MODEL_MAX_TOKENS[model];
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export async function createBackend(config: LLMConfig): Promise<LLMBackend> {
  const options = {
    model: config.model,
    apiKey: config.apiKey,
    baseUrl: config.baseUrl,
    timeoutMs: config.timeoutMs,
  };

  // Anthropic has its own SDK
  if (config.provider === 'anthropic') {
    const { AnthropicBackend } = await import('./anthropic.js');
    return new AnthropicBackend(options);
  }

  // Ollama has its own HTTP API format
  if (config.provider === 'ollama') {
    const { OllamaBackend } = await import('./ollama.js');
    return new OllamaBackend(options);
  }

  // Everything else goes through OpenAI SDK (native or compatible)
  const { OpenAIBackend } = await import('./openai.js');

  // Known OpenAI-compatible providers: inject base URL if not overridden
  if (config.provider !== 'openai' && config.provider !== 'openai-compatible') {
    const defaultBase = OPENAI_COMPAT_PROVIDERS[config.provider];
    if (defaultBase && !options.baseUrl) {
      options.baseUrl = defaultBase;
    }
  }

  return new OpenAIBackend(options);
}

/**
 * Create a backend with optional fallback. If fallbackConfig is provided,
 * wraps primary + fallback in a FallbackBackend that auto-switches on
 * transient errors.
 */
export async function createBackendWithFallback(
  primaryConfig: LLMConfig,
  fallbackConfig?: LLMConfig,
  onSwitch?: (from: string, to: string, error: string) => void,
): Promise<LLMBackend> {
  const primary = await createBackend(primaryConfig);
  if (!fallbackConfig) return primary;

  const fallback = await createBackend(fallbackConfig);
  return new FallbackBackend(primary, fallback, onSwitch);
}
