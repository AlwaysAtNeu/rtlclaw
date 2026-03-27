/**
 * Configuration manager with interactive first-run setup.
 */

import Conf from 'conf';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { existsSync, mkdirSync } from 'node:fs';
import type { AppConfig, LLMConfig, LLMProvider } from './schema.js';
import { DEFAULT_CONFIG } from './schema.js';

const CONFIG_DIR = join(homedir(), '.rtl-claw');

export class ConfigManager {
  private store: Conf<AppConfig>;

  constructor() {
    this.store = new Conf<AppConfig>({
      projectName: 'rtl-claw',
      defaults: DEFAULT_CONFIG,
    });

    // Migrate: bump timeoutMs if it's still at the old 120s default
    const savedTimeout = this.store.get('llm.timeoutMs' as any) as number | undefined;
    if (savedTimeout && savedTimeout < DEFAULT_CONFIG.llm.timeoutMs) {
      this.store.set('llm.timeoutMs' as any, DEFAULT_CONFIG.llm.timeoutMs);
    }

    // Migrate: default hdlStandard changed from sv2012 to verilog2001
    const savedHdl = this.store.get('project.hdlStandard' as any) as string | undefined;
    if (savedHdl === 'sv2012') {
      this.store.set('project.hdlStandard' as any, 'verilog2001');
    }

    // Ensure storage directory exists
    const storageDir = this.resolveStorageDir();
    if (!existsSync(storageDir)) {
      mkdirSync(storageDir, { recursive: true });
    }
  }

  get config(): AppConfig {
    return this.store.store;
  }

  get llm(): LLMConfig {
    return this.store.get('llm');
  }

  get isConfigured(): boolean {
    const llm = this.llm;
    // Ollama doesn't need an API key
    if (llm.provider === 'ollama') return true;
    return !!llm.apiKey;
  }

  set<K extends keyof AppConfig>(key: K, value: AppConfig[K]): void {
    this.store.set(key, value);
  }

  setLLM(updates: Partial<LLMConfig>): void {
    const current = this.llm;
    this.store.set('llm', { ...current, ...updates });
  }

  get configPath(): string {
    return this.store.path;
  }

  resolveStorageDir(): string {
    const dir = this.store.get('storageDir');
    return dir.startsWith('~') ? join(homedir(), dir.slice(1)) : dir;
  }

  get projectsDir(): string {
    return join(this.resolveStorageDir(), 'projects');
  }

  get sessionsDir(): string {
    return join(this.resolveStorageDir(), 'sessions');
  }

  /** Apply environment variable overrides */
  applyEnvOverrides(): void {
    const env = process.env;

    if (env['RTL_CLAW_LLM_PROVIDER']) {
      this.setLLM({ provider: env['RTL_CLAW_LLM_PROVIDER'] as LLMProvider });
    }
    if (env['RTL_CLAW_LLM_MODEL']) {
      this.setLLM({ model: env['RTL_CLAW_LLM_MODEL'] });
    }
    if (env['RTL_CLAW_LLM_API_KEY']) {
      this.setLLM({ apiKey: env['RTL_CLAW_LLM_API_KEY'] });
    }
    if (env['RTL_CLAW_LLM_BASE_URL']) {
      this.setLLM({ baseUrl: env['RTL_CLAW_LLM_BASE_URL'] });
    }
  }

  /** Reset to defaults */
  reset(): void {
    this.store.clear();
  }
}

/** Singleton config manager */
let _instance: ConfigManager | undefined;

export function getConfigManager(): ConfigManager {
  if (!_instance) {
    _instance = new ConfigManager();
    _instance.applyEnvOverrides();
  }
  return _instance;
}
