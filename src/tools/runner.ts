/**
 * Command executor for EDA tools.
 * Runs shell commands, streams output, and parses errors using tool definitions.
 */

import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import type { ToolRegistry, ErrorPattern } from './registry.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ParsedDiagnostic {
  severity: 'error' | 'warning';
  message: string;
  file?: string;
  line?: number;
}

export interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  /** Execution duration in milliseconds */
  duration: number;
  /** Parsed error diagnostics */
  errors: ParsedDiagnostic[];
  /** Parsed warning diagnostics */
  warnings: ParsedDiagnostic[];
}

export interface RunOptions {
  /** Working directory for the command */
  cwd?: string;
  /** Timeout in milliseconds (0 = no timeout) */
  timeoutMs?: number;
  /** Environment variables to merge with process.env */
  env?: Record<string, string>;
  /** Callback invoked for each line of stdout */
  onStdout?: (line: string) => void;
  /** Callback invoked for each line of stderr */
  onStderr?: (line: string) => void;
  /** Error patterns to use for parsing output */
  errorPatterns?: ErrorPattern[];
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

export class CommandRunner {
  private registry: ToolRegistry | null;

  constructor(registry?: ToolRegistry) {
    this.registry = registry ?? null;
  }

  /**
   * Run a raw shell command.
   */
  async run(cmd: string, opts: RunOptions = {}): Promise<CommandResult> {
    const cwd = opts.cwd ? resolve(opts.cwd) : process.cwd();
    const startTime = Date.now();

    return new Promise<CommandResult>((resolvePromise, reject) => {
      const child = spawn('sh', ['-c', cmd], {
        cwd,
        env: { ...process.env, ...opts.env },
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      const stdoutChunks: string[] = [];
      const stderrChunks: string[] = [];
      let stdoutBuffer = '';
      let stderrBuffer = '';
      let timedOut = false;
      let timeoutHandle: ReturnType<typeof setTimeout> | undefined;

      if (opts.timeoutMs && opts.timeoutMs > 0) {
        timeoutHandle = setTimeout(() => {
          timedOut = true;
          child.kill('SIGTERM');
          // Force kill after 5s if still alive
          setTimeout(() => {
            try { child.kill('SIGKILL'); } catch { /* already dead */ }
          }, 5000);
        }, opts.timeoutMs);
      }

      child.stdout.on('data', (data: Buffer) => {
        const text = data.toString();
        stdoutChunks.push(text);

        if (opts.onStdout) {
          stdoutBuffer += text;
          const lines = stdoutBuffer.split('\n');
          // Keep the last incomplete line in the buffer
          stdoutBuffer = lines.pop() ?? '';
          for (const line of lines) {
            opts.onStdout(line);
          }
        }
      });

      child.stderr.on('data', (data: Buffer) => {
        const text = data.toString();
        stderrChunks.push(text);

        if (opts.onStderr) {
          stderrBuffer += text;
          const lines = stderrBuffer.split('\n');
          stderrBuffer = lines.pop() ?? '';
          for (const line of lines) {
            opts.onStderr(line);
          }
        }
      });

      child.on('error', (err) => {
        if (timeoutHandle) clearTimeout(timeoutHandle);
        reject(err);
      });

      child.on('close', (code) => {
        if (timeoutHandle) clearTimeout(timeoutHandle);

        // Flush remaining buffered lines
        if (opts.onStdout && stdoutBuffer) {
          opts.onStdout(stdoutBuffer);
        }
        if (opts.onStderr && stderrBuffer) {
          opts.onStderr(stderrBuffer);
        }

        const stdout = stdoutChunks.join('');
        const stderr = stderrChunks.join('');
        const duration = Date.now() - startTime;
        const exitCode = timedOut ? 124 : (code ?? 1);

        // Parse diagnostics
        const allOutput = stdout + '\n' + stderr;
        const { errors, warnings } = this.parseDiagnostics(
          allOutput,
          opts.errorPatterns ?? [],
        );

        if (timedOut) {
          errors.push({
            severity: 'error',
            message: `Command timed out after ${opts.timeoutMs}ms`,
          });
        }

        resolvePromise({ stdout, stderr, exitCode, duration, errors, warnings });
      });
    });
  }

  /**
   * Run a registered tool by name with the given arguments.
   * Substitutes placeholders in the tool's command template.
   */
  async runTool(
    toolName: string,
    args: Record<string, string>,
    workDir?: string,
  ): Promise<CommandResult> {
    if (!this.registry) {
      throw new Error('ToolRegistry not provided to CommandRunner');
    }

    const tool = this.registry.get(toolName);
    if (!tool) {
      throw new Error(`Unknown tool: ${toolName}`);
    }

    if (!tool.available) {
      throw new Error(
        `Tool "${tool.displayName}" (${tool.executable}) is not available on this system`,
      );
    }

    // Determine which command to run
    const commandKey = args['_command'] ?? Object.keys(tool.commands)[0];
    const template = tool.commands[commandKey];
    if (!template) {
      throw new Error(
        `Tool "${toolName}" has no command "${commandKey}". Available: ${Object.keys(tool.commands).join(', ')}`,
      );
    }

    // Substitute ${placeholder} values
    const cmd = template.replace(/\$\{(\w+)\}/g, (_match, key: string) => {
      if (key === '_command') return '';
      return args[key] ?? '';
    });

    return this.run(cmd, {
      cwd: workDir,
      errorPatterns: tool.errorPatterns,
      timeoutMs: args['_timeout'] ? parseInt(args['_timeout'], 10) : undefined,
    });
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  private parseDiagnostics(
    output: string,
    patterns: ErrorPattern[],
  ): { errors: ParsedDiagnostic[]; warnings: ParsedDiagnostic[] } {
    const errors: ParsedDiagnostic[] = [];
    const warnings: ParsedDiagnostic[] = [];

    if (patterns.length === 0) return { errors, warnings };

    const compiledPatterns = patterns.map(p => ({
      re: new RegExp(p.pattern, 'gm'),
      ...p,
    }));

    for (const cp of compiledPatterns) {
      let m: RegExpExecArray | null;
      while ((m = cp.re.exec(output)) !== null) {
        const diag: ParsedDiagnostic = {
          severity: cp.severity,
          message: cp.messageGroup === 0
            ? m[0]
            : (m[cp.messageGroup] ?? m[0]),
          file: cp.fileGroup !== undefined ? m[cp.fileGroup] : undefined,
          line: cp.lineGroup !== undefined ? parseInt(m[cp.lineGroup], 10) : undefined,
        };

        if (cp.severity === 'error') {
          errors.push(diag);
        } else {
          warnings.push(diag);
        }
      }
    }

    return { errors, warnings };
  }
}
