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
import { execAsync } from '../utils/exec.js';

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
    chalk.bold.hex('#9944FF')('  \u25B8 Model & Config'),
    cmd('/model', 'Show or switch model'),
    cmd('/provider <name>', 'Switch LLM provider'),
    cmd('/config show', 'Show full configuration'),
    cmd('/config set <key> <val>', 'Set config value'),
    cmd('/config reset', 'Reset to defaults'),
    cmd('/config ...', 'apikey|fallback|simulator|hdl|device|timeout|debug|path'),
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

  get isRunning(): boolean { return this.timer !== null; }

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
  filelistPath?: string,
): Promise<string> {
  const baseDir = projectPath ?? process.cwd();
  const flPath = filelistPath ?? 'hw/src/filelist/design.f';

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

      // Lint uses -y (library search) instead of -f (file list) to avoid
      // MODDUP — the filelist may already contain the target file.
      // -y tells the tool to search directories for module definitions
      // on demand; the standard EDA approach for single-file lint.
      const filelistPath = path.join(baseDir, flPath);
      let srcDirs: string[] = [];
      let incPaths: string[] = [];   // raw paths without +incdir+ prefix
      if (existsSync(filelistPath)) {
        const flLines = (await fs.readFile(filelistPath, 'utf-8'))
          .split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#'));
        incPaths = flLines.filter(l => l.startsWith('+incdir+')).map(l => l.slice(8));
        srcDirs = [...new Set(
          flLines
            .filter(l => !l.startsWith('+') && !l.startsWith('-'))
            .map(l => path.dirname(l)),
        )];
      }
      const yArgs = srcDirs.map(d => `-y ${d}`).join(' ');

      try {
        await execAsync('which verilator', { signal });
        const incArgs = incPaths.map(d => `+incdir+${d}`).join(' ');
        lintCmd = `${envPrefix}verilator --lint-only -Wall ${yArgs} ${incArgs} ${filePath} 2>&1 || true`.replace(/ {2,}/g, ' ');
        lintResult = await execAsync(lintCmd, { cwd: baseDir, timeout: 30_000, signal });
        lintResult = lintResult || '  Lint: passed';
      } catch (e) {
        if (e instanceof DOMException && e.name === 'AbortError') throw e;
        try {
          await execAsync('which iverilog', { signal });
          const incArgs = incPaths.map(d => `-I ${d}`).join(' ');
          lintCmd = `${envPrefix}iverilog ${iverilogGen} -tnull ${yArgs} ${incArgs} ${filePath} 2>&1 || true`.replace(/ {2,}/g, ' ');
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
      const filelistPath = path.join(baseDir, flPath);
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
          // Use just the filename in include — -I flag provides the search dir
          const tempTBContent = tbContent.replace(/`include\s+"PLACEHOLDER_TC"/g, `\`include "${tcFile}"`);
          await fs.writeFile(tempTBPath, tempTBContent, 'utf-8');

          const vvpPath = path.join(simDir, `sim_${tcFile.replace(/\.\w+$/, '')}.vvp`);
          // TB/TC are always SystemVerilog (-g2012) regardless of RTL hdlStandard
          const compileCmd = `${envPrefix}iverilog -g2012 -I ${tcPath} -o ${vvpPath} ${tempTBPath}${rtlSources} 2>&1`;
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
        // TB/TC are always SystemVerilog (-g2012) regardless of RTL hdlStandard
        const compileCmd = `${envPrefix}iverilog -g2012 -o ${vvpPath} ${tbFilePath}${rtlSources} 2>&1`;
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
          const filelistPath = path.join(baseDir, flPath);
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
  { name: '/swap', description: 'Swap primary ↔ fallback provider' },
  { name: '/provider', args: '<name>', description: 'Switch LLM provider' },
  {
    name: '/config', args: '<action>', description: 'Manage configuration',
    subcommands: [
      { name: '/config show', description: 'Show full config' },
      { name: '/config set', args: '<key> <value>', description: 'Set config value' },
      { name: '/config reset', description: 'Reset to defaults' },
      { name: '/config apikey', args: '[key]', description: 'Set or view API key' },
      { name: '/config fallback', args: '[provider/model]', description: 'Set/clear fallback LLM' },
      { name: '/config simulator', args: '<name>', description: 'Set default simulator' },
      { name: '/config hdl', args: '<standard>', description: 'Set HDL standard' },
      { name: '/config device', args: '<name>', description: 'Set target device' },
      { name: '/config timeout', args: '<ms>', description: 'Set LLM timeout' },
      { name: '/config debug', description: 'Show/set debug params' },
      { name: '/config path', description: 'Show config file path' },
    ],
  },
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
  /** Cached projects for /project open completion, local-first */
  private cachedProjects: Array<{ name: string; rootPath: string; local: boolean }> = [];
  private projectNamesLoaded = false;

  constructor(rl: readline.Interface) {
    this.rl = rl;
  }

  /** Reload cached project list, marking local (under cwd) projects */
  async reloadProjects(): Promise<void> {
    try {
      const { ProjectManager } = await import('../project/manager.js');
      const pm = new ProjectManager();
      const projects = await pm.listProjects();
      const cwd = process.cwd() + path.sep;
      this.cachedProjects = projects.map(p => ({
        ...p,
        local: p.rootPath === process.cwd() || p.rootPath.startsWith(cwd),
      }));
      // Local projects first
      this.cachedProjects.sort((a, b) => (a.local === b.local ? 0 : a.local ? -1 : 1));
      this.projectNamesLoaded = true;
    } catch { this.cachedProjects = []; }
  }

  /** Get sorted project list (local first) */
  getProjects(): Array<{ name: string; rootPath: string; local: boolean }> {
    return this.cachedProjects;
  }

  refresh(line: string): void {
    if (!this.active) return;
    const trimmed = line.trimStart();

    if (!trimmed.startsWith('/') || trimmed.length < 1) {
      this.hide();
      return;
    }

    // Check for "/project open <partial>" — show project name completions
    const projectOpenMatch = trimmed.match(/^\/project\s+open\s+(.*)$/i);
    if (projectOpenMatch) {
      if (!this.projectNamesLoaded) {
        // Trigger async load; will show on next keystroke
        void this.reloadProjects().then(() => {
          const currentLine = ((this.rl as any).line as string ?? '').trimStart();
          if (currentLine.match(/^\/project\s+open\s+/i)) this.refresh(currentLine);
        });
        return;
      }
      const partial = projectOpenMatch[1]!.toLowerCase();
      const nameMatches = this.cachedProjects
        .filter(p => p.name.toLowerCase().startsWith(partial))
        .map(p => ({
          name: `/project open ${p.name}`,
          description: p.local ? 'Local' : p.rootPath,
        }));
      if (nameMatches.length === 0 || (nameMatches.length === 1 && nameMatches[0]!.name === trimmed)) {
        this.hide();
        return;
      }
      this.matches = nameMatches;
      if (this.selectedIdx >= this.matches.length) this.selectedIdx = 0;
      this.render();
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

    const maxVisible = 8;
    const total = this.matches.length;
    // Compute scroll window so selectedIdx is always visible
    let scrollTop = 0;
    if (this.selectedIdx >= maxVisible) {
      scrollTop = this.selectedIdx - maxVisible + 1;
    }
    const visibleCount = Math.min(maxVisible, total - scrollTop);
    const out = process.stdout;

    // Pre-scroll: write N newlines to ensure terminal has room below.
    // Then move back up. This handles the case where the prompt is near
    // the bottom of the screen — the terminal scrolls to make space.
    for (let i = 0; i < visibleCount; i++) out.write('\n');
    out.write(`\x1b[${visibleCount}A`);

    // Render each suggestion line below the prompt
    for (let row = 0; row < visibleCount; row++) {
      const idx = scrollTop + row;
      const m = this.matches[idx]!;
      const sel = idx === this.selectedIdx;
      const prefix = sel ? chalk.cyan(' \u25B8 ') : '   ';
      const name = sel ? chalk.cyan.bold(m.name) : chalk.cyan(m.name);
      const args = m.args ? chalk.dim(` ${m.args}`) : '';
      const desc = chalk.dim(` \u2014 ${m.description}`);
      // Scroll indicators
      let indicator = '';
      if (row === 0 && scrollTop > 0) indicator = chalk.dim(' ↑');
      if (row === visibleCount - 1 && scrollTop + visibleCount < total) indicator = chalk.dim(' ↓');
      out.write('\x1b[1B');                 // cursor down 1
      out.write('\r\x1b[2K');               // col 0 + clear entire line
      out.write(`${prefix}${name}${args}${desc}${indicator}`);
    }

    this.renderedCount = visibleCount;

    // Return to prompt line and position cursor correctly
    out.write(`\x1b[${visibleCount}A`);    // move up N lines
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
// Interactive arrow-key selector
// --------------------------------------------------------------------------

/**
 * Show a list of options and let the user pick one using Up/Down + Enter.
 * Returns the selected item string, or null if cancelled (Esc / Ctrl+C).
 */
function interactiveSelect(
  rl: readline.Interface,
  title: string,
  items: string[],
  opts?: { highlight?: number },
): Promise<string | null> {
  return new Promise((resolve) => {
    if (items.length === 0) { resolve(null); return; }

    let selected = opts?.highlight ?? 0;
    const maxShow = Math.min(items.length, 12);
    let scrollTop = 0; // first visible index
    const out = process.stdout;

    // Keep selected within the visible viewport
    const adjustScroll = () => {
      if (selected < scrollTop) scrollTop = selected;
      if (selected >= scrollTop + maxShow) scrollTop = selected - maxShow + 1;
    };
    adjustScroll(); // initial

    const render = () => {
      // Move up to first item line (cursor is on last item line after render)
      if (rendered && maxShow > 1) {
        out.write(`\x1b[${maxShow - 1}A`);
      }
      for (let row = 0; row < maxShow; row++) {
        const idx = scrollTop + row;
        out.write('\r\x1b[2K');
        if (idx < items.length) {
          const sel = idx === selected;
          const prefix = sel ? chalk.cyan(' \u25B8 ') : '   ';
          const text = sel ? chalk.cyan.bold(items[idx]!) : items[idx]!;
          // Show scroll indicators
          let indicator = '';
          if (row === 0 && scrollTop > 0) indicator = chalk.dim(' ↑');
          if (row === maxShow - 1 && scrollTop + maxShow < items.length) indicator = chalk.dim(' ↓');
          out.write(`  ${prefix}${text}${indicator}`);
        }
        if (row < maxShow - 1) out.write('\n');
      }
      out.write('\r');
      rendered = true;
    };

    let rendered = false;

    // Print title
    console.log(chalk.bold(`\n  ${title}`));

    // Pre-scroll
    for (let i = 0; i < maxShow; i++) out.write('\n');
    out.write(`\x1b[${maxShow}A`);

    render();

    // Temporarily replace _ttyWrite to capture keys
    const origWrite = (rl as any)._ttyWrite;
    (rl as any)._ttyWrite = function (s: string, key: { name?: string; ctrl?: boolean }) {
      if (key?.name === 'up') {
        selected = selected <= 0 ? items.length - 1 : selected - 1;
        adjustScroll();
        render();
        return;
      }
      if (key?.name === 'down') {
        selected = selected >= items.length - 1 ? 0 : selected + 1;
        adjustScroll();
        render();
        return;
      }
      if (key?.name === 'return') {
        cleanup();
        resolve(items[selected]!);
        return;
      }
      if (key?.name === 'escape' || (key?.ctrl && key?.name === 'c')) {
        cleanup();
        resolve(null);
        return;
      }
    };

    const cleanup = () => {
      (rl as any)._ttyWrite = origWrite;
      // Move cursor below the rendered list
      if (rendered) {
        out.write(`\x1b[${maxShow - 1}B`);
        out.write('\n');
      }
    };
  });
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
  rlRef?: readline.Interface,
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
      if (models.length === 0 || !rlRef) {
        printSystem(`Provider: ${chalk.cyan(config.llm.provider)}  Model: ${chalk.cyan.bold(current)}`);
        return {};
      }
      const options = [...models, '[ Custom model name ]'];
      const currentIdx = models.indexOf(current);
      const selected = await interactiveSelect(
        rlRef,
        `${config.llm.provider} models:`,
        options,
        { highlight: currentIdx >= 0 ? currentIdx : 0 },
      );
      if (!selected) { printSystem('Cancelled.'); return {}; }
      if (selected === '[ Custom model name ]') {
        if (!askUser) return {};
        const customName = await askUser('Enter model name:');
        if (!customName.trim()) { printSystem('Cancelled.'); return {}; }
        config.setLLM({ model: customName.trim() });
        printSystem(`Model switched to: ${chalk.cyan.bold(customName.trim())}`);
        return { recreateBackend: true };
      }
      if (selected === current) {
        printSystem(`Already using ${chalk.cyan(selected)}.`);
        return {};
      }
      config.setLLM({ model: selected });
      printSystem(`Model switched to: ${chalk.cyan.bold(selected)}`);
      return { recreateBackend: true };
    }
    case '/swap': {
      const fb = config.config.fallbackLlm;
      if (!fb) {
        printSystem('No fallback configured. Use /config fallback to set one.');
        return {};
      }
      const oldPrimary: import('../config/schema.js').LLMConfig = { ...config.llm };
      const oldFallback: import('../config/schema.js').LLMConfig = { ...fb };
      config.setLLM({ provider: oldFallback.provider, model: oldFallback.model, apiKey: oldFallback.apiKey, baseUrl: oldFallback.baseUrl });
      config.set('fallbackLlm', { provider: oldPrimary.provider, model: oldPrimary.model, apiKey: oldPrimary.apiKey, baseUrl: oldPrimary.baseUrl, temperature: oldPrimary.temperature, timeoutMs: oldPrimary.timeoutMs });
      printSystem(`Primary:  ${chalk.cyan.bold(`${oldFallback.provider}/${oldFallback.model}`)}`);
      printSystem(`Fallback: ${chalk.dim(`${oldPrimary.provider}/${oldPrimary.model}`)}`);
      return { recreateBackend: true };
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
      return handleConfigCommand(parts, config, askUser, rlRef);
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
      return handleProjectCommand(parts, rlRef);
    default:
      printSystem(`Unknown command: ${cmd}. Type /help for help.`);
      return {};
  }
}

async function handleConfigEdit(
  action: string,
  config: ConfigManager,
  askUser?: (question: string) => Promise<string>,
  rlRef?: readline.Interface,
  HDL_STANDARDS: readonly string[] = ['verilog2001', 'verilog2005', 'sv2012', 'sv2017', 'vhdl2008'],
): Promise<CommandResult> {
  const c = config.config;
  const PROVIDERS = ['openai', 'anthropic', 'gemini', 'deepseek', 'kimi', 'qwen', 'zhipu', 'ollama', 'openai-compatible'];

  switch (action) {
    case 'provider': {
      if (!rlRef) return {};
      const selected = await interactiveSelect(rlRef, 'Select provider:', PROVIDERS,
        { highlight: Math.max(0, PROVIDERS.indexOf(c.llm.provider)) });
      if (!selected) { printSystem('Cancelled.'); return {}; }
      // Ask for baseUrl (proxy) if switching to a non-openai provider
      let baseUrl: string | undefined;
      if (selected !== 'openai' && askUser) {
        const existing = c.llm.provider === selected ? c.llm.baseUrl : undefined;
        const prompt = existing
          ? `Base URL [${existing}] (Enter for default, proxy if needed):`
          : `Base URL for ${selected} (Enter to skip, or proxy address):`;
        const val = await askUser(prompt);
        baseUrl = val.trim() || existing || undefined;
      }
      config.setLLM({
        provider: selected as import('../config/schema.js').LLMProvider,
        ...(baseUrl !== undefined ? { baseUrl } : {}),
      });
      printSystem(`Provider: ${chalk.cyan(selected)}`);
      return { recreateBackend: true };
    }
    case 'model':
      return handleCommand('/model', config, undefined, askUser, rlRef);
    case 'apikey':
      return handleConfigCommand(['/config', 'apikey'], config, askUser, rlRef);
    case 'temperature': {
      if (!askUser) return {};
      const val = await askUser(`Temperature [${c.llm.temperature}]:`);
      if (val.trim()) {
        const n = parseFloat(val.trim());
        if (!isNaN(n) && n >= 0 && n <= 2) {
          config.setLLM({ temperature: n });
          printSystem(`temperature = ${chalk.cyan(String(n))}`);
        } else {
          printSystem('Invalid value (0-2).');
        }
      }
      return {};
    }
    case 'timeout':
      return handleConfigCommand(['/config', 'timeout'], config, askUser, rlRef);
    case 'fallback':
      return handleConfigCommand(['/config', 'fallback'], config, askUser, rlRef);
    case 'simulator':
      return handleConfigCommand(['/config', 'simulator'], config, askUser, rlRef);
    case 'hdl':
      return handleConfigCommand(['/config', 'hdl'], config, askUser, rlRef);
    case 'device':
      return handleConfigCommand(['/config', 'device'], config, askUser, rlRef);
    case 'autoMode': {
      const newVal = !c.autoMode;
      config.set('autoMode', newVal);
      printSystem(`autoMode = ${chalk.cyan(String(newVal))}`);
      return {};
    }
    case 'logLevel': {
      if (!rlRef) return {};
      const levels = ['debug', 'info', 'warn', 'error'];
      const selected = await interactiveSelect(rlRef, 'Select log level:', levels,
        { highlight: Math.max(0, levels.indexOf(c.logLevel)) });
      if (!selected) { printSystem('Cancelled.'); return {}; }
      config.set('logLevel', selected as 'debug' | 'info' | 'warn' | 'error');
      printSystem(`logLevel = ${chalk.cyan(selected)}`);
      return {};
    }
    case 'debug':
      return handleConfigCommand(['/config', 'debug'], config, askUser, rlRef);
    case 'reset':
      config.reset();
      printSystem(chalk.yellow('Config reset to defaults.'));
      return { recreateBackend: true };
    default:
      return {};
  }
}

async function handleConfigCommand(
  parts: string[],
  config: ConfigManager,
  askUser?: (question: string) => Promise<string>,
  rlRef?: readline.Interface,
): Promise<CommandResult> {
  const action = parts[1];
  const arg = parts.slice(2).join(' ').trim();
  const c = config.config;

  const HDL_STANDARDS = ['verilog2001', 'verilog2005', 'sv2012', 'sv2017', 'vhdl2008'] as const;

  switch (action) {
    case 'show':
    case undefined: {
      // Full config display
      const mask = (s?: string) => s ? s.slice(0, 4) + '****' + s.slice(-4) : chalk.dim('(not set)');
      const kv = (key: string, val: string) =>
        `  ${chalk.cyan(key.padEnd(24))}${val}`;
      console.log([
        '',
        chalk.bold.hex('#00BBFF')('  LLM'),
        kv('provider', c.llm.provider),
        kv('model', c.llm.model),
        kv('apiKey', mask(c.llm.apiKey)),
        kv('baseUrl', c.llm.baseUrl ?? chalk.dim('(default)')),
        kv('temperature', String(c.llm.temperature)),
        kv('timeoutMs', String(c.llm.timeoutMs)),
        '',
        chalk.bold.hex('#00BBFF')('  Fallback LLM'),
        c.fallbackLlm
          ? [kv('provider', c.fallbackLlm.provider), kv('model', c.fallbackLlm.model)].join('\n')
          : chalk.dim('  (not configured)'),
        '',
        chalk.bold.hex('#9944FF')('  Project Defaults'),
        kv('simulator', c.project.defaultSimulator),
        kv('synthesizer', c.project.defaultSynthesizer),
        kv('hdlStandard', c.project.hdlStandard),
        kv('targetDevice', c.project.targetDevice ?? chalk.dim('(not set)')),
        '',
        chalk.bold.hex('#FF22DD')('  Debug'),
        kv('sameErrorMaxRetries', String(c.debug.sameErrorMaxRetries)),
        kv('totalIterationCap', String(c.debug.totalIterationCap)),
        kv('vcdTimeMarginNs', String(c.debug.vcdTimeMarginNs)),
        kv('maxSignalsPerQuery', String(c.debug.maxSignalsPerQuery)),
        '',
        chalk.bold.white('  General'),
        kv('autoMode', String(c.autoMode)),
        kv('logLevel', c.logLevel),
        kv('storageDir', c.storageDir),
        '',
      ].join('\n'));

      // Interactive config menu
      if (!rlRef) return {};
      const menuItems = [
        { label: `provider          ${chalk.dim(c.llm.provider)}`, action: 'provider' },
        { label: `model             ${chalk.dim(c.llm.model)}`, action: 'model' },
        { label: `apiKey            ${chalk.dim(mask(c.llm.apiKey))}`, action: 'apikey' },
        { label: `temperature       ${chalk.dim(String(c.llm.temperature))}`, action: 'temperature' },
        { label: `timeoutMs         ${chalk.dim(String(c.llm.timeoutMs))}`, action: 'timeout' },
        { label: `fallback          ${chalk.dim(c.fallbackLlm ? `${c.fallbackLlm.provider}/${c.fallbackLlm.model}` : '(not set)')}`, action: 'fallback' },
        { label: `simulator         ${chalk.dim(c.project.defaultSimulator)}`, action: 'simulator' },
        { label: `hdlStandard       ${chalk.dim(c.project.hdlStandard)}`, action: 'hdl' },
        { label: `targetDevice      ${chalk.dim(c.project.targetDevice ?? '(not set)')}`, action: 'device' },
        { label: `autoMode          ${chalk.dim(String(c.autoMode))}`, action: 'autoMode' },
        { label: `logLevel          ${chalk.dim(c.logLevel)}`, action: 'logLevel' },
        { label: `debug params`, action: 'debug' },
        { label: chalk.dim('Reset to defaults'), action: 'reset' },
        { label: chalk.dim('Done'), action: 'done' },
      ];
      const selected = await interactiveSelect(
        rlRef, 'Edit config:', menuItems.map(m => m.label),
      );
      if (!selected) return {};
      const item = menuItems.find(m => m.label === selected);
      if (!item || item.action === 'done') return {};

      // Dispatch to the appropriate config action
      return handleConfigEdit(item.action, config, askUser, rlRef, HDL_STANDARDS);
    }

    case 'set': {
      // /config set <key> <value>
      const setKey = parts[2];
      const setVal = parts.slice(3).join(' ').trim();
      if (!setKey || !setVal) {
        printSystem('Usage: /config set <key> <value>');
        printSystem(chalk.dim('Keys: temperature, timeoutMs, autoMode, logLevel, simulator, hdl, device, maxRetries, iterationCap'));
        return {};
      }
      switch (setKey) {
        case 'temperature':
          config.setLLM({ temperature: parseFloat(setVal) });
          printSystem(`temperature = ${chalk.cyan(setVal)}`);
          return {};
        case 'timeoutMs':
        case 'timeout':
          config.setLLM({ timeoutMs: parseInt(setVal) });
          printSystem(`timeoutMs = ${chalk.cyan(setVal)}`);
          return {};
        case 'autoMode':
          config.set('autoMode', setVal === 'true' || setVal === '1');
          printSystem(`autoMode = ${chalk.cyan(String(setVal === 'true' || setVal === '1'))}`);
          return {};
        case 'logLevel':
          config.set('logLevel', setVal as 'debug' | 'info' | 'warn' | 'error');
          printSystem(`logLevel = ${chalk.cyan(setVal)}`);
          return {};
        case 'simulator':
          config.set('project', { ...c.project, defaultSimulator: setVal });
          printSystem(`simulator = ${chalk.cyan(setVal)}`);
          return {};
        case 'synthesizer':
          config.set('project', { ...c.project, defaultSynthesizer: setVal });
          printSystem(`synthesizer = ${chalk.cyan(setVal)}`);
          return {};
        case 'hdl':
        case 'hdlStandard':
          if (!HDL_STANDARDS.includes(setVal as any)) {
            printSystem(`Invalid HDL standard. Options: ${HDL_STANDARDS.join(', ')}`);
            return {};
          }
          config.set('project', { ...c.project, hdlStandard: setVal as typeof HDL_STANDARDS[number] });
          printSystem(`hdlStandard = ${chalk.cyan(setVal)}`);
          return {};
        case 'device':
        case 'targetDevice':
          config.set('project', { ...c.project, targetDevice: setVal || undefined });
          printSystem(`targetDevice = ${chalk.cyan(setVal || '(cleared)')}`);
          return {};
        case 'maxRetries':
        case 'sameErrorMaxRetries':
          config.set('debug', { ...c.debug, sameErrorMaxRetries: parseInt(setVal) });
          printSystem(`sameErrorMaxRetries = ${chalk.cyan(setVal)}`);
          return {};
        case 'iterationCap':
        case 'totalIterationCap':
          config.set('debug', { ...c.debug, totalIterationCap: parseInt(setVal) });
          printSystem(`totalIterationCap = ${chalk.cyan(setVal)}`);
          return {};
        default:
          printSystem(`Unknown config key: ${setKey}`);
          return {};
      }
    }

    case 'reset':
      config.reset();
      printSystem(chalk.yellow('Config reset to defaults.'));
      return { recreateBackend: true };

    case 'apikey': {
      if (arg) {
        config.setLLM({ apiKey: arg });
        printSystem(`API key updated for ${chalk.cyan(c.llm.provider)}.`);
        return { recreateBackend: true };
      }
      const mask = (s?: string) => s ? s.slice(0, 4) + '****' + s.slice(-4) : chalk.dim('(not set)');
      // Show primary
      printSystem(`Primary (${chalk.cyan(c.llm.provider)}):  ${mask(c.llm.apiKey)}`);
      // Show fallback
      if (c.fallbackLlm) {
        printSystem(`Fallback (${chalk.cyan(c.fallbackLlm.provider)}): ${mask(c.fallbackLlm.apiKey)}`);
      }
      if (askUser) {
        const newKey = await askUser(`Primary API key for ${c.llm.provider} (Enter to keep):`);
        let recreate = false;
        if (newKey.trim()) {
          config.setLLM({ apiKey: newKey.trim() });
          printSystem('Primary API key updated.');
          recreate = true;
        }
        if (c.fallbackLlm) {
          const fbKey = await askUser(`Fallback API key for ${c.fallbackLlm.provider} (Enter to keep):`);
          if (fbKey.trim()) {
            config.set('fallbackLlm', { ...c.fallbackLlm, apiKey: fbKey.trim() });
            printSystem('Fallback API key updated.');
            recreate = true;
          }
        }
        if (recreate) return { recreateBackend: true };
      }
      return {};
    }

    case 'fallback': {
      if (arg === 'clear' || arg === 'off' || arg === 'none') {
        config.set('fallbackLlm', undefined as any);
        printSystem('Fallback LLM cleared.');
        return { recreateBackend: true };
      }
      if (arg) {
        const [prov, ...modelParts] = arg.split('/');
        const model = modelParts.join('/') || 'gpt-4o';
        config.set('fallbackLlm', {
          provider: prov as import('../config/schema.js').LLMProvider,
          model,
          temperature: c.llm.temperature,
          timeoutMs: c.llm.timeoutMs,
        });
        printSystem(`Fallback set to: ${chalk.cyan(`${prov}/${model}`)}`);
        return { recreateBackend: true };
      }
      // Show current, then interactive select
      if (c.fallbackLlm) {
        printSystem(`Current fallback: ${chalk.cyan(`${c.fallbackLlm.provider}/${c.fallbackLlm.model}`)}`);
      }
      if (!rlRef) {
        printSystem(chalk.dim('Usage: /config fallback <provider/model> or /config fallback clear'));
        return {};
      }
      const { PROVIDER_MODELS } = await import('../llm/factory.js');
      const PROVIDERS = Object.keys(PROVIDER_MODELS) as import('../config/schema.js').LLMProvider[];
      const providerItems = [...PROVIDERS, chalk.dim('[ Clear fallback ]')];
      const currentProvIdx = c.fallbackLlm ? PROVIDERS.indexOf(c.fallbackLlm.provider) : -1;
      const selProvider = await interactiveSelect(rlRef, 'Fallback provider:', providerItems,
        { highlight: Math.max(0, currentProvIdx) });
      if (!selProvider) { printSystem('Cancelled.'); return {}; }
      if (selProvider.includes('Clear fallback')) {
        config.set('fallbackLlm', undefined as any);
        printSystem('Fallback LLM cleared.');
        return { recreateBackend: true };
      }
      const provider = selProvider as import('../config/schema.js').LLMProvider;
      const models = PROVIDER_MODELS[provider] ?? [];
      const modelItems = [...models, '[ Custom model name ]'];
      const currentModelIdx = c.fallbackLlm?.provider === provider
        ? models.indexOf(c.fallbackLlm.model) : -1;
      const selModel = await interactiveSelect(rlRef, `${provider} models:`, modelItems,
        { highlight: Math.max(0, currentModelIdx) });
      if (!selModel) { printSystem('Cancelled.'); return {}; }
      let model = selModel;
      if (selModel === '[ Custom model name ]') {
        if (!askUser) return {};
        const custom = await askUser('Enter model name:');
        if (!custom.trim()) { printSystem('Cancelled.'); return {}; }
        model = custom.trim();
      }
      // Ask for API key (skip for ollama which doesn't need one)
      let apiKey: string | undefined;
      if (provider !== 'ollama' && askUser) {
        const existingKey = c.fallbackLlm?.provider === provider ? c.fallbackLlm.apiKey : undefined;
        const hint = existingKey ? ` [${existingKey.slice(0, 4)}****]` : '';
        const keyInput = await askUser(`API key for ${provider}${hint} (Enter to skip):`);
        apiKey = keyInput.trim() || existingKey;
      }
      // Ask for baseUrl — needed for proxied providers (e.g. Gemini in restricted regions), ollama, etc.
      let baseUrl: string | undefined;
      if (askUser) {
        const existingUrl = c.fallbackLlm?.provider === provider ? c.fallbackLlm.baseUrl : undefined;
        const defaults: Record<string, string> = {
          ollama: 'http://localhost:11434/v1',
        };
        const hint = existingUrl ?? defaults[provider] ?? '';
        const prompt = hint
          ? `Base URL [${hint}] (Enter for default, proxy address if needed):`
          : `Base URL (Enter to skip, or proxy address for ${provider}):`;
        const urlInput = await askUser(prompt);
        baseUrl = urlInput.trim() || hint || undefined;
      }
      config.set('fallbackLlm', {
        provider,
        model,
        apiKey,
        baseUrl,
        temperature: c.llm.temperature,
        timeoutMs: c.llm.timeoutMs,
      });
      printSystem(`Fallback set to: ${chalk.cyan.bold(`${provider}/${model}`)}`);
      return { recreateBackend: true };
    }

    case 'simulator': {
      if (arg) {
        config.set('project', { ...c.project, defaultSimulator: arg });
        printSystem(`Default simulator: ${chalk.cyan(arg)}`);
        return {};
      }
      // Interactive select
      if (rlRef) {
        const sims = ['iverilog', 'verilator', 'vcs', 'xsim', 'modelsim'];
        const selected = await interactiveSelect(rlRef, 'Select simulator:', sims,
          { highlight: Math.max(0, sims.indexOf(c.project.defaultSimulator)) });
        if (!selected) { printSystem('Cancelled.'); return {}; }
        config.set('project', { ...c.project, defaultSimulator: selected });
        printSystem(`Default simulator: ${chalk.cyan(selected)}`);
      } else {
        printSystem(`Current simulator: ${chalk.cyan(c.project.defaultSimulator)}`);
      }
      return {};
    }

    case 'hdl': {
      if (arg) {
        if (!HDL_STANDARDS.includes(arg as any)) {
          printSystem(`Invalid. Options: ${HDL_STANDARDS.join(', ')}`);
          return {};
        }
        config.set('project', { ...c.project, hdlStandard: arg as typeof HDL_STANDARDS[number] });
        printSystem(`HDL standard: ${chalk.cyan(arg)}`);
        return {};
      }
      if (rlRef) {
        const selected = await interactiveSelect(rlRef, 'Select HDL standard:', [...HDL_STANDARDS],
          { highlight: Math.max(0, HDL_STANDARDS.indexOf(c.project.hdlStandard)) });
        if (!selected) { printSystem('Cancelled.'); return {}; }
        config.set('project', { ...c.project, hdlStandard: selected as typeof HDL_STANDARDS[number] });
        printSystem(`HDL standard: ${chalk.cyan(selected)}`);
      } else {
        printSystem(`Current HDL standard: ${chalk.cyan(c.project.hdlStandard)}`);
      }
      return {};
    }

    case 'device': {
      if (arg) {
        const val = arg === 'clear' || arg === 'none' ? undefined : arg;
        config.set('project', { ...c.project, targetDevice: val });
        printSystem(`Target device: ${chalk.cyan(val ?? '(cleared)')}`);
        return {};
      }
      printSystem(`Target device: ${chalk.cyan(c.project.targetDevice ?? chalk.dim('(not set)'))}`);
      if (askUser) {
        const val = await askUser('Enter target device (empty to clear):');
        config.set('project', { ...c.project, targetDevice: val.trim() || undefined });
        printSystem(`Target device: ${chalk.cyan(val.trim() || '(cleared)')}`);
      }
      return {};
    }

    case 'timeout': {
      if (arg) {
        const ms = parseInt(arg);
        if (isNaN(ms) || ms <= 0) { printSystem('Invalid timeout value.'); return {}; }
        config.setLLM({ timeoutMs: ms });
        printSystem(`Timeout: ${chalk.cyan(ms + 'ms')}`);
        return {};
      }
      printSystem(`Current timeout: ${chalk.cyan(c.llm.timeoutMs + 'ms')}`);
      return {};
    }

    case 'debug': {
      if (arg) {
        // /config debug <key> <value>
        const [dKey, dVal] = arg.split(/\s+/);
        if (!dKey || !dVal) {
          printSystem('Usage: /config debug <key> <value>');
          return {};
        }
        const num = parseInt(dVal);
        if (isNaN(num)) { printSystem('Value must be a number.'); return {}; }
        switch (dKey) {
          case 'maxRetries':
          case 'sameErrorMaxRetries':
            config.set('debug', { ...c.debug, sameErrorMaxRetries: num });
            break;
          case 'iterationCap':
          case 'totalIterationCap':
            config.set('debug', { ...c.debug, totalIterationCap: num });
            break;
          case 'vcdTimeMarginNs':
            config.set('debug', { ...c.debug, vcdTimeMarginNs: num });
            break;
          case 'maxSignalsPerQuery':
            config.set('debug', { ...c.debug, maxSignalsPerQuery: num });
            break;
          default:
            printSystem(`Unknown debug key: ${dKey}`);
            return {};
        }
        printSystem(`debug.${dKey} = ${chalk.cyan(String(num))}`);
        return {};
      }
      // Show debug config
      const dkv = (key: string, val: string | number) =>
        `  ${chalk.cyan(key.padEnd(24))}${val}`;
      console.log([
        '',
        chalk.bold.hex('#FF22DD')('  Debug Config'),
        dkv('sameErrorMaxRetries', c.debug.sameErrorMaxRetries),
        dkv('totalIterationCap', c.debug.totalIterationCap),
        dkv('vcdTimeMarginNs', c.debug.vcdTimeMarginNs),
        dkv('maxSignalsPerQuery', c.debug.maxSignalsPerQuery),
        '',
        chalk.dim('  Pass patterns: ') + c.debug.passPatterns.join(', '),
        chalk.dim('  Fail patterns: ') + c.debug.failPatterns.join(', '),
        '',
      ].join('\n'));
      return {};
    }

    case 'path':
      printSystem(`Config file: ${chalk.cyan(config.configPath)}`);
      return {};

    default:
      printSystem('Usage: /config [show|set|reset|apikey|fallback|simulator|hdl|device|timeout|debug|path]');
      return {};
  }
}

async function handleProjectCommand(parts: string[], rlRef?: readline.Interface): Promise<CommandResult> {
  const action = parts[1];
  let arg = parts.slice(2).join(' ');

  const { ProjectManager } = await import('../project/manager.js');
  const pm = new ProjectManager();

  switch (action) {
    case 'list': {
      const projects = await pm.listProjects();
      if (projects.length === 0) {
        printSystem('No projects found. Use /project init <name> or /project open <path>');
      } else {
        const cwd = process.cwd() + path.sep;
        const local = projects.filter(p => p.rootPath === process.cwd() || p.rootPath.startsWith(cwd));
        const other = projects.filter(p => p.rootPath !== process.cwd() && !p.rootPath.startsWith(cwd));
        console.log();
        if (local.length > 0) {
          console.log(chalk.bold.hex('#00BBFF')('  Local'));
          for (const p of local) {
            console.log(`  ${chalk.cyan('\u25CF')} ${chalk.bold(p.name.padEnd(20))} ${chalk.dim(p.rootPath)}`);
          }
        }
        if (other.length > 0) {
          if (local.length > 0) console.log();
          console.log(chalk.bold.dim('  Other'));
          for (const p of other) {
            console.log(`  ${chalk.dim('\u25CB')} ${p.name.padEnd(20)} ${chalk.dim(p.rootPath)}`);
          }
        }
        console.log();
      }
      return {};
    }
    case 'open': {
      // If no arg provided, show interactive project picker
      if (!arg && rlRef) {
        const projects = await pm.listProjects();
        if (projects.length === 0) {
          printSystem('No projects found. Use /project init <name> to create one.');
          return {};
        }
        const cwd = process.cwd() + path.sep;
        const sorted = [...projects].sort((a, b) => {
          const aLocal = a.rootPath === process.cwd() || a.rootPath.startsWith(cwd);
          const bLocal = b.rootPath === process.cwd() || b.rootPath.startsWith(cwd);
          return aLocal === bLocal ? 0 : aLocal ? -1 : 1;
        });
        const names = sorted.map(p => {
          const isLocal = p.rootPath === process.cwd() || p.rootPath.startsWith(cwd);
          return isLocal ? p.name : `${p.name}  ${chalk.dim(p.rootPath)}`;
        });
        const selected = await interactiveSelect(rlRef, 'Select project:', names);
        if (!selected) { printSystem('Cancelled.'); return {}; }
        // Strip the dim path suffix if present to find the project
        const selectedName = selected.split('  ')[0]!.trim();
        const proj = sorted.find(p => p.name === selectedName);
        if (proj) arg = proj.rootPath;
      }
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
      // Pause spinner so the message is not overwritten
      const wasSpinning = spinner.isRunning;
      spinner.stop();
      console.log(); // ensure new line
      printSystem(chalk.yellow.bold(`⚡ Provider ${from} failed (${error.slice(0, 80)})`));
      printSystem(chalk.yellow(`   Switching to fallback: ${chalk.bold(to)}`));
      if (wasSpinning) spinner.start('Thinking...');
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
  void suggestions.reloadProjects(); // Pre-cache project names

  // Monkey-patch _ttyWrite to intercept keys BEFORE readline processes them.
  // This lets us swallow Tab/Up/Down when the dropdown is open, avoiding
  // conflicts with readline's built-in completer and history navigation.
  const origTtyWrite = (rl as any)._ttyWrite;
  // Detect Esc on raw stdin while readline is paused (busy).
  // Esc = single 0x1b byte; arrow keys are 0x1b + '[' + letter (3+ bytes).
  if (process.stdin.isTTY) {
    process.stdin.on('data', (data: Buffer) => {
      if (busy && data.length === 1 && data[0] === 0x1b) {
        cancelCurrentOperation('Esc');
      }
    });
  }

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

    // Enter → if dropdown open, accept selection and execute; otherwise normal
    if (key?.name === 'return') {
      if (dropdownOpen) {
        const accepted = suggestions.accept();
        if (accepted) {
          (rl as any).line = accepted.trimEnd();
          (rl as any).cursor = accepted.trimEnd().length;
          readline.clearLine(process.stdout, 0);
          readline.cursorTo(process.stdout, 0);
          process.stdout.write((rl as any)._prompt + accepted.trimEnd());
        }
      }
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
  // AbortController for cancelling in-flight LLM requests
  let currentAbort: AbortController | null = null;
  // Track whether cancel already handled prompt restoration for the current operation
  let sigintHandled = false;

  // Shared cancel logic — called by both Esc and Ctrl+C
  const cancelCurrentOperation = (source: string) => {
    if (!busy) return;
    spinner.stop();
    if (currentAbort) {
      currentAbort.abort();
      currentAbort = null;
    }
    console.log(chalk.yellow(`\n  \u26A0 Operation cancelled (${source})`));
    busy = false;
    sigintHandled = true;
    if (!rlClosed) {
      rl.resume();
      showPrompt();
    }
  };

  // Ctrl+C: if busy → cancel operation, if idle → exit
  const handleSigint = () => {
    if (busy) {
      cancelCurrentOperation('Ctrl+C');
    } else {
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
      const result = await handleCommand(input, configManager, currentProjectPath, askUser, rl);
      if (result.clearHistory) history.length = 0;
      if (result.recreateBackend) {
        try {
          backend = await createBackendWithFallback(
            configManager.llm,
            configManager.config.fallbackLlm,
            (from, to, error) => {
              const wasSpinning = spinner.isRunning;
              spinner.stop();
              console.log();
              printSystem(chalk.yellow.bold(`⚡ Provider ${from} failed (${error.slice(0, 80)})`));
              printSystem(chalk.yellow(`   Switching to fallback: ${chalk.bold(to)}`));
              if (wasSpinning) spinner.start('Thinking...');
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
        // Refresh cached project list for suggestions
        void suggestions.reloadProjects();
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
    // Keep stdin flowing so our raw 'data' listener can detect Esc
    process.stdin.resume();
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
      debugConfig: configManager.config.debug,
      askUser,
      executeAction: (action: Action) => executeAction(action, currentProjectPath, configManager.config.project.hdlStandard, context.logLLMTrace, currentAbort?.signal, context.filelistPath),
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
      // Only restore prompt if cancel handler hasn't already done it
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
