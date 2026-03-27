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

// --------------------------------------------------------------------------
// Display helpers
// --------------------------------------------------------------------------

const COLS = () => Math.min(process.stdout.columns || 80, 80);
const DIVIDER = () => chalk.dim('\u2500'.repeat(COLS()));

function printHeader(): void {
  const W = 44; // inner width
  const top    = '\u256D' + '\u2500'.repeat(W) + '\u256E';
  const line1  = '\u2502' + '  RTL-Claw v0.1.0'.padEnd(W) + '\u2502';
  const line2  = '\u2502' + '  AI-Powered RTL Development Assistant'.padEnd(W) + '\u2502';
  const bottom = '\u2570' + '\u2500'.repeat(W) + '\u256F';
  console.log();
  console.log(chalk.cyan.bold('  ' + top));
  console.log(chalk.cyan.bold('  ' + line1));
  console.log(chalk.dim('  ' + line2));
  console.log(chalk.cyan.bold('  ' + bottom));
  console.log();
}

function printSystem(text: string): void {
  console.log(chalk.dim('  ' + text));
}

function printUser(text: string): void {
  console.log(DIVIDER());
  console.log(chalk.green.bold('  You: ') + text);
  console.log();
}

function printError(text: string): void {
  console.log(chalk.red('  Error: ') + text);
  console.log();
}

function printHelp(): void {
  console.log([
    '',
    chalk.bold('  Commands:'),
    chalk.cyan('    /help              ') + chalk.dim('\u2014 Show this help'),
    chalk.cyan('    /project list      ') + chalk.dim('\u2014 List known projects'),
    chalk.cyan('    /project open <p>  ') + chalk.dim('\u2014 Open project (enter Project Mode)'),
    chalk.cyan('    /project init <n>  ') + chalk.dim('\u2014 Create new project'),
    chalk.cyan('    /project close     ') + chalk.dim('\u2014 Close project (return to Claw Mode)'),
    chalk.cyan('    /model <name>      ') + chalk.dim('\u2014 Switch LLM model'),
    chalk.cyan('    /provider <name>   ') + chalk.dim('\u2014 Switch LLM provider'),
    chalk.cyan('    /auto              ') + chalk.dim('\u2014 Toggle auto mode'),
    chalk.cyan('    /config            ') + chalk.dim('\u2014 Show current config'),
    chalk.cyan('    /tools             ') + chalk.dim('\u2014 Show EDA tool status'),
    chalk.cyan('    /continue          ') + chalk.dim('\u2014 Resume paused workflow'),
    chalk.cyan('    /log               ') + chalk.dim('\u2014 Show recent log entries'),
    chalk.cyan('    /clear             ') + chalk.dim('\u2014 Clear conversation history'),
    chalk.cyan('    /quit              ') + chalk.dim('\u2014 Exit'),
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
      const { execSync } = await import('node:child_process');
      const output = execSync(payload.command, { cwd: baseDir, encoding: 'utf-8', timeout: 60_000 });
      return output;
    }

    case 'lintCode': {
      const payload = action.payload as { file: string };
      const filePath = path.resolve(baseDir, payload.file);
      const iverilogGen = hdlStandardToIverilogGen(hdlStandard);
      if (!existsSync(filePath)) return `  Lint: file not found ${payload.file}`;

      const { execSync } = await import('node:child_process');
      const envPrefix = buildSetenvPrefix(baseDir);
      const lintStartMs = Date.now();
      let lintCmd = '';
      let lintResult = '';
      try {
        execSync(`which verilator`, { encoding: 'utf-8' });
        lintCmd = `${envPrefix}verilator --lint-only -Wall ${filePath} 2>&1 || true`;
        lintResult = execSync(lintCmd, {
          cwd: baseDir, encoding: 'utf-8', timeout: 30_000, shell: '/bin/bash',
        });
        lintResult = lintResult || '  Lint: passed';
      } catch {
        try {
          execSync(`which iverilog`, { encoding: 'utf-8' });
          lintCmd = `${envPrefix}iverilog ${iverilogGen} -tnull ${filePath} 2>&1 || true`;
          lintResult = execSync(lintCmd, {
            cwd: baseDir, encoding: 'utf-8', timeout: 30_000, shell: '/bin/bash',
          });
          lintResult = lintResult || '  Lint: passed';
        } catch {
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
      const payload = action.payload as { module?: string; testType: 'ut' | 'st' };
      const { execSync } = await import('node:child_process');
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
        execSync(`which iverilog`, { encoding: 'utf-8' });
      } catch {
        throw new Error('Simulation tool (iverilog) not available');
      }

      if (usesTcInclude && tcFiles.length > 0) {
        // ── TB/TC separated via `include ──
        const allResults: string[] = [];
        let allPassed = true;

        for (const tcFile of tcFiles) {
          const tcFilePath = path.join(tcPath, tcFile);
          const tcRelPath = path.relative(tbPath, tcFilePath);
          const tempTBContent = tbContent.replace(/`include\s+"PLACEHOLDER_TC"/g, `\`include "${tcRelPath}"`);
          const tempTBPath = path.join(simDir, `tb_temp_${tcFile}`);
          await fs.writeFile(tempTBPath, tempTBContent, 'utf-8');

          const vvpPath = path.join(simDir, `sim_${tcFile.replace(/\.\w+$/, '')}.vvp`);
          const compileCmd = `${envPrefix}iverilog ${iverilogGen} -I ${tcPath} -o ${vvpPath} ${tempTBPath}${rtlSources} 2>&1`;
          const runCmd = `${envPrefix}vvp ${vvpPath} 2>&1`;
          const tcStartMs = Date.now();
          let tcOutput = '';
          let tcPassed = false;

          try {
            execSync(compileCmd, { cwd: baseDir, encoding: 'utf-8', timeout: 60_000, shell: '/bin/bash' });
            const simOutput = execSync(runCmd, { cwd: simDir, encoding: 'utf-8', timeout: 120_000, shell: '/bin/bash' });
            tcPassed = simOutput.includes('TEST PASSED') || simOutput.includes('PASSED');
            tcOutput = simOutput;
            if (!tcPassed) allPassed = false;
            allResults.push(`=== ${tcFile} ===\n${simOutput}`);
          } catch (err) {
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
          execSync(compileCmd, { cwd: baseDir, encoding: 'utf-8', timeout: 60_000, shell: '/bin/bash' });
          simOutput = execSync(runCmd,
            { cwd: simDir, encoding: 'utf-8', timeout: 120_000, shell: '/bin/bash' },
          );
          simPassed = simOutput.includes('TEST PASSED') || simOutput.includes('PASSED');
        } catch (err) {
          if (err instanceof Error && 'stdout' in err) {
            const execErr = err as { stdout?: string; stderr?: string };
            // stdout may be empty string when stderr has the errors (even with 2>&1)
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
      const { execSync } = await import('node:child_process');
      const envPrefix = buildSetenvPrefix(baseDir);
      const synPayload = action.payload as { topModule?: string };
      try {
        execSync(`which yosys`, { encoding: 'utf-8' });
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

        const result = execSync(`${envPrefix}yosys -s ${ysPath} 2>&1 || true`, {
          cwd: synDir, encoding: 'utf-8', timeout: 300_000, shell: '/bin/bash',
        });
        return result;
      } catch {
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
  const { execSync } = await import('node:child_process');
  const tools = ['iverilog', 'verilator', 'yosys', 'vcs', 'vivado'];
  const available: string[] = [];
  const missing: string[] = [];

  for (const tool of tools) {
    try {
      execSync(`which ${tool}`, { encoding: 'utf-8' });
      available.push(tool);
    } catch {
      missing.push(tool);
    }
  }

  return { available, missing };
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
    case '/model':
      if (parts[1]) {
        config.setLLM({ model: parts[1] });
        printSystem(`Model switched to: ${parts[1]}`);
        return { recreateBackend: true };
      }
      printSystem(`Current model: ${config.llm.provider}/${config.llm.model}`);
      return {};
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
        const { available, missing } = await checkEdaTools();
        if (available.length === 0) {
          printSystem(chalk.yellow('Warning: No EDA tools found. Install iverilog or verilator for lint/simulation.'));
          printSystem(chalk.dim('  Ubuntu/Debian: sudo apt install iverilog verilator'));
          printSystem(chalk.dim('  macOS: brew install icarus-verilog verilator'));
        } else if (missing.length > 0) {
          printSystem(`EDA tools: ${chalk.green(available.join(', '))} available, ${chalk.dim(missing.join(', '))} not found`);
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
      const { available, missing } = await checkEdaTools();
      if (available.length === 0) {
        printSystem(chalk.yellow('Warning: No EDA tools found.'));
        printSystem(chalk.dim('  Install iverilog: sudo apt install iverilog'));
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
          console.log(chalk.dim('  ' + chunk.content));
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
        console.log(chalk.dim('  ' + chunk.content));
        break;

      case 'code':
        spinner.stop();
        if (isStreaming) {
          console.log('\n');
          isStreaming = false;
        }
        console.log(chalk.magenta('  [Code Block]'));
        for (const line of chunk.content.split('\n')) {
          console.log('    ' + line);
        }
        console.log();
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
// Startup project prompt
// --------------------------------------------------------------------------

async function startupProjectPrompt(rl: readline.Interface): Promise<{ path: string; name: string } | null> {
  const { ProjectManager } = await import('../project/manager.js');
  const pm = new ProjectManager();
  const projects = await pm.listProjects();

  if (projects.length === 0) return null;

  console.log(chalk.bold('\n  Recent projects:'));
  projects.forEach((p, i) => {
    console.log(`  ${chalk.cyan(`${i + 1})`)} ${p.name.padEnd(20)} ${chalk.dim(p.rootPath)}`);
  });
  console.log(`  ${chalk.cyan(`${projects.length + 1})`)} ${chalk.dim('Start in Claw Mode (no project)')}`);
  console.log();

  return new Promise((resolve) => {
    try {
      rl.question(chalk.green.bold('  Select: '), (answer) => {
        const idx = parseInt(answer.trim()) - 1;
        if (idx >= 0 && idx < projects.length) {
          resolve({ path: projects[idx]!.rootPath, name: projects[idx]!.name });
        } else {
          resolve(null);
        }
      });
    } catch {
      resolve(null);
    }
    rl.once('close', () => resolve(null));
  });
}

// --------------------------------------------------------------------------
// Main loop
// --------------------------------------------------------------------------

export async function startApp(configManager: ConfigManager, projectPath?: string): Promise<void> {
  printHeader();

  const providerInfo = `${configManager.llm.provider}/${configManager.llm.model}`;
  const fallbackInfo = configManager.config.fallbackLlm
    ? ` (fallback: ${configManager.config.fallbackLlm.provider}/${configManager.config.fallbackLlm.model})`
    : '';
  printSystem(`Using ${chalk.cyan(providerInfo)}${fallbackInfo}. Type ${chalk.cyan('/help')} for commands.\n`);

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
    prompt: chalk.green.bold('  > '),
    terminal: true,
  });

  let rlClosed = false;
  // AbortController for cancelling in-flight LLM requests on Ctrl+C
  let currentAbort: AbortController | null = null;

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
      console.log(chalk.yellow('\n  ⚠ Operation cancelled (Ctrl+C)'));
      busy = false;
      if (!rlClosed) {
        rl.resume();
        rl.prompt();
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

  // Startup: project selection
  if (!currentProjectPath) {
    const selected = await startupProjectPrompt(rl);
    if (selected) {
      currentProjectPath = selected.path;
      currentProjectName = selected.name;
    }
  }

  if (currentProjectPath) {
    try {
      const { ProjectManager } = await import('../project/manager.js');
      const pm = new ProjectManager();
      const info = await pm.openProject(currentProjectPath);
      currentProjectName = info.name;
      projectMode = true;
      printSystem(`Project: ${chalk.bold(info.name)} (${info.rootPath})`);
      printSystem(`Mode: ${chalk.cyan('Project Mode')}`);
      printSystem(chalk.dim('Tip: Say "design/create/implement ..." to start a design workflow, other messages are treated as chat.\n'));
    } catch (e) {
      printSystem(`${chalk.yellow('Warning')}: ${e instanceof Error ? e.message : e}\n`);
    }
  } else {
    printSystem(`Mode: ${chalk.dim('Claw Mode')} - use /project to enter Project Mode\n`);
  }

  // Chat loop
  let busy = false;

  rl.on('line', async (line: string) => {
    const input = line.trim();
    if (!input) { rl.prompt(); return; }
    if (busy) return;

    // Commands
    if (input.startsWith('/')) {
      const result = await handleCommand(input, configManager, currentProjectPath);
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
      rl.setPrompt(projectMode
        ? chalk.green.bold(`  [${currentProjectName}] > `)
        : chalk.green.bold('  > '),
      );
      rl.prompt();
      return;
    }

    // Chat message
    busy = true;
    currentAbort = new AbortController();
    rl.pause();
    printUser(input);
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
      executeAction: (action: Action) => executeAction(action, currentProjectPath, configManager.config.project.hdlStandard, context.logLLMTrace),
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
      if (!rlClosed) {
        rl.resume();
        rl.prompt();
      }
    }
  });

  // Set initial prompt
  if (!rlClosed) {
    rl.setPrompt(projectMode
      ? chalk.green.bold(`  [${currentProjectName}] > `)
      : chalk.green.bold('  > '),
    );
    rl.prompt();
  }
  await new Promise<void>((resolve) => {
    if (rlClosed) { resolve(); return; }
    rl.on('close', resolve);
  });
}
