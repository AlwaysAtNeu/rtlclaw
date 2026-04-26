/**
 * Configuration schema and types for RTL-Claw.
 */

/** Supported LLM providers. */
export type LLMProvider =
  | 'openai'
  | 'anthropic'
  | 'gemini'
  | 'deepseek'
  | 'kimi'
  | 'qwen'
  | 'zhipu'
  | 'ollama'
  | 'openai-compatible';

export interface LLMConfig {
  provider: LLMProvider;
  model: string;
  apiKey?: string;
  baseUrl?: string;
  temperature: number;
  timeoutMs: number;
}

export interface ToolsConfig {
  /** YAML file paths for custom tool definitions */
  customTools: string[];
  /** Whether LLM can execute arbitrary shell commands */
  allowShellCommands: boolean;
  /** Commands that require user confirmation before execution */
  confirmCommands: string[];
}

export interface ProjectDefaults {
  defaultSimulator: string;
  defaultSynthesizer: string;
  hdlStandard: 'verilog2001' | 'verilog2005' | 'sv2012' | 'sv2017' | 'vhdl2008';
  targetDevice?: string;
}

export interface DebugConfig {
  /** Max retries for the same error pattern */
  sameErrorMaxRetries: number;
  /** Total iteration cap across all errors */
  totalIterationCap: number;
  vcdTimeMarginNs: number;
  maxSignalsPerQuery: number;
  /** Configurable pass/fail regex patterns */
  passPatterns: string[];
  failPatterns: string[];
}

export interface AppConfig {
  llm: LLMConfig;
  /** Fallback LLM provider — used when primary fails with transient errors */
  fallbackLlm?: LLMConfig;
  tools: ToolsConfig;
  project: ProjectDefaults;
  debug: DebugConfig;
  /** Auto mode: skip confirmations */
  autoMode: boolean;
  /** Storage directory for projects and sessions */
  storageDir: string;
  logLevel: 'debug' | 'info' | 'warn' | 'error';
}

export const DEFAULT_CONFIG: AppConfig = {
  llm: {
    provider: 'openai',
    model: 'gpt-4.1',
    temperature: 0.2,
    timeoutMs: 600000,
  },
  tools: {
    customTools: [],
    allowShellCommands: true,
    confirmCommands: ['rm', 'git push', 'vivado', 'dc_shell'],
  },
  project: {
    defaultSimulator: 'iverilog',
    defaultSynthesizer: 'yosys',
    hdlStandard: 'verilog2001',
  },
  debug: {
    sameErrorMaxRetries: 8,
    totalIterationCap: 32,
    vcdTimeMarginNs: 100,
    maxSignalsPerQuery: 20,
    passPatterns: ['\\bTEST PASSED\\b', '\\bPASS\\b', '\\bSUCCESS\\b', '\\bALL TESTS PASSED\\b'],
    failPatterns: ['\\bTEST FAILED\\b', '\\bFAIL\\b', '\\bERROR\\b'],
  },
  autoMode: false,
  storageDir: '~/.rtl-claw',
  logLevel: 'info',
};
