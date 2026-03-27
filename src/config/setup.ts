/**
 * Interactive first-run configuration setup.
 */

import * as readline from 'node:readline';
import type { ConfigManager } from './manager.js';
import type { LLMConfig, LLMProvider } from './schema.js';
import { DEFAULT_MODELS } from '../llm/factory.js';

async function ask(rl: readline.Interface, question: string, defaultVal?: string): Promise<string> {
  return new Promise((resolve) => {
    const prompt = defaultVal ? `${question} [${defaultVal}]: ` : `${question}: `;
    rl.question(prompt, (answer) => {
      resolve(answer.trim() || defaultVal || '');
    });
  });
}

async function select(rl: readline.Interface, question: string, options: string[]): Promise<string> {
  console.log(`\n${question}`);
  options.forEach((opt, i) => console.log(`  ${i + 1}) ${opt}`));
  const answer = await ask(rl, 'Select', '1');
  const idx = parseInt(answer) - 1;
  return options[idx] ?? options[0]!;
}

// Provider display labels → provider key
const PROVIDER_OPTIONS: Array<{ label: string; key: LLMProvider; needsKey: boolean }> = [
  { label: 'OpenAI (GPT-4.1, o3, o4-mini ...)',          key: 'openai',     needsKey: true },
  { label: 'Anthropic (Claude Opus 4, Sonnet 4 ...)',     key: 'anthropic',  needsKey: true },
  { label: 'Google Gemini (gemini-3.1-pro-preview, gemini-2.5-flash)', key: 'gemini', needsKey: true },
  { label: 'DeepSeek (DeepSeek-V3, DeepSeek-R1)',        key: 'deepseek',   needsKey: true },
  { label: 'Kimi / Moonshot (moonshot-v1-128k)',          key: 'kimi',       needsKey: true },
  { label: 'Qwen / DashScope (qwen-max, qwen-plus)',     key: 'qwen',       needsKey: true },
  { label: 'ZAI / Zhipu (GLM-4.7, GLM-5, GLM-5-Turbo)', key: 'zhipu',      needsKey: true },
  { label: 'Ollama (local, no API key)',                  key: 'ollama',     needsKey: false },
  { label: 'OpenAI-compatible (custom endpoint)',         key: 'openai-compatible', needsKey: true },
];

export async function runSetup(configManager: ConfigManager): Promise<void> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  console.log('\n╔══════════════════════════════════════════╗');
  console.log('║      RTL-Claw — First Time Setup         ║');
  console.log('╚══════════════════════════════════════════╝\n');

  // Step 1: LLM Provider
  const providerLabel = await select(
    rl,
    'Select LLM provider:',
    PROVIDER_OPTIONS.map(p => p.label),
  );
  const providerInfo = PROVIDER_OPTIONS.find(p => p.label === providerLabel) ?? PROVIDER_OPTIONS[0]!;
  const providerKey = providerInfo.key;

  // Step 2: Model
  const defaultModel = DEFAULT_MODELS[providerKey];
  const model = await ask(rl, 'Model name', defaultModel);

  // Step 3: API Key
  let apiKey: string | undefined;
  if (providerInfo.needsKey) {
    apiKey = await ask(rl, `${providerKey} API key`);
    if (!apiKey) {
      console.log('\n⚠ No API key provided. Set RTL_CLAW_LLM_API_KEY env var or run `rtl-claw config --setup` later.\n');
    }
  }

  // Step 4: Base URL (for ollama or openai-compatible, or user override)
  let baseUrl: string | undefined;
  if (providerKey === 'ollama') {
    baseUrl = await ask(rl, 'Ollama server URL', 'http://localhost:11434');
  } else if (providerKey === 'openai-compatible') {
    baseUrl = await ask(rl, 'API base URL (e.g. https://api.example.com/v1)');
    if (!baseUrl) {
      console.log('⚠ Base URL is required for openai-compatible provider.');
    }
  }

  // Step 5: Fallback provider (optional)
  const wantFallback = await ask(rl, 'Configure a fallback LLM provider? (y/n)', 'n');
  let fallbackConfig: LLMConfig | undefined;
  if (/^y/i.test(wantFallback)) {
    const fbLabel = await select(
      rl,
      'Select fallback provider:',
      PROVIDER_OPTIONS.map(p => p.label),
    );
    const fbInfo = PROVIDER_OPTIONS.find(p => p.label === fbLabel) ?? PROVIDER_OPTIONS[0]!;
    const fbModel = await ask(rl, 'Fallback model name', DEFAULT_MODELS[fbInfo.key]);
    let fbApiKey: string | undefined;
    if (fbInfo.needsKey) {
      fbApiKey = await ask(rl, `${fbInfo.key} API key`);
    }
    let fbBaseUrl: string | undefined;
    if (fbInfo.key === 'ollama') {
      fbBaseUrl = await ask(rl, 'Ollama server URL', 'http://localhost:11434');
    } else if (fbInfo.key === 'openai-compatible') {
      fbBaseUrl = await ask(rl, 'API base URL');
    }
    fallbackConfig = {
      provider: fbInfo.key,
      model: fbModel,
      apiKey: fbApiKey,
      baseUrl: fbBaseUrl,
      temperature: 0.2,
      timeoutMs: 600000,
    };
  }

  // Step 6: Default simulator
  const simulator = await select(rl, 'Default simulator:', [
    'iverilog',
    'vcs',
    'verilator',
    'xsim (Vivado)',
  ]);
  const simKey = simulator.split(' ')[0]!;

  // Apply configuration
  configManager.setLLM({
    provider: providerKey,
    model,
    apiKey,
    baseUrl,
  });
  if (fallbackConfig) {
    configManager.set('fallbackLlm', fallbackConfig);
  }
  configManager.set('project', {
    ...configManager.config.project,
    defaultSimulator: simKey,
  });

  console.log('\n✓ Configuration saved to:', configManager.configPath);
  console.log('  You can modify it anytime with: rtl-claw config --setup\n');

  rl.close();
}
