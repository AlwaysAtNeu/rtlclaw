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

/** Available models per provider for selection UI. First entry is the default. */
export const PROVIDER_MODELS: Record<LLMProvider, string[]> = {
  openai:              ['gpt-4.1', 'gpt-4.1-mini', 'gpt-4.1-nano', 'o3', 'o4-mini', 'o3-mini'],
  anthropic:           ['claude-sonnet-4-6', 'claude-opus-4-6', 'claude-haiku-4-5-20251001'],
  gemini:              ['gemini-3.1-pro-preview', 'gemini-3-flash-preview', 'gemini-2.5-pro', 'gemini-2.5-flash', 'gemini-2.5-flash-lite', 'gemini-3.1-flash-lite-preview'],
  deepseek:            ['deepseek-chat', 'deepseek-reasoner'],
  kimi:                ['kimi-k2.5', 'kimi-k2-0905-preview', 'kimi-k2-turbo-preview', 'kimi-k2-thinking', 'kimi-k2-thinking-turbo', 'moonshot-v1-128k'],
  qwen:                ['qwen3.6-plus', 'qwen3-max', 'qwen3.5-plus', 'qwen3.5-flash', 'qwen-max', 'qwen-plus'],
  zhipu:               ['glm-5.1', 'glm-5', 'glm-5-turbo', 'glm-4.7', 'glm-4.7-flash'],
  ollama:              ['llama3.3', 'qwen2.5-coder', 'deepseek-r1', 'codellama', 'mistral', 'phi4'],
  'openai-compatible': ['gpt-4o'],
};

/** Default model for a provider (first entry in PROVIDER_MODELS). */
export function getDefaultModel(provider: LLMProvider): string {
  return PROVIDER_MODELS[provider][0];
}

// ---------------------------------------------------------------------------
// Per-model max output tokens
// ---------------------------------------------------------------------------

/**
 * Max output tokens per model, verified against official provider docs.
 * Sources listed inline. Last verified: 2026-04-14.
 */
const MODEL_MAX_TOKENS: Record<string, number> = {
  // OpenAI — https://platform.openai.com/docs/models
  'gpt-4.1':      32768,   // verified: OpenRouter max_completion_tokens
  'gpt-4.1-mini': 32768,   // verified: OpenRouter max_completion_tokens
  'gpt-4.1-nano': 32768,   // same family
  'o3':           100000,   // verified: OpenRouter max_completion_tokens
  'o4-mini':      100000,   // verified: OpenRouter max_completion_tokens
  'o3-mini':      100000,   // same family
  // Anthropic — https://platform.claude.com/docs/en/about-claude/models/overview
  'claude-opus-4-6':           128000,  // verified: official docs "128k"
  'claude-sonnet-4-6':         64000,   // verified: official docs "64k"
  'claude-haiku-4-5-20251001': 64000,   // verified: official docs "64k"
  // Gemini — https://ai.google.dev/gemini-api/docs/models
  'gemini-3.1-pro-preview':        65536,
  'gemini-3-flash-preview':        65536,
  'gemini-2.5-pro':                65536,
  'gemini-2.5-flash':              65536,  // verified: multiple sources
  'gemini-2.5-flash-lite':         65536,
  'gemini-3.1-flash-lite-preview': 65536,
  // DeepSeek — https://api-docs.deepseek.com/quick_start/pricing
  'deepseek-chat':     8192,   // verified: pricing page "max 8K"
  'deepseek-reasoner': 65536,  // verified: pricing page "max 64K"
  // Kimi — https://platform.kimi.com/docs (256K context, default output 32768)
  'kimi-k2.5':              65536,
  'kimi-k2-0905-preview':   65536,
  'kimi-k2-turbo-preview':  65536,
  'kimi-k2-thinking':       65536,
  'kimi-k2-thinking-turbo': 65536,
  'moonshot-v1-128k':       65536,
  // Qwen — https://help.aliyun.com/zh/model-studio/models
  'qwen3.6-plus':  65536,  // same gen as qwen3.5-plus
  'qwen3-max':     32768,  // verified: OpenRouter max_completion_tokens
  'qwen3.5-plus':  65536,  // verified: search results
  'qwen3.5-flash': 65536,  // verified: OpenRouter max_completion_tokens
  'qwen-max':      8192,   // verified: official Aliyun docs (legacy)
  'qwen-plus':     32768,
  // 智谱 GLM — https://docs.bigmodel.cn (model cap 128K, API max_tokens cap 65536)
  'glm-5.1':      65536,   // verified: official docs
  'glm-5':        65536,   // verified: official docs
  'glm-5-turbo':  65536,   // verified: official docs
  'glm-4.7':      65536,   // verified: official docs
  'glm-4.7-flash': 65536,
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

  try {
    const fallback = await createBackend(fallbackConfig);
    return new FallbackBackend(primary, fallback, onSwitch);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`  [Warning] Fallback LLM (${fallbackConfig.provider}) init failed: ${msg}\n`);
    process.stderr.write(`  Continuing with primary provider only.\n`);
    return primary;
  }
}
