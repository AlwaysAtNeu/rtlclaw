/**
 * Terminal chat UI - messages print to stdout (naturally scrollable),
 * input via readline.
 *
 * Two modes:
 *  - Claw Mode (default): general AI assistant
 *  - Project Mode: full RTL design workflow (activated via /project)
 */

import * as readline from 'node:readline';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import chalk from 'chalk';
import type { ConfigManager } from '../config/manager.js';
import type { LLMBackend } from '../llm/base.js';
import {
  Orchestrator,
  type OrchestratorContext,
  type ChatMessage,
  type OutputChunk,
  type LLMTraceEntry,
} from '../agents/orchestrator.js';
import type { Action, DesignIndex, WorkflowState } from '../agents/types.js';

// --------------------------------------------------------------------------
// Async exec with abort support (replaces execSync to unblock event loop)
// --------------------------------------------------------------------------

interface ExecAsyncOptions {
  cwd?: string;
  encoding?: BufferEncoding;
  timeout?: number;
  shell?: string;
  signal?: AbortSignal;
}

function execAsync(cmd: string, opts: ExecAsyncOptions = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('sh', ['-c', cmd], {
      cwd: opts.cwd ?? process.cwd(),
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: opts.shell,
    });

    const stdoutChunks: string[] = [];
    const stderrChunks: string[] = [];
    child.stdout.on('data', (d: Buffer) => stdoutChunks.push(d.toString()));
    child.stderr.on('data', (d: Buffer) => stderrChunks.push(d.toString()));

    // Timeout
    let timedOut = false;
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    if (opts.timeout && opts.timeout > 0) {
      timeoutHandle = setTimeout(() => {
        timedOut = true;
        child.kill('SIGTERM');
        setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* */ } }, 3000);
      }, opts.timeout);
    }

    // Abort signal (Ctrl+C)
    if (opts.signal) {
      if (opts.signal.aborted) {
        child.kill('SIGTERM');
        reject(new DOMException('The operation was aborted.', 'AbortError'));
        return;
      }
      const onAbort = () => {
        child.kill('SIGTERM');
        setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* */ } }, 2000);
      };
      opts.signal.addEventListener('abort', onAbort, { once: true });
      child.on('close', () => opts.signal!.removeEventListener('abort', onAbort));
    }

    child.on('error', (err) => {
      if (timeoutHandle) clearTimeout(timeoutHandle);
      reject(err);
    });

    child.on('close', (code) => {
      if (timeoutHandle) clearTimeout(timeoutHandle);
      const stdout = stdoutChunks.join('');
      const stderr = stderrChunks.join('');

      // Check if aborted
      if (opts.signal?.aborted) {
        reject(new DOMException('The operation was aborted.', 'AbortError'));
        return;
      }

      if (timedOut) {
        const err: any = new Error(`Command timed out after ${opts.timeout}ms`);
        err.stdout = stdout;
        err.stderr = stderr;
        reject(err);
        return;
      }

      if (code !== 0) {
        const err: any = new Error(`Command failed with exit code ${code}`);
        err.stdout = stdout;
        err.stderr = stderr;
        err.status = code;
        reject(err);
        return;
      }

      resolve(stdout);
    });
  });
}

// --------------------------------------------------------------------------
// Display helpers
// --------------------------------------------------------------------------

const COLS = () => Math.min(process.stdout.columns || 80, 80);
const DIVIDER = () => chalk.dim('\u2500'.repeat(COLS()));

// Gradient helper: blend through cyan → blue → magenta across characters
const GRADIENT_COLORS = [
  chalk.hex('#00FFFF'), // cyan
  chalk.hex('#00DDFF'),
  chalk.hex('#00BBFF'),
  chalk.hex('#0099FF'),
  chalk.hex('#3377FF'), // blue
  chalk.hex('#6655FF'),
  chalk.hex('#9944FF'),
  chalk.hex('#CC33FF'),
  chalk.hex('#FF22DD'), // magenta
];

function gradientText(text: string): string {
  const chars = [...text];
  return chars.map((ch, i) => {
    const colorIdx = Math.floor((i / Math.max(chars.length - 1, 1)) * (GRADIENT_COLORS.length - 1));
    return GRADIENT_COLORS[colorIdx]!(ch);
  }).join('');
}

function printHeader(): void {
  const logo = [
    '  ____  _____ _           ____  _               ',
    ' |  _ \\|_   _| |         / ___|| | __ ___      __',
    ' | |_) | | | | |  _____ | |   | |/ _` \\ \\ /\\ / /',
    ' |  _ <  | | | |_|_____|| |___| | (_| |\\ V  V / ',
    ' |_| \\_\\ |_| |_____|     \\____|_|\\__,_| \\_/\\_/  ',
  ];
  console.log();
  for (const line of logo) {
    console.log('  ' + gradientText(line));
  }
  console.log();
  console.log(chalk.dim('  ') + chalk.bold.white('v0.1.0') + chalk.dim('  \u2502  AI-Powered RTL Development Assistant'));
  console.log(chalk.dim('  ' + '\u2500'.repeat(50)));
  console.log();
}

function printSystem(text: string): void {
  console.log(chalk.dim('  ' + text));
}

function printUser(_text?: string): void {
  console.log(DIVIDER());
  console.log();
}

function buildPrompt(): string {
  return `  ${chalk.cyan.bold('\u276F')} `;
}

/** Print a context bar above the prompt showing model and project info */
function printContextBar(modelName?: string, projectName?: string): void {
  const tags: string[] = [];
  if (modelName) tags.push(chalk.hex('#00BBFF')(modelName));
  if (projectName) tags.push(chalk.hex('#9944FF')(projectName));
  if (tags.length > 0) {
    console.log(chalk.dim('  \u2500\u2500 ') + tags.join(chalk.dim(' \u2502 ')) + chalk.dim(' ' + '\u2500'.repeat(Math.max(0, COLS() - 10 - (modelName?.length ?? 0) - (projectName?.length ?? 0)))));
  } else {
    console.log(DIVIDER());
  }
}


function printError(text: string): void {
  console.log(chalk.red('  \u2718 Error: ') + text);
  console.log();
}

function printResult(text: string): void {
  // Highlight PASSED/FAILED keywords in simulation output
  const highlighted = text
    .replace(/\bTEST PASSED\b|\bPASSED\b|\bSUCCESS\b|\bALL TESTS PASSED\b/g,
      (m) => chalk.bgGreen.black.bold(` ${m} `))
    .replace(/\bTEST FAILED\b|\bFAILED\b/g,
      (m) => chalk.bgRed.white.bold(` ${m} `))
    .replace(/\bERROR:/g,
      chalk.red.bold('ERROR:'));
  console.log('  ' + highlighted);
}

function printCodeBlock(content: string, lang?: string): void {
  const label = lang ? chalk.dim(` ${lang} `) : '';
  const border = chalk.dim('\u2502');
  console.log(chalk.dim('  \u250C\u2500') + label + chalk.dim('\u2500'.repeat(Math.max(0, 40 - (lang?.length ?? 0)))));
  for (const line of content.split('\n')) {
    console.log(chalk.dim('  ') + border + '  ' + line);
  }
  console.log(chalk.dim('  \u2514' + '\u2500'.repeat(42)));
  console.log();
}

function printDebugRound(round: number, total: number, message: string): void {
  const badge = chalk.bgYellow.black.bold(` Debug ${round}/${total} `);
  console.log(`  ${badge} ${chalk.yellow(message)}`);
}

function printProgressBar(current: number, total: number, label: string, stage?: string): void {
  const barWidth = 20;
  const filled = Math.round((current / total) * barWidth);
  const empty = barWidth - filled;
  const bar = chalk.hex('#00BBFF')('\u2588'.repeat(filled)) + chalk.dim('\u2591'.repeat(empty));
  const pct = chalk.bold(`${current}/${total}`);
  const stageTag = stage ? chalk.hex('#9944FF').bold(` ${stage}`) : '';
  console.log(`  ${bar} ${pct}  ${chalk.white(label)}${stageTag}`);
}

function printHelp(): void {
  const cmd = (name: string, desc: string) =>
    chalk.cyan(`    ${name.padEnd(22)}`) + chalk.dim(`\u2014 ${desc}`);

  console.log([
    '',
    chalk.bold.hex('#00BBFF')('  \u25B8 Project'),
    cmd('/project init <n>', 'Create new project'),
    cmd('/project open <p>', 'Open project (Project Mode)'),
    cmd('/project list', 'List known projects'),
    cmd('/project close', 'Return to Claw Mode'),
    '',
    chalk.bold.hex('#9944FF')('  \u25B8 Model'),
    cmd('/model', 'Show or switch model'),
    cmd('/provider <name>', 'Switch LLM provider'),
    cmd('/config', 'Show current config'),
    '',
    chalk.bold.hex('#FF22DD')('  \u25B8 Workflow'),
    cmd('/continue', 'Resume paused workflow'),
    cmd('/auto', 'Toggle auto mode'),
    cmd('/tools', 'Show EDA tool status'),
    cmd('/log', 'Show recent log entries'),
    '',
    chalk.bold.white('  \u25B8 General'),
    cmd('/help', 'Show this help'),
    cmd('/clear', 'Clear conversation'),
    cmd('/quit', 'Exit'),
    '',
  ].join('\n'));
}

// --------------------------------------------------------------------------
// Spinner
// --------------------------------------------------------------------------

class Spinner {
  private frames = ['\u280B', '\u2819', '\u2839', '\u2838', '\u283C', '\u2834', '\u2826', '\u2827', '\u2807', '\u280F'];
  private idx = 0;
  private timer: ReturnType<typeof setInterval> | null = null;

  start(label: string): void {
    this.stop();
    process.stdout.write(`  ${chalk.yellow(this.frames[0])} ${chalk.yellow(label)}`);
    this.timer = setInterval(() => {
      this.idx = (this.idx + 1) % this.frames.length;
      readline.clearLine(process.stdout, 0);
      readline.cursorTo(process.stdout, 0);
      process.stdout.write(`  ${chalk.yellow(this.frames[this.idx])} ${chalk.yellow(label)}`);
    }, 80);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
      // Only clear the spinner line if the spinner was actually running
      readline.clearLine(process.stdout, 0);
      readline.cursorTo(process.stdout, 0);
    }
  }
}

// --------------------------------------------------------------------------
// HDL standard → iverilog generation flag
// --------------------------------------------------------------------------

function hdlStandardToIverilogGen(standard?: string): string {
  switch (standard) {
    case 'verilog2001': return '-g2001';
    case 'verilog2005': return '-g2005';
    case 'sv2012':      return '-g2012';
    case 'sv2017':      return '-g2012'; // iverilog max is -g2012
    case 'vhdl2008':    return '-g2012'; // VHDL not supported by iverilog, fallback
    default:            return '-g2012';
  }
}

// --------------------------------------------------------------------------
// Action execution
// --------------------------------------------------------------------------

async function executeAction(
  action: Action,
  projectPath: string | undefined,
  hdlStandard?: string,
  logTrace?: (entry: LLMTraceEntry) => Promise<void>,
  signal?: AbortSignal,
): Promise<string> {
  const baseDir = projectPath ?? process.cwd();

  switch (action.type) {
    case 'writeFile': {
      const payload = action.payload as { path: string; content: string; append?: boolean; appendLine?: string; patchOriginal?: string };
      const filePath = path.resolve(baseDir, payload.path);

      // Ensure parent directory exists
      await fs.mkdir(path.dirname(filePath), { recursive: true });

      if (payload.append) {
        // Append a line to a file (e.g. design.f filelist)
        const lineToAppend = payload.appendLine ?? payload.content;
        try {
          const existing = await fs.readFile(filePath, 'utf-8');
          if (!existing.includes(lineToAppend)) {
            await fs.appendFile(filePath, `${lineToAppend}\n`, 'utf-8');
          }
        } catch {
          await fs.writeFile(filePath, `${lineToAppend}\n`, 'utf-8');
        }
        return `  \u2713 Updated ${payload.path}`;
      }

      if (payload.patchOriginal) {
        // Line-level patch application
        try {
          const existing = await fs.readFile(filePath, 'utf-8');
          const patched = applyLinePatch(existing, payload.patchOriginal, payload.content);
          if (patched !== existing) {
            await fs.writeFile(filePath, patched, 'utf-8');
            return `  \u2713 Patched ${payload.path}`;
          }
          return `  \u2717 Patch did not match in ${payload.path}`;
        } catch {
          return `  \u2717 Could not read ${payload.path} for patching`;
        }
      }

      await fs.writeFile(filePath, payload.content, 'utf-8');
      const lineCount = payload.content.split('\n').length;
      return `  \u2713 Wrote ${payload.path} (${lineCount} lines)`;
    }

    case 'runCommand': {
      const payload = action.payload as { command: string };
      const output = await execAsync(payload.command, { cwd: baseDir, timeout: 60_000, signal });
      return output;
    }

    case 'lintCode': {
      const payload = action.payload as { file: string };
      const filePath = path.resolve(baseDir, payload.file);
      const iverilogGen = hdlStandardToIverilogGen(hdlStandard);
      if (!existsSync(filePath)) return `  Lint: file not found ${payload.file}`;

      const envPrefix = buildSetenvPrefix(baseDir);
      const lintStartMs = Date.now();
      let lintCmd = '';
      let lintResult = '';

      // Use filelist for dependencies and include paths if available
      const filelistPath = path.join(baseDir, 'hw/src/filelist/design.f');
      const filelistArg = existsSync(filelistPath) ? ` -f ${filelistPath}` : '';

      try {
        await execAsync('which verilator', { signal });
        lintCmd = `${envPrefix}verilator --lint-only -Wall${filelistArg} ${filePath} 2>&1 || true`;
        lintResult = await execAsync(lintCmd, { cwd: baseDir, timeout: 30_000, signal });
        lintResult = lintResult || '  Lint: passed';
      } catch (e) {
        if (e instanceof DOMException && e.name === 'AbortError') throw e;
        try {
          await execAsync('which iverilog', { signal });
          lintCmd = `${envPrefix}iverilog ${iverilogGen} -tnull${filelistArg} ${filePath} 2>&1 || true`;
          lintResult = await execAsync(lintCmd, { cwd: baseDir, timeout: 30_000, signal });
          lintResult = lintResult || '  Lint: passed';
        } catch (e2) {
          if (e2 instanceof DOMException && e2.name === 'AbortError') throw e2;
          throw new Error('No lint tool available (verilator or iverilog)');
        }
      }
      if (logTrace) {
        await logTrace({
          timestamp: new Date().toISOString(),
          role: 'EDA',
          promptTokens: 0, completionTokens: 0,
          durationMs: Date.now() - lintStartMs,
          event: 'action:lint',
          taskContext: `lint:${payload.file}`,
          summary: lintResult.includes('Lint: passed') ? 'CLEAN' : `ERRORS (${lintResult.length}ch)`,
          responseContent: `$ ${lintCmd}\n\n${lintResult}`,
        });
      }
      return lintResult;
    }

    case 'runSimulation': {
      const payload = action.payload as { module?: string; testType: 'ut' | 'st'; tc?: string };
      const iverilogGen = hdlStandardToIverilogGen(hdlStandard);

      // Find testbench and sources
      const tbDir = payload.testType === 'ut' ? 'hw/dv/ut/sim/tb' : 'hw/dv/st/sim/tb';
      const tcDir = payload.testType === 'ut' ? 'hw/dv/ut/sim/tc' : 'hw/dv/st/sim/tc';
      const filelistPath = path.join(baseDir, 'hw/src/filelist/design.f');
      const tbPath = path.join(baseDir, tbDir);
      const tcPath = path.join(baseDir, tcDir);

      if (!existsSync(tbPath)) return 'No testbench directory found';

      // Find the TB file for this module
      const tbFiles = (await fs.readdir(tbPath)).filter(f => f.endsWith('.v') || f.endsWith('.sv'));
      if (tbFiles.length === 0) return 'No testbench files found';

      const tbFile = payload.module
        ? tbFiles.find(f => f.includes(payload.module!)) ?? tbFiles[0]!
        : tbFiles[0]!;
      const tbFilePath = path.join(tbPath, tbFile);

      // Collect TC files for this module
      let tcFiles: string[] = [];
      if (existsSync(tcPath)) {
        const allTcFiles = (await fs.readdir(tcPath)).filter(f => f.endsWith('.v') || f.endsWith('.sv'));
        tcFiles = payload.module
          ? allTcFiles.filter(f => f.includes(payload.module!))
          : allTcFiles;
        // If no module-specific TCs found, use all TCs
        if (tcFiles.length === 0) tcFiles = allTcFiles;
      }

      const simDir = path.join(baseDir, 'hw/dv', payload.testType, 'sim');
      await fs.mkdir(simDir, { recursive: true });
      const envPrefix = buildSetenvPrefix(baseDir);

      // RTL sources from filelist
      let rtlSources = '';
      if (existsSync(filelistPath)) {
        rtlSources = ` -f ${filelistPath}`;
      }

      // Read TB content to check if it uses `include "PLACEHOLDER_TC"
      let tbContent: string;
      try {
        tbContent = await fs.readFile(tbFilePath, 'utf-8');
      } catch {
        return `Cannot read testbench file: ${tbFilePath}`;
      }

      const usesTcInclude = tbContent.includes('PLACEHOLDER_TC');

      try {
        await execAsync('which iverilog', { signal });
      } catch (e) {
        if (e instanceof DOMException && e.name === 'AbortError') throw e;
        throw new Error('Simulation tool (iverilog) not available');
      }

      if (usesTcInclude && tcFiles.length > 0) {
        // ── TB/TC separated via `include ──
        // If a specific TC is requested, only run that one
        const tcsToRun = payload.tc
          ? tcFiles.filter(f => f === payload.tc || f.includes(payload.tc!))
          : tcFiles;

        const allResults: string[] = [];
        let allPassed = true;

        for (const tcFile of tcsToRun) {
          const tcFilePath = path.join(tcPath, tcFile);
          const tempTBPath = path.join(simDir, `tb_temp_${tcFile}`);
          // Calculate TC path relative to where the temp TB file will be (simDir)
          const tcRelPath = path.relative(simDir, tcFilePath);
          const tempTBContent = tbContent.replace(/`include\s+"PLACEHOLDER_TC"/g, `\`include "${tcRelPath}"`);
          await fs.writeFile(tempTBPath, tempTBContent, 'utf-8');

          const vvpPath = path.join(simDir, `sim_${tcFile.replace(/\.\w+$/, '')}.vvp`);
          const compileCmd = `${envPrefix}iverilog ${iverilogGen} -I ${tcPath} -o ${vvpPath} ${tempTBPath}${rtlSources} 2>&1`;
          const runCmd = `${envPrefix}vvp ${vvpPath} 2>&1`;
          const tcStartMs = Date.now();
          let tcOutput = '';
          let tcPassed = false;

          try {
            await execAsync(compileCmd, { cwd: baseDir, timeout: 60_000, signal });
            const simOutput = await execAsync(runCmd, { cwd: simDir, timeout: 120_000, signal });
            tcPassed = simOutput.includes('TEST PASSED') || simOutput.includes('PASSED');
            tcOutput = simOutput;
            if (!tcPassed) allPassed = false;
            allResults.push(`=== ${tcFile} ===\n${simOutput}`);
          } catch (err) {
            if (err instanceof DOMException && err.name === 'AbortError') throw err;
            allPassed = false;
            if (err instanceof Error && 'stdout' in err) {
              const execErr = err as { stdout?: string; stderr?: string };
              tcOutput = (execErr.stdout || execErr.stderr || err.message);
            } else {
              tcOutput = err instanceof Error ? err.message : String(err);
            }
            allResults.push(`=== ${tcFile} ===\n${tcOutput}`);
          }

          if (logTrace) {
            await logTrace({
              timestamp: new Date().toISOString(),
              role: 'EDA',
              promptTokens: 0, completionTokens: 0,
              durationMs: Date.now() - tcStartMs,
              event: 'action:sim',
              taskContext: `sim:${payload.module ?? 'unknown'}:${tcFile}`,
              summary: tcPassed ? 'PASSED' : `FAILED`,
              responseContent: `$ ${compileCmd}\n$ ${runCmd}\n\n${tcOutput}`,
            });
          }

          // Stop at first failure — report which TC failed so debug loop can target it
          if (!tcPassed) {
            allResults.push(`FAILING_TC: ${tcFile}`);
            break;
          }
        }

        const combined = allResults.join('\n');
        return allPassed ? combined + '\nTEST PASSED' : combined;
      } else {
        // ── Self-contained TB (no TC include) or no TCs ──
        const vvpPath = path.join(simDir, 'sim.vvp');
        const compileCmd = `${envPrefix}iverilog ${iverilogGen} -o ${vvpPath} ${tbFilePath}${rtlSources} 2>&1`;
        const runCmd = `${envPrefix}vvp ${vvpPath} 2>&1`;
        const simStartMs = Date.now();
        let simOutput = '';
        let simPassed = false;
        try {
          await execAsync(compileCmd, { cwd: baseDir, timeout: 60_000, signal });
          simOutput = await execAsync(runCmd, { cwd: simDir, timeout: 120_000, signal });
          simPassed = simOutput.includes('TEST PASSED') || simOutput.includes('PASSED');
        } catch (err) {
          if (err instanceof DOMException && err.name === 'AbortError') throw err;
          if (err instanceof Error && 'stdout' in err) {
            const execErr = err as { stdout?: string; stderr?: string };
            simOutput = (execErr.stdout || execErr.stderr || err.message);
          } else {
            simOutput = err instanceof Error ? err.message : String(err);
          }
        }
        if (logTrace) {
          await logTrace({
            timestamp: new Date().toISOString(),
            role: 'EDA',
            promptTokens: 0, completionTokens: 0,
            durationMs: Date.now() - simStartMs,
            event: 'action:sim',
            taskContext: `sim:${payload.module ?? 'unknown'}:standalone`,
            summary: simPassed ? 'PASSED' : 'FAILED',
            responseContent: `$ ${compileCmd}\n$ ${runCmd}\n\n${simOutput}`,
          });
        }
        return simOutput;
      }
    }

    case 'updateIndex': {
      // Trigger HDL parser to rebuild structural index
      if (projectPath) {
        try {
          const { HDLParser } = await import('../parser/hdl-parser.js');
          const parser = new HDLParser();
          const hdlDir = path.join(projectPath, 'hw/src/hdl');
          if (existsSync(hdlDir)) {
            const modules = await parser.parseProject(hdlDir);
            // Save to index (basic structural update)
            const { ProjectManager } = await import('../project/manager.js');
            const pm = new ProjectManager();
            const currentIndex = await pm.loadDesignIndex(projectPath);
            // Merge parsed modules with existing index
            for (const mod of modules) {
              const existing = currentIndex.modules.findIndex(m => m.name === mod.name);
              const entry = {
                name: mod.name,
                file: mod.file,
                language: mod.language,
                ports: mod.ports.map(p => ({
                  name: p.name,
                  direction: p.direction,
                  width: p.width,
                  widthExpr: p.widthExpr,
                })),
                params: mod.params.map(p => ({
                  name: p.name,
                  defaultValue: p.defaultValue,
                })),
                instances: mod.instances.map(inst => ({
                  moduleName: inst.moduleName,
                  instanceName: inst.instanceName,
                  file: inst.file,
                  line: inst.line,
                })),
              };
              if (existing >= 0) {
                currentIndex.modules[existing] = entry;
              } else {
                currentIndex.modules.push(entry);
              }
            }
            currentIndex.timestamp = new Date().toISOString();
            await pm.saveDesignIndex(projectPath, currentIndex);
          }
        } catch {
          // Index update is best-effort
        }
      }
      return '  Index updated';
    }

    case 'synthesize': {
      const envPrefix = buildSetenvPrefix(baseDir);
      const synPayload = action.payload as { topModule?: string };
      try {
        await execAsync('which yosys', { signal });
        const synDir = path.join(baseDir, 'hw/syn');
        await fs.mkdir(synDir, { recursive: true });

        // Use existing synth.ys if available, otherwise generate a basic one
        const ysPath = path.join(synDir, 'synth.ys');
        if (!existsSync(ysPath)) {
          const filelistPath = path.join(baseDir, 'hw/src/filelist/design.f');
          const topMod = synPayload.topModule ?? 'top';
          const ysScript = `# Auto-generated synthesis script\nread_verilog -f ${filelistPath}\nsynth -top ${topMod}\nstat\nwrite_verilog ${path.join(synDir, 'netlist.v')}\n`;
          await fs.writeFile(ysPath, ysScript, 'utf-8');
        }

        const result = await execAsync(`${envPrefix}yosys -s ${ysPath} 2>&1 || true`, {
          cwd: synDir, timeout: 300_000, signal,
        });
        return result;
      } catch (e) {
        if (e instanceof DOMException && e.name === 'AbortError') throw e;
        throw new Error('Synthesis tool (yosys) not available');
      }
    }

    default:
      return `Unknown action type: ${action.type}`;
  }
}

/** Apply patch using line-level matching */
function applyLinePatch(content: string, original: string, replacement: string): string {
  // First try exact match
  if (content.includes(original)) {
    return content.replace(original, replacement);
  }

  // Line-level matching (trim whitespace)
  const contentLines = content.split('\n');
  const origLines = original.split('\n').map(l => l.trim());
  const replLines = replacement.split('\n');

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
      const after = contentLines.slice(i + origLines.length);
      return [...before, ...replLines, ...after].join('\n');
    }
  }

  return content; // No match found
}

// --------------------------------------------------------------------------
// setenv sourcing helper
// --------------------------------------------------------------------------

function buildSetenvPrefix(baseDir: string): string {
  const setenvPath = path.join(baseDir, 'hw', 'setenv');
  if (existsSync(setenvPath)) {
    return `source ${setenvPath} 2>/dev/null; `;
  }
  return '';
}

// --------------------------------------------------------------------------
// LLM trace logging
// --------------------------------------------------------------------------

async function writeLLMTrace(projectPath: string, entry: LLMTraceEntry): Promise<void> {
  const traceDir = path.join(projectPath, '.rtl-claw/logs/llm-trace');
  await fs.mkdir(traceDir, { recursive: true });
  const date = new Date().toISOString().split('T')[0];

  // Machine-readable JSONL
  const tracePath = path.join(traceDir, `trace-${date}.jsonl`);
  await fs.appendFile(tracePath, JSON.stringify(entry) + '\n', 'utf-8');

  // Human-readable log (quick scan)
  const logPath = path.join(traceDir, `trace-${date}.log`);
  const time = entry.timestamp.split('T')[1]?.replace('Z', '') ?? '';
  const dur = entry.durationMs > 0 ? `${(entry.durationMs / 1000).toFixed(1)}s` : '-';
  const tokens = entry.promptTokens > 0 ? `${entry.promptTokens}→${entry.completionTokens}tok` : '';
  const retry = entry.retryCount ? ` retry=${entry.retryCount}` : '';
  const code = entry.hasCodeBlock !== undefined ? (entry.hasCodeBlock ? ' [code]' : ' [no-code]') : '';
  const chars = entry.responseChars !== undefined ? ` ${entry.responseChars}ch` : '';
  const tag = entry.event ?? entry.role;
  const summary = entry.summary ?? entry.taskContext ?? '';
  // Add separator line for workflow phase transitions to make log scannable
  let prefix = '';
  if (entry.event === 'workflow' && entry.summary?.startsWith('start')) {
    prefix = `\n${'─'.repeat(60)}\n`;
  }
  const line = `${prefix}[${time}] ${tag.padEnd(20)} ${dur.padStart(7)} ${tokens.padStart(14)}${retry}${code}${chars}  ${summary}\n`;
  await fs.appendFile(logPath, line, 'utf-8');

  // Full prompt/response content log (for deep debugging)
  if (entry.promptContent || entry.responseContent) {
    const detailDir = path.join(traceDir, 'detail');
    await fs.mkdir(detailDir, { recursive: true });
    // Use sequential numbering + readable context for filename
    // Count existing files to get sequence number
    let seq: string;
    try {
      const existing = await fs.readdir(detailDir);
      seq = String(existing.length + 1).padStart(3, '0');
    } catch { seq = '001'; }
    const ctx = (entry.taskContext ?? 'unknown').replace(/[^a-zA-Z0-9_:-]/g, '_');
    const role = entry.role.toLowerCase();
    const detailPath = path.join(detailDir, `${seq}_${role}_${ctx}.md`);

    let detail = `# ${seq} — ${entry.role}: ${entry.taskContext ?? 'LLM Call'}\n\n`;
    detail += `| Field | Value |\n|-------|-------|\n`;
    detail += `| Time | ${entry.timestamp} |\n`;
    detail += `| Role | ${entry.role} |\n`;
    detail += `| Duration | ${dur} |\n`;
    detail += `| Tokens | ${entry.promptTokens} prompt → ${entry.completionTokens} completion |\n`;
    detail += `| Prompt chars | ${entry.promptChars ?? '?'} |\n`;
    detail += `| Response chars | ${entry.responseChars ?? '?'} |\n`;
    detail += `| Has code block | ${entry.hasCodeBlock ?? '?'} |\n`;
    detail += `| Retry count | ${entry.retryCount ?? 0} |\n`;
    if (entry.summary) detail += `| Summary | ${entry.summary} |\n`;
    detail += '\n';
    if (entry.promptContent) {
      detail += '---\n\n## Prompt Messages\n\n';
      for (let i = 0; i < entry.promptContent.length; i++) {
        const msg = entry.promptContent[i];
        const charCount = msg.content.length;
        detail += `### Message ${i + 1}: [${msg.role.toUpperCase()}] (${charCount} chars)\n\n`;
        // Truncate very long messages for readability, keep full version below
        if (charCount > 3000) {
          detail += '```\n' + msg.content.slice(0, 1500) + '\n\n... (' + (charCount - 3000) + ' chars truncated) ...\n\n' + msg.content.slice(-1500) + '\n```\n\n';
        } else {
          detail += '```\n' + msg.content + '\n```\n\n';
        }
      }
    }
    if (entry.responseContent) {
      detail += '---\n\n## LLM Response\n\n';
      detail += '```\n' + entry.responseContent + '\n```\n';
    }
    await fs.appendFile(detailPath, detail, 'utf-8');
  }
}

// --------------------------------------------------------------------------
// EDA tool availability check
// --------------------------------------------------------------------------

async function checkEdaTools(): Promise<{ available: string[]; missing: string[] }> {
  const tools = ['iverilog', 'verilator', 'yosys', 'vcs', 'vivado'];
  const available: string[] = [];
  const missing: string[] = [];

  for (const tool of tools) {
    try {
      await execAsync(`which ${tool}`);
      available.push(tool);
    } catch {
      missing.push(tool);
    }
  }

  return { available, missing };
}

// --------------------------------------------------------------------------
// Command definitions (used for both completion and help)
// --------------------------------------------------------------------------

interface CommandDef {
  name: string;
  args?: string;
  description: string;
  subcommands?: CommandDef[];
}

const COMMANDS: CommandDef[] = [
  {
    name: '/project', args: '<action>', description: 'Manage projects',
    subcommands: [
      { name: '/project init', args: '<name>', description: 'Create new project' },
      { name: '/project open', args: '<path>', description: 'Open project' },
      { name: '/project list', description: 'List projects' },
      { name: '/project close', description: 'Close project' },
    ],
  },
  { name: '/model', args: '[name]', description: 'Show or switch model' },
  { name: '/provider', args: '<name>', description: 'Switch LLM provider' },
  { name: '/config', description: 'Show current config' },
  { name: '/continue', description: 'Resume paused workflow' },
  { name: '/auto', description: 'Toggle auto mode' },
  { name: '/tools', description: 'Show EDA tool status' },
  { name: '/log', description: 'Show recent log entries' },
  { name: '/help', description: 'Show help' },
  { name: '/clear', description: 'Clear conversation' },
  { name: '/quit', description: 'Exit' },
];

interface FlatCommand {
  name: string;
  args?: string;
  description: string;
}

/** Flatten COMMANDS into a single list including subcommands. */
function getAllCommands(): FlatCommand[] {
  const result: FlatCommand[] = [];
  for (const cmd of COMMANDS) {
    if (cmd.subcommands) {
      for (const sub of cmd.subcommands) {
        result.push(sub);
      }
    } else {
      result.push(cmd);
    }
  }
  return result;
}

/** Strip ANSI escape codes to get visible character count. */
function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*m/g, '');
}

/**
 * Dropdown command suggestions rendered below the prompt line.
 *
 * NEVER uses \x1b[s / \x1b[u (save/restore cursor) — readline's internal
 * rendering overwrites the single save-slot and corrupts our restore position.
 *
 * Instead we use only:
 *   \x1b[<n>B  — cursor down n lines (to reach suggestion lines)
 *   \x1b[<n>A  — cursor up n lines (back to prompt)
 *   \x1b[2K    — erase entire line
 *   \r         — carriage return (col 0)
 *   readline.cursorTo — explicit column positioning after returning to prompt
 */
class CommandSuggestions {
  private renderedCount = 0;
  private selectedIdx = 0;
  private matches: FlatCommand[] = [];
  private active = process.stdout.isTTY === true;
  private rl: readline.Interface;

  constructor(rl: readline.Interface) {
    this.rl = rl;
  }

  refresh(line: string): void {
    if (!this.active) return;
    const trimmed = line.trimStart();

    if (!trimmed.startsWith('/') || trimmed.length < 1) {
      this.hide();
      return;
    }

    const all = getAllCommands();
    const newMatches = all.filter(c => c.name.startsWith(trimmed));

    if (newMatches.length === 0 || (newMatches.length === 1 && newMatches[0]!.name === trimmed)) {
      this.hide();
      return;
    }

    this.matches = newMatches;
    if (this.selectedIdx >= this.matches.length) this.selectedIdx = 0;
    this.render();
  }

  moveUp(): void {
    if (this.matches.length === 0) return;
    this.selectedIdx = this.selectedIdx <= 0 ? this.matches.length - 1 : this.selectedIdx - 1;
    this.render();
  }

  moveDown(): void {
    if (this.matches.length === 0) return;
    this.selectedIdx = this.selectedIdx >= this.matches.length - 1 ? 0 : this.selectedIdx + 1;
    this.render();
  }

  accept(): string | null {
    if (this.matches.length === 0) return null;
    const cmd = this.matches[this.selectedIdx]!.name + ' ';
    this.hide();
    return cmd;
  }

  isVisible(): boolean { return this.renderedCount > 0; }

  hide(): void {
    this.clearLines();
    this.matches = [];
    this.selectedIdx = 0;
  }

  pause(): void { this.active = false; this.hide(); }
  resume(): void { this.active = true; }

  // -- internal --------------------------------------------------------

  private render(): void {
    this.clearLines();

    const items = this.matches.slice(0, 8);
    const out = process.stdout;
    const n = items.length;

    // Pre-scroll: write N newlines to ensure terminal has room below.
    // Then move back up. This handles the case where the prompt is near
    // the bottom of the screen — the terminal scrolls to make space.
    for (let i = 0; i < n; i++) out.write('\n');
    out.write(`\x1b[${n}A`);

    // Render each suggestion line below the prompt
    for (let i = 0; i < items.length; i++) {
      const m = items[i]!;
      const sel = i === this.selectedIdx;
      const prefix = sel ? chalk.cyan(' \u25B8 ') : '   ';
      const name = sel ? chalk.cyan.bold(m.name) : chalk.cyan(m.name);
      const args = m.args ? chalk.dim(` ${m.args}`) : '';
      const desc = chalk.dim(` \u2014 ${m.description}`);
      out.write('\x1b[1B');                 // cursor down 1
      out.write('\r\x1b[2K');               // col 0 + clear entire line
      out.write(`${prefix}${name}${args}${desc}`);
    }

    this.renderedCount = items.length;

    // Return to prompt line and position cursor correctly
    out.write(`\x1b[${n}A`);               // move up N lines
    this.positionCursor();
  }

  private clearLines(): void {
    if (this.renderedCount === 0) return;
    const out = process.stdout;
    // Move down to each suggestion line and clear it
    for (let i = 0; i < this.renderedCount; i++) {
      out.write('\x1b[1B');                 // cursor down 1
      out.write('\r\x1b[2K');               // col 0 + clear line
    }
    // Return to prompt line
    out.write(`\x1b[${this.renderedCount}A`);
    this.positionCursor();
    this.renderedCount = 0;
  }

  /** Put cursor at the correct column on the prompt line. */
  private positionCursor(): void {
    const prompt = (this.rl as any)._prompt ?? '';
    const promptWidth = stripAnsi(prompt).length;
    const cursor: number = (this.rl as any).cursor ?? 0;
    readline.cursorTo(process.stdout, promptWidth + cursor);
  }
}

// --------------------------------------------------------------------------
// Command handler
// --------------------------------------------------------------------------

interface CommandResult {
  clearHistory?: boolean;
  recreateBackend?: boolean;
  projectPath?: string | null; // null = close project
  projectName?: string;
}

async function handleCommand(
  input: string,
  config: ConfigManager,
  currentProjectPath: string | undefined,
  askUser?: (question: string) => Promise<string>,
): Promise<CommandResult> {
  const parts = input.trim().split(/\s+/);
  const cmd = parts[0]!.toLowerCase();

  switch (cmd) {
    case '/help':
      printHelp();
      return {};
    case '/quit':
    case '/exit':
      console.log(chalk.dim('\n  Goodbye!\n'));
      process.exit(0);
    case '/clear':
      console.clear();
      printHeader();
      printSystem('Conversation cleared.');
      return { clearHistory: true };
    case '/auto':
      config.set('autoMode', !config.config.autoMode);
      printSystem(`Auto mode: ${config.config.autoMode ? 'ON' : 'OFF'}`);
      return {};
    case '/model': {
      if (parts[1]) {
        config.setLLM({ model: parts[1] });
        printSystem(`Model switched to: ${chalk.cyan(parts[1])}`);
        return { recreateBackend: true };
      }
      // Interactive model selection for current provider
      const { PROVIDER_MODELS } = await import('../llm/factory.js');
      const models = PROVIDER_MODELS[config.llm.provider] ?? [];
      const current = config.llm.model;
      if (models.length === 0 || !askUser) {
        printSystem(`Provider: ${chalk.cyan(config.llm.provider)}  Model: ${chalk.cyan.bold(current)}`);
        return {};
      }
      console.log(chalk.bold(`\n  ${config.llm.provider} models:`));
      models.forEach((m, i) => {
        const marker = m === current ? chalk.green(' \u25CF') : chalk.dim(' \u25CB');
        console.log(`  ${chalk.cyan(`${i + 1})`)}${marker} ${m === current ? chalk.bold(m) : m}`);
      });
      console.log(`  ${chalk.cyan(`${models.length + 1})`)} ${chalk.dim('Custom model name')}`);
      console.log(`  ${chalk.cyan(`0)`)} ${chalk.dim('Cancel')}`);
      console.log();
      const answer = await askUser('Select model:');
      const idx = parseInt(answer.trim());
      if (idx === 0 || isNaN(idx)) {
        printSystem('Cancelled.');
        return {};
      }
      if (idx >= 1 && idx <= models.length) {
        const selected = models[idx - 1]!;
        if (selected === current) {
          printSystem(`Already using ${chalk.cyan(selected)}.`);
          return {};
        }
        config.setLLM({ model: selected });
        printSystem(`Model switched to: ${chalk.cyan.bold(selected)}`);
        return { recreateBackend: true };
      }
      if (idx === models.length + 1) {
        const customName = await askUser('Enter model name:');
        if (!customName.trim()) { printSystem('Cancelled.'); return {}; }
        config.setLLM({ model: customName.trim() });
        printSystem(`Model switched to: ${chalk.cyan.bold(customName.trim())}`);
        return { recreateBackend: true };
      }
      printSystem('Invalid selection.');
      return {};
    }
    case '/provider':
      if (parts[1]) {
        config.setLLM({ provider: parts[1] as import('../config/schema.js').LLMProvider });
        printSystem(`Provider switched to: ${parts[1]}`);
        return { recreateBackend: true };
      }
      printSystem(`Current provider: ${config.llm.provider}`);
      return {};
    case '/config':
      printSystem(`Provider: ${config.llm.provider}  Model: ${config.llm.model}  Auto: ${config.config.autoMode}`);
      return {};
    case '/tools': {
      const { ToolRegistry } = await import('../tools/registry.js');
      const registry = new ToolRegistry();
      await registry.loadBuiltins();
      console.log();
      for (const tool of registry.getAll()) {
        const icon = tool.available ? chalk.green('\u25CF') : chalk.dim('\u25CB');
        const status = tool.available ? chalk.green('Available') : chalk.dim('Not found');
        console.log(`  ${icon} ${tool.displayName.padEnd(28)} ${chalk.dim(`[${tool.category}]`)} ${status}`);
      }
      console.log();
      return {};
    }
    case '/continue':
      printSystem('Resuming workflow...');
      return {}; // Handled in main loop
    case '/log': {
      if (currentProjectPath) {
        const logDir = path.join(currentProjectPath, '.rtl-claw/logs');
        try {
          const files = await fs.readdir(logDir);
          const latest = files.sort().pop();
          if (latest) {
            const content = await fs.readFile(path.join(logDir, latest), 'utf-8');
            const lines = content.split('\n').slice(-20);
            console.log(chalk.dim('\n  Recent log entries:'));
            for (const line of lines) console.log(chalk.dim(`  ${line}`));
            console.log();
          } else {
            printSystem('No log files found.');
          }
        } catch {
          printSystem('No logs available.');
        }
      } else {
        printSystem('No project open. Open a project first.');
      }
      return {};
    }
    case '/project':
      return handleProjectCommand(parts);
    default:
      printSystem(`Unknown command: ${cmd}. Type /help for help.`);
      return {};
  }
}

async function handleProjectCommand(parts: string[]): Promise<CommandResult> {
  const action = parts[1];
  const arg = parts.slice(2).join(' ');

  const { ProjectManager } = await import('../project/manager.js');
  const pm = new ProjectManager();

  switch (action) {
    case 'list': {
      const projects = await pm.listProjects();
      if (projects.length === 0) {
        printSystem('No projects found. Use /project init <name> or /project open <path>');
      } else {
        console.log();
        for (const p of projects) {
          console.log(`  ${chalk.cyan('\u25CF')} ${chalk.bold(p.name.padEnd(20))} ${chalk.dim(p.rootPath)}`);
        }
        console.log();
      }
      return {};
    }
    case 'open': {
      if (!arg) { printSystem('Usage: /project open <path>'); return {}; }
      try {
        // Check EDA tools
        const { available } = await checkEdaTools();
        if (available.length === 0) {
          printSystem(chalk.yellow('Warning: No EDA tools found. Install iverilog or verilator for lint/simulation.'));
        } else {
          printSystem(`EDA: ${available.map(t => chalk.green(t)).join(chalk.dim(', '))}`);
        }

        const info = await pm.openProject(arg);
        printSystem(`Project: ${chalk.bold(info.name)} (${info.rootPath})`);
        printSystem(`Mode: ${chalk.cyan('Project Mode')} - design workflow enabled`);
        printSystem(chalk.dim('Tip: Say "design/create/implement ..." to start a design workflow, other messages are treated as chat.'));

        // Check for interrupted workflow
        const state = await pm.loadWorkflowState(info.rootPath);
        if (state) {
          printSystem(chalk.yellow('Previous workflow state detected.'));
        }

        return { projectPath: info.rootPath, projectName: info.name };
      } catch (e) {
        printError(e instanceof Error ? e.message : String(e));
        return {};
      }
    }
    case 'init': {
      const name = arg || 'untitled';
      const rootPath = path.isAbsolute(name) ? name : path.join(process.cwd(), name);

      // Check EDA tools
      const { available } = await checkEdaTools();
      if (available.length === 0) {
        printSystem(chalk.yellow('Warning: No EDA tools found. Install iverilog or verilator for lint/simulation.'));
      }

      try {
        const projectName = path.basename(rootPath);
        const info = await pm.createProject(rootPath, projectName);
        printSystem(`Created project: ${chalk.bold(info.name)} at ${info.rootPath}`);
        printSystem(`Mode: ${chalk.cyan('Project Mode')} - design workflow enabled`);
        printSystem(chalk.dim('Tip: Say "design/create/implement ..." to start a design workflow, other messages are treated as chat.'));
        return { projectPath: info.rootPath, projectName: info.name };
      } catch (e) {
        printError(e instanceof Error ? e.message : String(e));
        return {};
      }
    }
    case 'close':
      printSystem(`Closed project. Mode: ${chalk.dim('Claw Mode')}`);
      return { projectPath: null };
    default:
      printSystem('Usage: /project [list|open <path>|init <name>|close]');
      return {};
  }
}

// --------------------------------------------------------------------------
// Orchestrator output processing
// --------------------------------------------------------------------------

async function processOrchestratorOutput(
  orchestrator: Orchestrator,
  userMessage: string,
  context: OrchestratorContext,
  spinner: Spinner,
): Promise<string> {
  let fullContent = '';
  let isStreaming = false;

  for await (const chunk of orchestrator.handleMessage(userMessage, context)) {
    switch (chunk.type) {
      case 'progress':
        if (isStreaming) {
          console.log(); // End streaming line
          isStreaming = false;
        }
        // Tool invocations ("> tool_name: ...") show on spinner (transient);
        // Tool results (anything else) print persistently so user can see them.
        if (chunk.content.startsWith('> ')) {
          spinner.start(chunk.content);
        } else {
          spinner.stop();
          // Detect workflow progress patterns like "[2/5] Stage: module_name"
          const progressMatch = chunk.content.match(/\[(\d+)\/(\d+)\]\s*(.*)/);
          if (progressMatch) {
            const cur = parseInt(progressMatch[1]!);
            const tot = parseInt(progressMatch[2]!);
            const rest = progressMatch[3]!;
            const stageMatch = rest.match(/^(\w[\w\s]*?):\s*(.+)/);
            if (stageMatch) {
              printProgressBar(cur, tot, stageMatch[2]!, stageMatch[1]);
            } else {
              printProgressBar(cur, tot, rest);
            }
          } else {
            console.log(chalk.dim('  ' + chunk.content));
          }
        }
        break;

      case 'text':
        spinner.stop();
        if (chunk.metadata?.streaming) {
          // Streaming output - write inline with proper indentation
          if (!isStreaming) {
            console.log(chalk.cyan.bold('  RTL-Claw:'));
            process.stdout.write('    ');
            isStreaming = true;
          }
          // Add indentation after each newline so multi-line streams align
          const indented = chunk.content.replace(/\n/g, '\n    ');
          process.stdout.write(indented);
        } else {
          if (isStreaming) {
            console.log('\n');
            isStreaming = false;
          }
          // Block output
          console.log(chalk.cyan.bold('  RTL-Claw:'));
          for (const line of chunk.content.split('\n')) {
            console.log('    ' + line);
          }
          console.log();
        }
        fullContent += chunk.content;
        break;

      case 'status':
        spinner.stop();
        if (isStreaming) {
          console.log('\n');
          isStreaming = false;
        }
        // Highlight simulation results in status messages
        if (/PASSED|FAILED|ERROR:/i.test(chunk.content)) {
          printResult(chunk.content);
        } else if (/Debug round|debug loop/i.test(chunk.content)) {
          const roundMatch = chunk.content.match(/(\d+)\s*\/\s*(\d+)/);
          if (roundMatch) {
            printDebugRound(parseInt(roundMatch[1]!), parseInt(roundMatch[2]!), chunk.content);
          } else {
            console.log(chalk.yellow('  \u25B6 ') + chalk.dim(chunk.content));
          }
        } else {
          console.log(chalk.dim('  ' + chunk.content));
        }
        break;

      case 'code':
        spinner.stop();
        if (isStreaming) {
          console.log('\n');
          isStreaming = false;
        }
        printCodeBlock(chunk.content, (chunk.metadata?.lang as string) ?? undefined);
        break;

      case 'confirm':
        spinner.stop();
        if (isStreaming) {
          console.log('\n');
          isStreaming = false;
        }
        printSystem(chunk.content);
        break;

      case 'error':
        spinner.stop();
        if (isStreaming) {
          console.log('\n');
          isStreaming = false;
        }
        printError(chunk.content);
        break;
    }
  }

  if (isStreaming) {
    console.log('\n');
  }

  spinner.stop();
  return fullContent;
}

// --------------------------------------------------------------------------
// Main loop
// --------------------------------------------------------------------------

export async function startApp(configManager: ConfigManager, projectPath?: string): Promise<void> {
  printHeader();

  const fallbackInfo = configManager.config.fallbackLlm
    ? chalk.dim(`  fallback: ${configManager.config.fallbackLlm.provider}/${configManager.config.fallbackLlm.model}`)
    : '';
  printContextBar(configManager.llm.model);
  if (fallbackInfo) printSystem(fallbackInfo);
  printSystem(`Type ${chalk.cyan('/help')} for commands.\n`);

  // Create backend (with optional fallback)
  const { createBackendWithFallback } = await import('../llm/factory.js');
  let backend: LLMBackend = await createBackendWithFallback(
    configManager.llm,
    configManager.config.fallbackLlm,
    (from, to, error) => {
      printSystem(chalk.yellow(`⚡ Provider ${from} failed (${error.slice(0, 80)}), switching to ${to}`));
    },
  );
  let orchestrator = new Orchestrator(backend);

  const spinner = new Spinner();
  const history: ChatMessage[] = [];

  // Track current project
  let currentProjectPath: string | undefined = projectPath;
  let currentProjectName: string | undefined;
  let projectMode = false;

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: buildPrompt(),
    terminal: true,
  });

  // Dropdown command suggestions
  const suggestions = new CommandSuggestions(rl);

  // Monkey-patch _ttyWrite to intercept keys BEFORE readline processes them.
  // This lets us swallow Tab/Up/Down when the dropdown is open, avoiding
  // conflicts with readline's built-in completer and history navigation.
  const origTtyWrite = (rl as any)._ttyWrite;
  (rl as any)._ttyWrite = function (s: string, key: { name?: string; ctrl?: boolean; meta?: boolean; shift?: boolean; sequence?: string }) {
    if (busy || rlClosed) {
      return origTtyWrite.call(this, s, key);
    }

    const dropdownOpen = suggestions.isVisible();

    // Tab → accept dropdown selection (swallow key entirely)
    if (key?.name === 'tab') {
      const accepted = suggestions.accept();
      if (accepted) {
        // Replace readline's internal line buffer
        (rl as any).line = accepted;
        (rl as any).cursor = accepted.length;
        // Redraw prompt + accepted text
        readline.clearLine(process.stdout, 0);
        readline.cursorTo(process.stdout, 0);
        process.stdout.write((rl as any)._prompt + accepted);
        // Refresh dropdown for the new input
        suggestions.refresh(accepted);
        return; // swallow Tab
      }
      // No dropdown → just swallow Tab (don't trigger readline completer)
      return;
    }

    // Up/Down → navigate dropdown if open (swallow key)
    if (key?.name === 'up' && dropdownOpen) {
      suggestions.moveUp();
      return;
    }
    if (key?.name === 'down' && dropdownOpen) {
      suggestions.moveDown();
      return;
    }

    // Enter → hide dropdown, let readline process the line
    if (key?.name === 'return') {
      suggestions.hide();
      return origTtyWrite.call(this, s, key);
    }

    // Escape → hide dropdown, keep input as-is
    if (key?.name === 'escape') {
      suggestions.hide();
      return;
    }

    // Ctrl+C → hide dropdown, let readline handle SIGINT
    if (key?.ctrl && key?.name === 'c') {
      suggestions.hide();
      return origTtyWrite.call(this, s, key);
    }

    // All other keys: hide dropdown → let readline process → refresh dropdown
    suggestions.hide();
    origTtyWrite.call(this, s, key);
    const newLine = (rl as any).line as string ?? '';
    suggestions.refresh(newLine);
  };

  let rlClosed = false;
  // AbortController for cancelling in-flight LLM requests on Ctrl+C
  let currentAbort: AbortController | null = null;
  // Track whether SIGINT already handled the prompt restoration for the current operation
  let sigintHandled = false;

  // Handle Ctrl+C: if busy (LLM/sim running), abort current operation and return to prompt.
  // If idle (waiting for input), exit the process.
  const handleSigint = () => {
    if (busy) {
      // Abort in-flight operation
      spinner.stop();
      if (currentAbort) {
        currentAbort.abort();
        currentAbort = null;
      }
      console.log(chalk.yellow('\n  \u26A0 Operation cancelled (Ctrl+C)'));
      busy = false;
      sigintHandled = true;
      if (!rlClosed) {
        rl.resume();
        showPrompt();
      }
    } else {
      // Idle — exit
      spinner.stop();
      console.log(chalk.dim('\n  Goodbye!\n'));
      process.exit(0);
    }
  };

  rl.on('SIGINT', handleSigint);
  // Also handle process-level SIGINT for when readline is paused
  process.on('SIGINT', handleSigint);

  rl.on('close', () => { rlClosed = true; });

  const askUser = (question: string): Promise<string> => {
    // Stop the spinner so the question is visible to the user
    spinner.stop();
    return new Promise((resolve) => {
      try {
        rl.resume(); // Ensure readline is active for input
        rl.question(chalk.yellow(`  ${question} `), (answer) => {
          resolve(answer);
        });
      } catch {
        resolve('');
      }
    });
  };

  /** Show context bar + prompt */
  const showPrompt = () => {
    printContextBar(configManager.llm.model, projectMode ? currentProjectName : undefined);
    rl.prompt();
  };

  // Always start in Claw Mode — user uses /project to open or create a project
  printSystem(`Mode: ${chalk.cyan.bold('Claw Mode')} ${chalk.dim('\u2014 use /project to enter Project Mode')}\n`);

  // Chat loop
  let busy = false;

  rl.on('line', async (line: string) => {
    const input = line.trim();
    if (!input) { showPrompt(); return; }
    if (busy) return;

    // Commands
    if (input.startsWith('/')) {
      suggestions.hide();
      const result = await handleCommand(input, configManager, currentProjectPath, askUser);
      if (result.clearHistory) history.length = 0;
      if (result.recreateBackend) {
        try {
          backend = await createBackendWithFallback(
            configManager.llm,
            configManager.config.fallbackLlm,
            (from, to, error) => {
              printSystem(chalk.yellow(`⚡ Provider ${from} failed (${error.slice(0, 80)}), switching to ${to}`));
            },
          );
          orchestrator = new Orchestrator(backend);
        } catch { /* next message will fail */ }
      }
      if (result.projectPath !== undefined) {
        if (result.projectPath === null) {
          // Close project
          currentProjectPath = undefined;
          currentProjectName = undefined;
          projectMode = false;
        } else {
          currentProjectPath = result.projectPath;
          currentProjectName = result.projectName;
          projectMode = true;
        }
      }
      // Update prompt based on mode
      rl.setPrompt(buildPrompt());
      showPrompt();
      return;
    }

    // Chat message
    busy = true;
    suggestions.pause();
    currentAbort = new AbortController();
    rl.pause();
    printUser();
    spinner.start('Thinking...');

    // Build context
    const context: OrchestratorContext = {
      history,
      autoMode: configManager.config.autoMode,
      projectPath: currentProjectPath,
      projectName: currentProjectName,
      projectMode,
      hdlStandard: configManager.config.project.hdlStandard,
      targetDevice: configManager.config.project.targetDevice,
      signal: currentAbort?.signal,
      askUser,
      executeAction: (action: Action) => executeAction(action, currentProjectPath, configManager.config.project.hdlStandard, context.logLLMTrace, currentAbort?.signal),
    };

    // Add state management callbacks if in project mode
    if (currentProjectPath && projectMode) {
      const projPath = currentProjectPath;
      context.saveState = async (state: WorkflowState) => {
        const { ProjectManager } = await import('../project/manager.js');
        const pm = new ProjectManager();
        await pm.saveWorkflowState(projPath, state);
      };
      context.loadState = async () => {
        const { ProjectManager } = await import('../project/manager.js');
        const pm = new ProjectManager();
        return pm.loadWorkflowState(projPath);
      };
      context.logLLMTrace = async (entry: LLMTraceEntry) => {
        await writeLLMTrace(projPath, entry);
      };
      context.readFile = async (relativePath: string) => {
        return fs.readFile(path.resolve(projPath, relativePath), 'utf-8');
      };

      // Load design index
      try {
        const { ProjectManager } = await import('../project/manager.js');
        const pm = new ProjectManager();
        context.designIndex = await pm.loadDesignIndex(projPath);
      } catch { /* no index yet */ }
    }

    try {
      await processOrchestratorOutput(orchestrator, input, context, spinner);
    } catch (err) {
      spinner.stop();
      // Don't show error for user-initiated abort
      if (err instanceof Error && (err.name === 'AbortError' || err.message.includes('aborted'))) {
        // Already handled by SIGINT handler
      } else {
        printError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      busy = false;
      currentAbort = null;
      suggestions.resume();
      // Only restore prompt if SIGINT handler hasn't already done it
      if (!sigintHandled && !rlClosed) {
        rl.resume();
        showPrompt();
      }
      sigintHandled = false;
    }
  });

  // Set initial prompt
  if (!rlClosed) {
    rl.setPrompt(buildPrompt());
    showPrompt();
  }
  await new Promise<void>((resolve) => {
    if (rlClosed) { resolve(); return; }
    rl.on('close', resolve);
  });
}
