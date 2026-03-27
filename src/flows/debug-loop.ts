/**
 * Auto-debug loop: simulate -> parse errors -> extract VCD -> LLM analyze -> patch -> re-sim.
 *
 * Iteration strategy:
 *  - Same error: max 8 retries
 *  - Different error: reset counter for that error
 *  - Total cap: 32 iterations
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { LLMBackend } from '../llm/base.js';
import type { Message } from '../llm/types.js';
import { SimulationFlow, type SimulationResult } from './simulation.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DebugIteration {
  iteration: number;
  errors: string[];
  waveformText: string;
  analysis: string;
  patchFile?: string;
  patchApplied: boolean;
  passed: boolean;
  errorKey: string;
}

export interface DebugResult {
  resolved: boolean;
  iterations: DebugIteration[];
  finalAnalysis: string;
  fixHistory: Array<{ error: string; fixed: boolean; iteration: number }>;
}

export interface DebugLoopOptions {
  sources: string[];
  workDir: string;
  simulator?: string;
  hdlStandard?: string;
  sameErrorMaxRetries?: number;
  totalIterationCap?: number;
  onProgress?: (msg: string) => void;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_SAME_ERROR_MAX = 8;
const DEFAULT_TOTAL_CAP = 32;

const DEBUG_SYSTEM_PROMPT = `You are an RTL debug expert. Analyze simulation errors and waveform data to find the root cause and provide a code fix.

Rules:
- All code and comments must be in English
- Be precise about the root cause
- Provide the minimal fix needed

Fix format:
\`\`\`patch
FILE: <relative_path>
ORIGINAL:
<original lines>
REPLACEMENT:
<fixed lines>
\`\`\``;

// ---------------------------------------------------------------------------
// DebugLoop
// ---------------------------------------------------------------------------

export class DebugLoop {
  private simFlow = new SimulationFlow();

  constructor(private llm: LLMBackend) {}

  async run(opts: DebugLoopOptions): Promise<DebugResult> {
    const sameMax = opts.sameErrorMaxRetries ?? DEFAULT_SAME_ERROR_MAX;
    const totalCap = opts.totalIterationCap ?? DEFAULT_TOTAL_CAP;
    const iterations: DebugIteration[] = [];
    const fixHistory: Array<{ error: string; fixed: boolean; iteration: number }> = [];
    const errorCounts = new Map<string, number>();

    for (let i = 0; i < totalCap; i++) {
      opts.onProgress?.(`Debug iteration ${i + 1}/${totalCap}...`);

      // Step 1: Run simulation
      const simResult = await this.simFlow.run({
        sources: opts.sources,
        workDir: opts.workDir,
        simulator: opts.simulator,
        hdlStandard: opts.hdlStandard,
      });

      if (simResult.passed) {
        return {
          resolved: true,
          iterations,
          finalAnalysis: `Bug fixed in ${i + 1} iteration(s).`,
          fixHistory,
        };
      }

      // Normalize error for comparison
      const errorKey = this.normalizeError(simResult.errors.join('\n'));
      const sameCount = (errorCounts.get(errorKey) ?? 0) + 1;
      errorCounts.set(errorKey, sameCount);

      if (sameCount > sameMax) {
        // Same error exceeded limit
        iterations.push({
          iteration: i + 1,
          errors: simResult.errors,
          waveformText: '',
          analysis: `Same error repeated ${sameCount} times, stopping.`,
          patchApplied: false,
          passed: false,
          errorKey,
        });
        break;
      }

      // Step 2: Build debug context
      const waveformText = simResult.vcdPath
        ? await this.extractWaveform(simResult.vcdPath, simResult.errors)
        : '';
      const sourceCode = this.readSources(opts.sources);

      const prompt = this.buildDebugPrompt(
        simResult.errors,
        simResult.output,
        waveformText,
        sourceCode,
        fixHistory,
      );

      // Step 3: LLM analysis
      const messages: Message[] = [
        { role: 'system', content: DEBUG_SYSTEM_PROMPT },
        { role: 'user', content: prompt },
      ];

      opts.onProgress?.('Analyzing errors with LLM...');
      const response = await this.llm.complete(messages, { temperature: 0.1 });

      // Step 4: Extract and apply patch
      const patch = this.extractPatch(response.content);
      let patchApplied = false;

      if (patch) {
        const patchKey = `${patch.file}:${this.normalizeError(patch.original)}`;
        // Check for duplicate fix
        if (fixHistory.some(h => h.error === patchKey && h.fixed)) {
          iterations.push({
            iteration: i + 1,
            errors: simResult.errors,
            waveformText,
            analysis: response.content + '\n[Duplicate fix detected, stopping]',
            patchApplied: false,
            passed: false,
            errorKey,
          });
          break;
        }

        patchApplied = this.applyPatch(patch, opts.workDir);
        fixHistory.push({ error: patchKey, fixed: patchApplied, iteration: i + 1 });
        opts.onProgress?.(patchApplied ? `Applied fix to ${patch.file}` : 'Failed to apply patch');
      }

      iterations.push({
        iteration: i + 1,
        errors: simResult.errors,
        waveformText,
        analysis: response.content,
        patchFile: patch?.file,
        patchApplied,
        passed: false,
        errorKey,
      });

      if (!patchApplied) break;
    }

    return {
      resolved: false,
      iterations,
      finalAnalysis: iterations.at(-1)?.analysis ?? 'No analysis available',
      fixHistory,
    };
  }

  // -----------------------------------------------------------------------
  // Helpers
  // -----------------------------------------------------------------------

  private normalizeError(error: string): string {
    return error
      .replace(/\d+:\d+/g, 'N:N')
      .replace(/time\s+\d+/gi, 'time N')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 200);
  }

  private async extractWaveform(vcdPath: string, errors: string[]): Promise<string> {
    try {
      const { VCDParser } = await import('../parser/vcd-parser.js');
      const parser = new VCDParser();
      const data = await parser.parse(vcdPath);

      const errorTimestamps = errors
        .map(e => {
          const match = /time\s+(\d+)/i.exec(e);
          return match ? parseInt(match[1]!) : null;
        })
        .filter((t): t is number => t !== null);

      const signalNames = data.signals.slice(0, 15).map((s: { name: string }) => s.name);

      if (errorTimestamps.length === 0) {
        const window = parser.extractWindow(data, signalNames, 0, data.endTime);
        return parser.formatAsTable(window, errors);
      }

      const center = errorTimestamps[0]!;
      const margin = 100;
      const window = parser.extractWindow(
        data, signalNames, Math.max(0, center - margin), center + margin,
      );
      return parser.formatAsTable(window, errors);
    } catch {
      return '(VCD parsing unavailable)';
    }
  }

  private readSources(sources: string[]): string {
    const parts: string[] = [];
    for (const src of sources) {
      try {
        const content = readFileSync(src, 'utf-8');
        parts.push(`// === ${src} ===\n${content}`);
      } catch { /* skip */ }
    }
    return parts.join('\n\n').slice(0, 8000);
  }

  private buildDebugPrompt(
    errors: string[],
    output: string,
    waveform: string,
    source: string,
    fixHistory: Array<{ error: string; fixed: boolean; iteration: number }>,
  ): string {
    let prompt = '## Simulation Errors\n';
    for (const e of errors.slice(0, 20)) prompt += `- ${e}\n`;

    prompt += `\n## Simulation Output\n\`\`\`\n${output.slice(-2000)}\n\`\`\`\n`;
    if (waveform) prompt += `\n## Waveform Data\n\`\`\`\n${waveform}\n\`\`\`\n`;
    prompt += `\n## Source Code\n\`\`\`verilog\n${source}\n\`\`\`\n`;

    if (fixHistory.length > 0) {
      prompt += '\n## Previous Fix Attempts (do not repeat)\n';
      for (const h of fixHistory.slice(-5)) {
        prompt += `- Iteration ${h.iteration}: ${h.fixed ? 'Applied' : 'Failed'} - ${h.error.slice(0, 100)}\n`;
      }
    }

    prompt += '\nAnalyze the root cause and provide a fix patch.';
    return prompt;
  }

  private extractPatch(response: string): { file: string; original: string; replacement: string } | null {
    const match = /```patch\s*\n([\s\S]*?)```/.exec(response);
    if (!match) return null;

    const block = match[1]!;
    const fileMatch = /FILE:\s*(.+)/.exec(block);
    const origMatch = /ORIGINAL:\s*\n([\s\S]*?)(?=REPLACEMENT:)/.exec(block);
    const replMatch = /REPLACEMENT:\s*\n([\s\S]*?)$/.exec(block);

    if (!fileMatch || !origMatch || !replMatch) return null;

    return {
      file: fileMatch[1]!.trim(),
      original: origMatch[1]!.trim(),
      replacement: replMatch[1]!.trim(),
    };
  }

  /** Apply patch using line-level matching */
  private applyPatch(
    patch: { file: string; original: string; replacement: string },
    workDir: string,
  ): boolean {
    const filePath = join(resolve(workDir), patch.file);

    try {
      const content = readFileSync(filePath, 'utf-8');

      // Try exact match first
      if (content.includes(patch.original)) {
        writeFileSync(filePath, content.replace(patch.original, patch.replacement));
        return true;
      }

      // Line-level matching (trim whitespace per line)
      const contentLines = content.split('\n');
      const origLines = patch.original.split('\n').map(l => l.trim());

      for (let i = 0; i <= contentLines.length - origLines.length; i++) {
        let match = true;
        for (let j = 0; j < origLines.length; j++) {
          if (contentLines[i + j]!.trim() !== origLines[j]) {
            match = false;
            break;
          }
        }
        if (match) {
          const before = contentLines.slice(0, i);
          const replLines = patch.replacement.split('\n');
          const after = contentLines.slice(i + origLines.length);
          writeFileSync(filePath, [...before, ...replLines, ...after].join('\n'));
          return true;
        }
      }
    } catch { /* file not found */ }

    return false;
  }
}
