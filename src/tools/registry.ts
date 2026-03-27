/**
 * EDA tool registry.
 * Loads tool definitions from YAML configs and checks tool availability.
 */

import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { parse as parseYaml } from 'yaml';

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ErrorPattern {
  pattern: string;
  severity: 'error' | 'warning';
  fileGroup?: number;
  lineGroup?: number;
  messageGroup: number;
}

export interface ToolCommand {
  [key: string]: string;
}

export interface ToolDefinition {
  name: string;
  displayName: string;
  category: 'simulator' | 'synthesizer' | 'viewer' | 'utility';
  executable: string;
  commands: ToolCommand;
  fileExtensions: string[];
  errorPatterns: ErrorPattern[];
  /** Whether the tool is available on the current system */
  available?: boolean;
  /** Path to the executable if found */
  executablePath?: string;
}

interface YamlToolEntry {
  name: string;
  displayName: string;
  category: string;
  executable: string;
  commands: Record<string, string>;
  fileExtensions: string[];
  errorPatterns: Array<{
    pattern: string;
    severity: string;
    fileGroup?: number;
    lineGroup?: number;
    messageGroup: number;
  }>;
}

interface YamlToolsFile {
  tools: Record<string, YamlToolEntry>;
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

export class ToolRegistry {
  private tools = new Map<string, ToolDefinition>();

  /**
   * Load built-in tool definitions from the bundled YAML file.
   */
  async loadBuiltins(): Promise<void> {
    // Resolve path relative to this file
    const thisDir = dirname(fileURLToPath(import.meta.url));
    const yamlPath = resolve(thisDir, '..', '..', 'src', 'tools', 'builtin-tools.yaml');

    // Try the source path first, then fall back to a sibling path (for dist/)
    let content: string;
    try {
      content = await readFile(yamlPath, 'utf-8');
    } catch {
      // When running from dist/, try relative to dist
      const altPath = resolve(thisDir, 'builtin-tools.yaml');
      content = await readFile(altPath, 'utf-8');
    }

    this.loadFromYamlContent(content);
    await this.checkAvailability();
  }

  /**
   * Load custom tool definitions from a user-provided YAML file.
   */
  async loadCustom(yamlPath: string): Promise<void> {
    const absPath = resolve(yamlPath);
    const content = await readFile(absPath, 'utf-8');
    this.loadFromYamlContent(content);
    await this.checkAvailability();
  }

  /**
   * List all tools that are available (installed) on the system.
   */
  listAvailable(): ToolDefinition[] {
    return [...this.tools.values()].filter(t => t.available);
  }

  /**
   * Get a tool definition by name. Returns undefined if not found.
   */
  get(name: string): ToolDefinition | undefined {
    return this.tools.get(name);
  }

  /**
   * Get all registered tool definitions.
   */
  getAll(): ToolDefinition[] {
    return [...this.tools.values()];
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  private loadFromYamlContent(content: string): void {
    const parsed = parseYaml(content) as YamlToolsFile;
    if (!parsed?.tools) return;

    for (const [key, entry] of Object.entries(parsed.tools)) {
      const tool: ToolDefinition = {
        name: entry.name ?? key,
        displayName: entry.displayName ?? key,
        category: (entry.category ?? 'utility') as ToolDefinition['category'],
        executable: entry.executable ?? key,
        commands: entry.commands ?? {},
        fileExtensions: entry.fileExtensions ?? [],
        errorPatterns: (entry.errorPatterns ?? []).map(ep => ({
          pattern: ep.pattern,
          severity: (ep.severity ?? 'error') as ErrorPattern['severity'],
          fileGroup: ep.fileGroup,
          lineGroup: ep.lineGroup,
          messageGroup: ep.messageGroup ?? 0,
        })),
        available: false,
      };
      this.tools.set(tool.name, tool);
    }
  }

  private async checkAvailability(): Promise<void> {
    const checks = [...this.tools.values()].map(async tool => {
      try {
        const { stdout } = await execFileAsync('which', [tool.executable]);
        tool.available = true;
        tool.executablePath = stdout.trim();
      } catch {
        tool.available = false;
        tool.executablePath = undefined;
      }
    });
    await Promise.all(checks);
  }
}
