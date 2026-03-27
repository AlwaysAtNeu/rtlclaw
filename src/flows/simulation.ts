/**
 * Simulation flow: compile → simulate → check results.
 */

import { join } from 'node:path';
import type { CommandResult, ParsedDiagnostic } from '../tools/runner.js';
import { CommandRunner } from '../tools/runner.js';

/** Convert ParsedDiagnostic[] to string[] for SimulationResult.errors */
function diagToStrings(diags: ParsedDiagnostic[]): string[] {
  return diags.map(d => {
    const loc = d.file ? `${d.file}${d.line ? `:${d.line}` : ''}: ` : '';
    return `${loc}${d.message}`;
  });
}

export interface SimulationResult {
  passed: boolean;
  compileResult: CommandResult;
  simResult?: CommandResult;
  vcdPath?: string;
  errors: string[];
  output: string;
}

export class SimulationFlow {
  private runner = new CommandRunner();

  /**
   * Run full simulation: compile + simulate.
   */
  async run(opts: {
    sources: string[];
    workDir: string;
    simulator?: string;
    defines?: string[];
    includeDir?: string[];
    hdlStandard?: string;
  }): Promise<SimulationResult> {
    const simulator = opts.simulator ?? 'iverilog';

    switch (simulator) {
      case 'iverilog':
        return this.runIverilog(opts);
      case 'vcs':
        return this.runVCS(opts);
      default:
        throw new Error(`Unsupported simulator: ${simulator}`);
    }
  }

  private async runIverilog(opts: {
    sources: string[];
    workDir: string;
    defines?: string[];
    includeDir?: string[];
    hdlStandard?: string;
  }): Promise<SimulationResult> {
    const vvpPath = join(opts.workDir, 'sim.vvp');

    // Map hdlStandard to iverilog generation flag
    const genFlag = (() => {
      switch (opts.hdlStandard) {
        case 'verilog2001': return '-g2001';
        case 'verilog2005': return '-g2005';
        default:            return '-g2012';
      }
    })();

    // Step 1: Compile
    const compileArgs = [genFlag, '-o', vvpPath];
    for (const d of opts.defines ?? []) compileArgs.push(`-D${d}`);
    for (const i of opts.includeDir ?? []) compileArgs.push('-I', i);
    compileArgs.push(...opts.sources);

    const compileResult = await this.runner.run(`iverilog ${compileArgs.join(' ')}`, {
      cwd: opts.workDir,
      timeoutMs: 60000,
    });

    if (compileResult.exitCode !== 0) {
      return {
        passed: false,
        compileResult,
        errors: diagToStrings(compileResult.errors),
        output: compileResult.stderr,
      };
    }

    // Step 2: Simulate
    const simResult = await this.runner.run(`vvp ${vvpPath}`, {
      cwd: opts.workDir,
      timeoutMs: 120000,
    });

    // Check for VCD file
    const { existsSync } = await import('node:fs');
    const vcdPath = join(opts.workDir, 'wave.vcd');
    const hasVcd = existsSync(vcdPath);

    // Determine pass/fail
    const output = simResult.stdout + '\n' + simResult.stderr;
    const passed = checkPassFail(output, simResult.exitCode);

    return {
      passed,
      compileResult,
      simResult,
      vcdPath: hasVcd ? vcdPath : undefined,
      errors: diagToStrings([...compileResult.errors, ...simResult.errors]),
      output,
    };
  }

  private async runVCS(opts: {
    sources: string[];
    workDir: string;
    defines?: string[];
  }): Promise<SimulationResult> {
    // Compile
    const args = ['-full64', '-sverilog', '+v2k', '-debug_access+all', '+vcs+vcdpluson'];
    args.push('-o', join(opts.workDir, 'simv'));
    args.push(...opts.sources);

    const compileResult = await this.runner.run(`vcs ${args.join(' ')}`, {
      cwd: opts.workDir,
      timeoutMs: 120000,
    });

    if (compileResult.exitCode !== 0) {
      return {
        passed: false,
        compileResult,
        errors: diagToStrings(compileResult.errors),
        output: compileResult.stderr,
      };
    }

    // Simulate
    const simResult = await this.runner.run(join(opts.workDir, 'simv'), {
      cwd: opts.workDir,
      timeoutMs: 300000,
    });

    const output = simResult.stdout + '\n' + simResult.stderr;
    const passed = checkPassFail(output, simResult.exitCode ?? 0);

    return { passed, compileResult, simResult, errors: diagToStrings(simResult.errors), output };
  }
}

/** Configurable pass/fail detection */
function checkPassFail(output: string, exitCode: number): boolean {
  const passPatterns = [/\bTEST PASSED\b/i, /\bPASS\b/i, /\bSUCCESS\b/i, /\bALL TESTS PASSED\b/i];
  const failPatterns = [/\bTEST FAILED\b/i, /\bFAIL\b/i];

  const hasPass = passPatterns.some(p => p.test(output));
  const hasFail = failPatterns.some(p => p.test(output));

  return hasPass && !hasFail && exitCode === 0;
}
