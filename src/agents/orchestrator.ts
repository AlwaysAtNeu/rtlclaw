/**
 * Orchestrator v2: lightweight dispatcher for RTL-Claw workflow.
 *
 * Two modes:
 *  - Claw Mode (default): general AI assistant, no project workflow
 *  - Project Mode (via /project): full RTL design workflow with intent detection
 *
 * The orchestrator delegates all heavy lifting to stage modules in src/stages/.
 * Each stage receives a minimal StageContext — no full chat history.
 */

import {
  type Action,
  type DesignIndex,
  type PortDef,
  type TaskPlan,
  type TaskStep,
  type StageId,
  type WorkflowState,
  type ModuleStatus,
  type PlanScope,
  type ArchitectPhase1Output,
  type ArchitectPhase2Output,
  type DebugDiagnosis,
  type STTriageDiagnosis,
  type InterfaceContract,
} from './types.js';
import { getClawModePrompt } from './prompts.js';
import type { LLMBackend } from '../llm/base.js';
import type { Message, ToolSchema } from '../llm/types.js';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { execAsync, assertSafePath } from '../utils/exec.js';

// Stage imports
import type { StageContext, OutputChunk, LLMTraceEntry } from '../stages/types.js';
import { quickQuestionCheck, quickDesignRequestCheck } from '../stages/intent.js';
import {
  runArchitectPhase1,
  convertToDesignIndex,
  formatArchitectureSummary,
  parsePhase1Response,
} from '../stages/architect-p1.js';
import { runArchitectPhase2 } from '../stages/architect-p2.js';
import { writeModule, fixLintErrors, debugFix, selectVCDSignals } from '../stages/rtl-writer.js';
import { generateUTTestbench, reviewTB, addVCDToTB, fixCompileErrors, auditSpecVsChecker } from '../stages/ve-ut.js';
import type { SpecCheckerAuditResult } from '../stages/ve-ut.js';
import { generateSTTestbench } from '../stages/ve-st.js';
import { runBEStage } from '../stages/be.js';
import { generateSummary } from '../stages/summary.js';
import { validatePhase1Structure } from '../stages/structural-validation.js';
import { generateDesignParams } from '../stages/design-params-gen.js';
import { generateTopModule } from '../stages/top-gen.js';
import { runInfraDebug } from '../stages/infra-debug.js';
import { VCDParser } from '../parser/vcd-parser.js';
import { parseCheckerOutput } from '../parser/checker-parser.js';
import {
  buildSTTriageMessages,
  buildArchitectP1RevisionMessages,
  getRelevantContracts,
} from './context-builder.js';

// Re-export for consumers
export type { OutputChunk, LLMTraceEntry };
export type OutputChunkType = OutputChunk['type'];

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface ChatMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

export interface OrchestratorContext {
  projectPath?: string;
  projectName?: string;
  designIndex?: DesignIndex;
  fileManifest?: string;
  /** Chat history — only used for Claw Mode streaming */
  history: ChatMessage[];
  autoMode: boolean;
  projectMode: boolean;
  hdlStandard?: string;
  targetDevice?: string;
  executeAction?: (action: Action) => Promise<string>;
  askUser?: (question: string) => Promise<string>;
  saveState?: (state: WorkflowState) => Promise<void>;
  loadState?: () => Promise<WorkflowState | null>;
  logLLMTrace?: (entry: LLMTraceEntry) => Promise<void>;
  readFile?: (relativePath: string) => Promise<string>;
  /** Filelist path relative to project root */
  filelistPath?: string;
  /** Abort signal for cancelling in-flight operations (Ctrl+C) */
  signal?: AbortSignal;
  /** Debug loop configuration (overrides hardcoded defaults) */
  debugConfig?: { sameErrorMaxRetries?: number; totalIterationCap?: number };
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_FILELIST = 'hw/src/filelist/design.f';
const SAME_ERROR_MAX_RETRIES = 8;
const TOTAL_ITERATION_CAP = 32;
const MODULE_LINE_LIMIT = 1024;
const HISTORY_MAX_MESSAGES = 60;
const HISTORY_TRIM_TO = 20;
const VCD_FALLBACK_THRESHOLD = 4;
const LINT_ATTEMPT_CAP = 4;
const VE_COMPILE_ATTEMPT_CAP = 4;
const COMPILE_SAME_ERROR_CAP = 2;   // Same compile error → infrastructure
const COMPILE_TOTAL_CAP = 5;        // Total compile fix rounds → infrastructure
const INFRA_DEBUG_MAX_ROUNDS = 8;
const TB_SUSPECT_CAP = 3;           // Max tb_suspect per module before forcing RTL focus

// v2 stage descriptions (no PM)
const STAGE_DESCRIPTIONS: Record<StageId, string> = {
  architect_p1: 'Designing global architecture (Phase 1)',
  architect_p2: 'Detailed module design (Phase 2)',
  rtl: 'Generating RTL code',
  lint: 'Linting code',
  ve_ut: 'Running unit verification',
  ve_st: 'Running system verification',
  be: 'Running synthesis',
  summary: 'Generating project summary',
};

// ---------------------------------------------------------------------------
// Plan builder
// ---------------------------------------------------------------------------

function buildTaskPlan(goal: string, scope: PlanScope): TaskPlan {
  const stages: StageId[] =
    scope === 'with_be'
      ? ['architect_p1', 'rtl', 've_st', 'be', 'summary']
      : ['architect_p1', 'rtl', 've_st', 'summary'];

  const steps: TaskStep[] = stages.map((stage, idx) => ({
    id: idx + 1,
    stage,
    description: STAGE_DESCRIPTIONS[stage],
    status: 'pending' as const,
  }));

  return { goal, scope, steps, currentStep: 0 };
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

export class Orchestrator {
  private backend: LLMBackend;
  private workflowState: WorkflowState | null = null;
  private designIndex: DesignIndex | null = null;
  private phase1Output: ArchitectPhase1Output | null = null;
  /** Per-module Phase 2 outputs, keyed by module name */
  private phase2Outputs = new Map<string, ArchitectPhase2Output>();

  constructor(backend: LLMBackend) {
    this.backend = backend;
  }

  /** Log a workflow phase transition event (near-zero cost, file append only). */
  private async logWorkflow(
    context: OrchestratorContext,
    phase: string,
    status: 'start' | 'done' | 'skip' | 'fail',
    detail?: string,
  ): Promise<void> {
    if (!context.logLLMTrace) return;
    await context.logLLMTrace({
      timestamp: new Date().toISOString(),
      role: 'Orchestrator',
      promptTokens: 0,
      completionTokens: 0,
      durationMs: 0,
      event: 'workflow',
      taskContext: phase,
      summary: `${status}${detail ? ' ' + detail : ''}`,
    });
  }

  // -----------------------------------------------------------------------
  // Main entry point
  // -----------------------------------------------------------------------

  async *handleMessage(
    userMessage: string,
    context: OrchestratorContext,
  ): AsyncIterable<OutputChunk> {
    // Check for interrupted workflow
    if (context.loadState && !this.workflowState) {
      const saved = await context.loadState();
      if (saved && saved.plan.steps.some(s => s.status === 'running' || s.status === 'pending')) {
        yield { type: 'status', content: `Previous session interrupted at: ${this.describeState(saved)}` };
        if (context.autoMode) {
          yield { type: 'status', content: 'Auto-mode: resuming from checkpoint.' };
          this.workflowState = saved;
          if (saved.phase1Output) {
            this.phase1Output = saved.phase1Output;
            this.designIndex = convertToDesignIndex(saved.phase1Output);
          }
          yield* this.executeWorkflow(context);
          return;
        }
        if (context.askUser) {
          const answer = await context.askUser('Continue from checkpoint? (y/n)');
          if (/^y/i.test(answer.trim())) {
            this.workflowState = saved;
            if (saved.phase1Output) {
              this.phase1Output = saved.phase1Output;
              this.designIndex = convertToDesignIndex(saved.phase1Output);
            }
            yield* this.executeWorkflow(context);
            return;
          }
        }
      }
    }

    if (context.designIndex) {
      this.designIndex = context.designIndex;
    }

    if (context.projectMode) {
      yield* this.handleProjectMode(userMessage, context);
    } else {
      // Auto-route: if user asks for a hardware design task in ClawMode, upgrade to ProjectMode
      // Only trigger when both a design verb AND a hardware concept are present
      const hasHwConcept = /\b(module|rtl|verilog|vhdl|systemverilog|fpga|asic|testbench|circuit|电路|模块|测试|仿真)\b/i.test(userMessage);
      if (context.projectPath && hasHwConcept && quickDesignRequestCheck(userMessage)) {
        yield { type: 'status', content: 'Design request detected — switching to Project Mode.' };
        context.projectMode = true;
        yield* this.handleProjectMode(userMessage, context);
      } else {
        yield* this.handleClawMode(userMessage, context);
      }
    }
  }

  // -----------------------------------------------------------------------
  // Claw Mode: general AI assistant (streaming)
  // -----------------------------------------------------------------------

  /** Tool schemas for ClawMode — lets LLM execute shell commands, read/write/delete files. */
  private static readonly CLAW_TOOLS: ToolSchema[] = [
    {
      name: 'run_command',
      description: 'Run a shell command in the project directory and return its output.',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'Shell command to execute (bash)' },
        },
        required: ['command'],
      },
    },
    {
      name: 'read_file',
      description: 'Read a file from the project directory (relative path).',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Relative file path' },
        },
        required: ['path'],
      },
    },
    {
      name: 'write_file',
      description: 'Write content to a file in the project directory (creates dirs if needed).',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Relative file path' },
          content: { type: 'string', description: 'File content' },
        },
        required: ['path', 'content'],
      },
    },
    {
      name: 'delete_files',
      description: 'Delete files or directories. Supports glob patterns.',
      parameters: {
        type: 'object',
        properties: {
          paths: {
            type: 'array',
            description: 'List of relative paths or glob patterns to delete',
            items: { type: 'string' },
          },
        },
        required: ['paths'],
      },
    },
    {
      name: 'list_directory',
      description: 'List files and directories at the given path.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Relative directory path (default: ".")' },
        },
      },
    },
  ];

  /** Execute a ClawMode tool call and return the result string. */
  private async executeClawTool(
    toolName: string,
    args: Record<string, unknown>,
    context: OrchestratorContext,
  ): Promise<string> {
    const projectPath = context.projectPath;
    const baseDir = projectPath ?? process.cwd();

    try {
      switch (toolName) {
        case 'run_command': {
          const cmd = args.command as string;
          const output = await execAsync(cmd, {
            cwd: baseDir,
            timeout: 120_000,
            signal: context.signal,
          });
          return output || '(no output)';
        }
        case 'read_file': {
          const filePath = assertSafePath(baseDir, args.path as string);
          return await fs.readFile(filePath, 'utf-8');
        }
        case 'write_file': {
          const filePath = assertSafePath(baseDir, args.path as string);
          await fs.mkdir(path.dirname(filePath), { recursive: true });
          await fs.writeFile(filePath, args.content as string, 'utf-8');
          return `Wrote ${args.path}`;
        }
        case 'delete_files': {
          const paths = args.paths as string[];
          const results: string[] = [];
          for (const p of paths) {
            const absPath = assertSafePath(baseDir, p);
            try {
              await fs.rm(absPath, { recursive: true, force: true });
              results.push(`Deleted ${p}`);
            } catch (err) {
              results.push(`Failed to delete ${p}: ${err instanceof Error ? err.message : String(err)}`);
            }
          }
          return results.join('\n');
        }
        case 'list_directory': {
          const dirPath = assertSafePath(baseDir, (args.path as string) ?? '.');
          const entries = await fs.readdir(dirPath, { withFileTypes: true });
          return entries.map(e => `${e.isDirectory() ? '[dir] ' : '      '}${e.name}`).join('\n');
        }
        default:
          return `Unknown tool: ${toolName}`;
      }
    } catch (err) {
      // Abort errors propagate up to cancel the tool loop
      if (err instanceof Error && (err.name === 'AbortError' || err.message.includes('aborted'))) {
        throw err;
      }
      // Return error as result so LLM can see what went wrong
      if (err instanceof Error && 'stdout' in err) {
        const execErr = err as { stdout?: string; stderr?: string };
        return `Command failed:\n${execErr.stdout || execErr.stderr || err.message}`;
      }
      return `Error: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  /**
   * Extract executable shell commands from LLM text response.
   * Fallback for providers that don't support function calling.
   * Matches fenced code blocks with bash/shell/sh language tag.
   */
  private extractCommandsFromText(text: string): string[] {
    const commands: string[] = [];
    // Match ```bash ... ``` or ```shell ... ``` or ```sh ... ```
    const blockRegex = /```(?:bash|shell|sh)\s*\n([\s\S]*?)```/gi;
    let match;
    while ((match = blockRegex.exec(text)) !== null) {
      const block = match[1].trim();
      if (block) {
        // Split by newlines, skip comments and empty lines
        for (const line of block.split('\n')) {
          const trimmed = line.trim();
          if (trimmed && !trimmed.startsWith('#')) {
            commands.push(trimmed);
          }
        }
      }
    }
    // Also match inline `command` patterns when text says "运行/执行/run"
    if (commands.length === 0) {
      const inlineRegex = /(?:运行|执行|run|use|try)[^`]*`([^`]+)`/gi;
      while ((match = inlineRegex.exec(text)) !== null) {
        const cmd = match[1].trim();
        // Only match shell-like commands, not code snippets
        if (cmd && /^[a-z/.]/.test(cmd) && !cmd.includes(';') && cmd.length < 200) {
          commands.push(cmd);
        }
      }
    }
    return commands;
  }

  private async *handleClawMode(
    userMessage: string,
    context: OrchestratorContext,
  ): AsyncGenerator<OutputChunk> {
    context.history.push({ role: 'user', content: userMessage });
    this.compressHistory(context);

    const promptCtx = {
      projectName: context.projectName,
      projectPath: context.projectPath,
      designIndex: this.designIndex ?? context.designIndex,
    };

    const messages: Message[] = [
      { role: 'system', content: getClawModePrompt(promptCtx) },
      ...context.history.map(m => ({ role: m.role as Message['role'], content: m.content })),
    ];

    const MAX_TOOL_ROUNDS = 10;
    let fullContent = '';
    let toolsSupported = true; // Track if provider supports function calling

    try {
      for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
        let response;
        if (toolsSupported) {
          try {
            response = await this.backend.complete(messages, {
              tools: Orchestrator.CLAW_TOOLS,
              temperature: 0.3,
              signal: context.signal,
            });
          } catch (toolErr) {
            // Only fall back to text mode if the error clearly indicates
            // the provider does NOT support function/tool calling at all.
            // Don't match generic "400" — providers like GLM support tools
            // but may return 400 for other reasons (content filter, etc.).
            const msg = toolErr instanceof Error ? toolErr.message : String(toolErr);
            const isToolUnsupported = /tools?\s*(is\s+)?not\s+support|unsupported.*tool|unknown.*field.*tool|does not support.*function|function.call.*not.*available/i.test(msg);
            if (isToolUnsupported) {
              toolsSupported = false;
              process.stderr.write(`\n  [ClawMode] Provider does not support function calling, falling back to text mode\n`);
              response = await this.backend.complete(messages, {
                temperature: 0.3,
                signal: context.signal,
              });
            } else {
              throw toolErr; // Re-throw — let outer retry handle it
            }
          }
        } else {
          response = await this.backend.complete(messages, {
            temperature: 0.3,
            signal: context.signal,
          });
        }

        // Emit any text content
        if (response.content) {
          fullContent += response.content;
          yield { type: 'text', content: response.content };
        }

        // If LLM used tool calls, execute them and loop
        if (response.toolCalls && response.toolCalls.length > 0) {
          messages.push({
            role: 'assistant',
            content: response.content || '',
            toolCalls: response.toolCalls,
          });

          let toolErrors = 0;
          for (const tc of response.toolCalls) {
            yield { type: 'progress', content: `> ${tc.name}: ${JSON.stringify(tc.arguments).slice(0, 120)}` };
            const result = await this.executeClawTool(tc.name, tc.arguments, context);
            const isErr = result.startsWith('Error:') || result.startsWith('Command failed:');
            if (isErr) toolErrors++;
            // Show tool result to user (truncated for long outputs)
            const displayResult = result.length > 500 ? result.slice(0, 500) + '\n... (truncated)' : result;
            yield { type: 'progress', content: isErr ? `  ✗ ${displayResult}` : `  ${displayResult}` };
            messages.push({
              role: 'tool',
              content: result,
              toolResult: { toolCallId: tc.id, content: result, isError: isErr },
            });
          }
          // If all tool calls in this round failed and we've been looping,
          // add a hint to prevent infinite retry loops
          if (toolErrors === response.toolCalls.length && round >= 3) {
            messages.push({
              role: 'user',
              content: 'Multiple tool calls have failed. Please summarize what you found so far and what the issues are, without calling more tools.',
            });
          }

          // If this is the last allowed round, force a final summary
          if (round >= MAX_TOOL_ROUNDS) {
            messages.push({
              role: 'user',
              content: 'You have reached the tool call limit. Please provide a final summary of what you did and found.',
            });
            const finalResp = await this.backend.complete(messages, {
              temperature: 0.3,
              signal: context.signal,
            });
            if (finalResp.content) {
              fullContent += finalResp.content;
              yield { type: 'text', content: finalResp.content };
            }
          }
          continue; // Next round
        }

        // No tool calls — check if LLM embedded commands in text (fallback for
        // providers that don't support function calling)
        if (round === 0 && response.content) {
          const commands = this.extractCommandsFromText(response.content);
          if (commands.length > 0) {
            yield { type: 'status', content: 'Executing commands from response...' };
            for (const cmd of commands) {
              yield { type: 'progress', content: `> run_command: ${cmd}` };
              const result = await this.executeClawTool('run_command', { command: cmd }, context);
              fullContent += `\n\`\`\`\n${result}\`\`\`\n`;
              yield { type: 'text', content: `\n\`\`\`\n${result}\`\`\`\n` };
            }
          }
        }

        break; // No tool calls, done
      }

      // If we used tools but LLM never gave a text summary, force one
      if (!fullContent.trim() && messages.some(m => m.role === 'tool')) {
        messages.push({
          role: 'user',
          content: 'Please summarize what you did and what you found.',
        });
        const finalResp = await this.backend.complete(messages, {
          temperature: 0.3,
          signal: context.signal,
        });
        if (finalResp.content) {
          fullContent += finalResp.content;
          yield { type: 'text', content: finalResp.content };
        }
      }
    } catch (err) {
      // Don't show error for user-initiated abort (Ctrl+C)
      if (err instanceof Error && (err.name === 'AbortError' || err.message.includes('aborted'))) {
        // Preserve partial output in history so context isn't lost
        if (fullContent.trim()) {
          context.history.push({ role: 'assistant', content: fullContent + '\n\n(interrupted)' });
        }
        return;
      }
      yield { type: 'error', content: err instanceof Error ? err.message : String(err) };
      return;
    }

    context.history.push({ role: 'assistant', content: fullContent });
  }

  // -----------------------------------------------------------------------
  // Project Mode: intent classification + workflow dispatch
  // -----------------------------------------------------------------------

  private async *handleProjectMode(
    userMessage: string,
    context: OrchestratorContext,
  ): AsyncGenerator<OutputChunk> {
    // If workflow running and user sends a question, answer via chat
    if (this.workflowState) {
      if (quickQuestionCheck(userMessage)) {
        yield* this.handleClawMode(userMessage, context);
        return;
      }
      // Otherwise treat as continuation
      context.history.push({ role: 'user', content: userMessage });
      yield* this.executeWorkflow(context);
      return;
    }

    // Design request detection: keyword-based, no LLM round-trip
    if (quickDesignRequestCheck(userMessage)) {
      // Confirm with user before starting workflow
      if (!context.autoMode && context.askUser) {
        const answer = await context.askUser(
          'Start design workflow for this request? (y/n)',
        );
        if (!/^y/i.test(answer.trim())) {
          yield* this.handleClawMode(userMessage, context);
          return;
        }
      }

      const plan = buildTaskPlan(userMessage, 'standard');
      this.workflowState = {
        plan,
        moduleStatuses: [],
        currentModuleIndex: 0,
        lastUpdated: new Date().toISOString(),
      };
      yield* this.executeWorkflow(context);
      return;
    }

    // Everything else → chat (no extra LLM call)
    yield* this.handleClawMode(userMessage, context);
  }

  // -----------------------------------------------------------------------
  // Workflow execution (step dispatcher)
  // -----------------------------------------------------------------------

  private async *executeWorkflow(context: OrchestratorContext): AsyncGenerator<OutputChunk> {
    if (!this.workflowState) return;
    const plan = this.workflowState.plan;

    // Ensure project directory structure exists before workflow starts
    if (context.executeAction && context.projectPath) {
      try {
        for (const dir of ['hw/src/hdl', 'hw/src/macro', 'hw/src/filelist', 'hw/dv/st/sim/tb', 'hw/dv/ut/sim/tb', 'hw/dv/tc', 'hw/syn']) {
          await context.executeAction({
            type: 'writeFile',
            payload: { path: `${dir}/.gitkeep`, content: '' },
          });
        }
      } catch { /* best-effort — dirs may already exist */ }
    }

    const autoRetryCount = new Map<number, number>();
    const AUTO_RETRY_LIMIT = 3;

    for (let i = 0; i < plan.steps.length; i++) {
      // Check for abort (Ctrl+C)
      if (context.signal?.aborted) {
        yield { type: 'status', content: 'Workflow cancelled by user.' };
        await this.persistState(context);
        return;
      }

      const step = plan.steps[i]!;
      if (step.status === 'done' || step.status === 'skipped') continue;

      plan.currentStep = step.id;
      step.status = 'running';
      await this.persistState(context);

      yield {
        type: 'progress',
        content: `[${step.id}/${plan.steps.length}] ${step.description}...`,
      };

      try {
        yield* this.executeStep(step, context);
        step.status = 'done';
        autoRetryCount.delete(step.id);
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        const isNetworkError = /timed?\s*out|Connection error|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|fetch failed|socket hang up/i.test(errMsg);

        if (isNetworkError && context.autoMode) {
          const retries = (autoRetryCount.get(step.id) ?? 0) + 1;
          autoRetryCount.set(step.id, retries);
          if (retries <= AUTO_RETRY_LIMIT) {
            yield { type: 'status', content: `Auto-mode: retrying step ${step.id} after network error (${retries}/${AUTO_RETRY_LIMIT}).` };
            step.status = 'pending';
            i--;
            continue;
          }
          yield { type: 'error', content: `Auto-mode: step ${step.id} failed after ${AUTO_RETRY_LIMIT} retries. Stopping.` };
        }
        if (isNetworkError && context.askUser) {
          yield { type: 'error', content: `Step ${step.id} failed: ${errMsg}` };
          const answer = await context.askUser('Network error. Retry this step? (y/n)');
          if (/^y/i.test(answer.trim())) {
            step.status = 'pending';
            i--; // retry same step
            continue;
          }
        }

        step.status = 'failed';
        yield { type: 'error', content: `Step ${step.id} failed: ${errMsg}` };
        break;
      }

      await this.persistState(context);
    }

    // Check if any step failed
    const hasFailed = plan.steps.some(s => s.status === 'failed');
    this.workflowState = null;

    if (hasFailed) {
      yield { type: 'status', content: 'Workflow stopped due to errors.' };
    } else {
      yield { type: 'status', content: 'Workflow complete.' };
    }
  }

  private async *executeStep(
    step: TaskStep,
    context: OrchestratorContext,
  ): AsyncGenerator<OutputChunk> {
    switch (step.stage) {
      case 'architect_p1':
        yield* this.runArchitectP1(context);
        break;
      case 'rtl':
        yield* this.runRTLPipeline(context);
        break;
      case 've_st':
        yield* this.runSystemTest(context);
        break;
      case 'be':
        yield* this.runBE(context);
        break;
      case 'summary':
        yield* this.runSummary(context);
        break;
      default:
        yield { type: 'status', content: `Unknown stage: ${step.stage}` };
    }
  }

  // -----------------------------------------------------------------------
  // Stage: Architect Phase 1
  // -----------------------------------------------------------------------

  private async *runArchitectP1(context: OrchestratorContext): AsyncGenerator<OutputChunk> {
    await this.logWorkflow(context, 'P1', 'start');
    const ctx = this.buildStageContext(context);
    const requirement = this.workflowState!.plan.goal;

    for await (const chunk of runArchitectPhase1(ctx, requirement)) {
      // Capture the phase1Output from metadata
      if (chunk.type === 'status' && chunk.metadata?.phase1Output) {
        this.phase1Output = chunk.metadata.phase1Output as ArchitectPhase1Output;

        // v3: Structural validation
        await this.logWorkflow(context, 'P1', 'done', `modules=${this.phase1Output.dependencyOrder.length} contracts=${this.phase1Output.interfaceContracts?.length ?? 0}`);
        await this.logWorkflow(context, 'validation', 'start');
        const validation = validatePhase1Structure(this.phase1Output);
        if (validation.warnings.length > 0) {
          yield {
            type: 'progress',
            content: `Structural warnings:\n${validation.warnings.map(w => `  ⚠ ${w}`).join('\n')}`,
          };
        }
        if (!validation.valid) {
          yield {
            type: 'error',
            content: `Structural validation errors:\n${validation.errors.map(e => `  - ${e}`).join('\n')}`,
          };
          // Feed errors back to LLM for correction (up to 2 retries handled by architect-p1)
          // For now, continue with the design but warn the user
        }

        await this.logWorkflow(context, 'validation', validation.valid ? 'done' : 'fail', `errors=${validation.errors.length} warnings=${validation.warnings.length}`);

        this.designIndex = convertToDesignIndex(this.phase1Output);
        context.designIndex = this.designIndex;

        // Save to workflow state
        if (this.workflowState) {
          this.workflowState.phase1Output = this.phase1Output;
        }

        // Initialize module statuses from dependency order
        // v3: Exclude top modules (auto-generated, no P2/RTL/UT needed)
        if (this.workflowState) {
          const topSet = new Set(this.phase1Output.topModules);
          // Exclude auto-generated top modules, but keep them if they are the ONLY module
          const depOrder = this.phase1Output.dependencyOrder;
          this.workflowState.moduleStatuses = depOrder
            .filter(name => depOrder.length === 1 || !topSet.has(name) || !this.phase1Output!.topPorts?.length)
            .map(name => {
              const ext = context.hdlStandard?.startsWith('sv') ? '.sv' : '.v';
              return {
              name,
              file: `hw/src/hdl/${name}${ext}`,
              lintPassed: false,
              utPassed: false,
              sameErrorRetries: 0,
              totalIterations: 0,
              tbSuspectCount: 0,
              status: 'pending' as const,
              lintAttempts: 0,
              veCompileAttempts: 0,
              debugHistory: [],
            };});
        }

        // v3.1: Create primary filelist from Architect P1 output
        if (context.executeAction && this.phase1Output.filelists?.length) {
          const primaryFilelist = this.phase1Output.filelists.find(f => f.purpose === 'rtl')
            ?? this.phase1Output.filelists[0];
          context.filelistPath = primaryFilelist.path;

          const content = primaryFilelist.initialContent?.join('\n') ?? '';
          try {
            await context.executeAction({
              type: 'writeFile',
              payload: { path: primaryFilelist.path, content: content ? content + '\n' : '' },
            });
            yield { type: 'progress', content: `Created filelist: ${primaryFilelist.path}` };
          } catch { /* best-effort */ }
        }

        // Persist design index
        if (context.executeAction) {
          try {
            await context.executeAction({
              type: 'updateIndex',
              payload: { index: this.designIndex },
            });
          } catch { /* best-effort */ }
        }
      }

      // v3: Handle rejection — loop back to requirements gathering
      if (chunk.type === 'error' && chunk.content.includes('rejected')) {
        yield chunk;
        // Re-run P1 from scratch (the workflow will re-enter this method)
        return;
      }

      yield chunk;
    }

    if (!this.phase1Output) {
      throw new Error('Architect Phase 1 produced no output.');
    }

    // v3: Generate design_params after P1 approval
    await this.logWorkflow(context, 'design_params', 'start');
    for await (const chunk of generateDesignParams(ctx, this.phase1Output, context.hdlStandard)) {
      yield chunk;
    }
    await this.logWorkflow(context, 'design_params', 'done');
  }

  // -----------------------------------------------------------------------
  // Stage: RTL Pipeline (per-module: P2 → write → lint → UT → debug loop)
  // -----------------------------------------------------------------------

  private async *runRTLPipeline(context: OrchestratorContext): AsyncGenerator<OutputChunk> {
    if (!this.workflowState || !this.phase1Output || !this.designIndex) {
      throw new Error('No architecture available for RTL generation.');
    }

    const modules = this.workflowState.moduleStatuses;
    const startIdx = this.workflowState.currentModuleIndex;
    const moduleRetryCount = new Map<string, number>();

    for (let i = startIdx; i < modules.length; i++) {
      const mod = modules[i]!;
      if (mod.status === 'done' || mod.status === 'skipped') continue;

      this.workflowState.currentModuleIndex = i;
      yield { type: 'progress', content: `\n--- Module ${mod.name} (${i + 1}/${modules.length}) ---` };

      try {
        // ── Phase 2: detailed design ──
        yield* this.runArchitectP2ForModule(mod, context);

        // ── RTL write ──
        yield* this.runRTLWrite(mod, context);
        if ((mod.status as string) === 'failed' || (mod.status as string) === 'skipped') continue;

        // ── Lint ──
        yield* this.runLint(mod, context);
        if ((mod.status as string) === 'failed' || (mod.status as string) === 'skipped') continue;

        // ── UT generation + simulation + debug loop ──
        yield* this.runUTWithDebugLoop(mod, context);
        moduleRetryCount.delete(mod.name);
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        const isNetwork = /timed?\s*out|Connection error|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|fetch failed|socket hang up/i.test(errMsg);

        if (isNetwork && context.autoMode) {
          const retries = (moduleRetryCount.get(mod.name) ?? 0) + 1;
          moduleRetryCount.set(mod.name, retries);
          if (retries <= 3) {
            yield { type: 'status', content: `Auto-mode: retrying module "${mod.name}" after network error (${retries}/3).` };
            i--;
            continue;
          }
          yield { type: 'error', content: `Auto-mode: module "${mod.name}" failed after 3 network retries.` };
        }
        if (isNetwork && context.askUser) {
          yield { type: 'error', content: `Module "${mod.name}" failed: ${errMsg}` };
          const answer = await context.askUser('Network error. Retry this module? (y/n)');
          if (/^y/i.test(answer.trim())) {
            i--; // retry same module
            continue;
          }
        }

        mod.status = 'failed';
        yield { type: 'error', content: `Module "${mod.name}" failed: ${errMsg}` };
      }

      await this.persistState(context);
    }

    // Summary of module statuses
    const passed = modules.filter(m => m.status === 'done').length;
    const failed = modules.filter(m => m.status === 'failed').length;
    yield {
      type: 'status',
      content: `RTL pipeline complete: ${passed} passed, ${failed} failed out of ${modules.length} modules.`,
    };
  }

  // ── Architect Phase 2 (per module) ──

  private async *runArchitectP2ForModule(
    mod: ModuleStatus,
    context: OrchestratorContext,
  ): AsyncGenerator<OutputChunk> {
    await this.logWorkflow(context, 'P2', 'start', `module=${mod.name}`);
    const ctx = this.buildStageContext(context);

    for await (const chunk of runArchitectPhase2(ctx, this.phase1Output!, mod.name)) {
      if (chunk.type === 'status' && chunk.metadata?.phase2Output) {
        const p2 = chunk.metadata.phase2Output as ArchitectPhase2Output;
        this.phase2Outputs.set(mod.name, p2);
        mod.phase2Design = p2;

        // v3: Store p2Outputs in WorkflowState for crash recovery
        if (this.workflowState) {
          if (!this.workflowState.p2Outputs) {
            this.workflowState.p2Outputs = {};
          }
          this.workflowState.p2Outputs[mod.name] = p2;
        }
      }
      yield chunk;
    }
    await this.logWorkflow(context, 'P2', 'done', `module=${mod.name}`);
  }

  // ── RTL write ──

  private async *runRTLWrite(
    mod: ModuleStatus,
    context: OrchestratorContext,
  ): AsyncGenerator<OutputChunk> {
    const ctx = this.buildStageContext(context);
    const phase2 = this.phase2Outputs.get(mod.name);

    if (!phase2) {
      yield { type: 'error', content: `No Phase 2 design for module "${mod.name}". Skipping RTL write.` };
      mod.status = 'skipped';
      return;
    }

    // Gather dependent module ports (already-written modules)
    const depPorts = this.getDependentModulePorts(mod.name);

    mod.status = 'writing';
    await this.logWorkflow(context, 'RTL_WRITE', 'start', `module=${mod.name}`);

    // v3: Pass relevant interface contracts to RTL writer
    const contracts = this.phase1Output?.interfaceContracts
      ? getRelevantContracts(this.phase1Output.interfaceContracts, mod.name)
      : undefined;

    let writeHadError = false;
    for await (const chunk of writeModule(ctx, phase2, depPorts, context.hdlStandard, contracts)) {
      if (chunk.type === 'error') writeHadError = true;
      yield chunk;
    }

    // If RTL generation produced no code, stop the pipeline for this module
    if (writeHadError) {
      mod.status = 'failed';
      await this.logWorkflow(context, 'RTL_WRITE', 'fail', `module=${mod.name} no_code`);
      return;
    }

    // Module size check
    await this.checkModuleSize(mod, context);
    await this.logWorkflow(context, 'RTL_WRITE', 'done', `module=${mod.name} file=${mod.file}`);
  }

  // ── Lint ──
  //
  // Routing priority:
  // 1. Infrastructure error type (MODDUP, file not found, etc.) → infra immediately
  // 2. Non-module-file error (design_params.vh, etc.) → infra immediately
  // 3. Same error type persists 2 rounds → infra (Designer can't fix it)
  // 4. Normal: Designer fix → re-lint
  // 5. At attempt 4: fresh rewrite with lint error context
  // 6. At attempt 8 or fixLintErrors returns false: → infra
  //
  // Max 2 infrastructure escalations to prevent infinite loops.

  private async *runLint(
    mod: ModuleStatus,
    context: OrchestratorContext,
  ): AsyncGenerator<OutputChunk> {
    if (!context.executeAction) {
      mod.lintPassed = true;
      return;
    }

    mod.status = 'linting';
    await this.logWorkflow(context, 'LINT', 'start', `module=${mod.name}`);
    yield { type: 'progress', content: `Linting ${mod.name}...` };

    const ctx = this.buildStageContext(context);
    let lastLintResult = '';   // For fresh-rewrite context
    let lastNormalizedLint = '';
    let sameLintErrorCount = 0;
    let infraEscalations = 0;  // Cap infrastructure attempts

    while (true) {
      let lintResult: string;
      try {
        lintResult = await context.executeAction({
          type: 'lintCode',
          payload: { file: mod.file },
        });
      } catch {
        yield { type: 'status', content: `Lint check skipped for ${mod.name} (tool unavailable)` };
        mod.lintPassed = true;
        return;
      }

      // Check for actual errors — avoid false positives from "0 error(s)" or "No errors"
      const hasLintError = /\berror\b/i.test(lintResult) &&
        !/\b0\s+error/i.test(lintResult) && !/no\s+error/i.test(lintResult);
      if (!hasLintError) {
        await this.logWorkflow(context, 'LINT', 'done', `module=${mod.name} clean attempt=${mod.lintAttempts}`);
        yield { type: 'status', content: `Lint passed: ${mod.name}` };
        mod.lintPassed = true;
        return;
      }

      mod.lintAttempts++;
      lastLintResult = lintResult;

      // Track same-error for escalation (strip file:line for robust comparison)
      const normalized = this.normalizeLintError(lintResult);
      if (normalized === lastNormalizedLint) {
        sameLintErrorCount++;
      } else {
        sameLintErrorCount = 1;
        lastNormalizedLint = normalized;
      }

      // ── Check if error is an infrastructure issue ──
      // Priority 1: Error TYPE is inherently non-code (MODDUP, file not found, etc.)
      // Priority 2: Error doesn't reference current module file at all
      const needsInfra =
        this.isInfrastructureLintError(lintResult) ||
        !this.isModuleLintError(lintResult, mod.name);

      if (needsInfra) {
        const reason = this.isInfrastructureLintError(lintResult)
          ? 'structural/infrastructure error type'
          : 'error from non-RTL source';
        const resolved = yield* this.escalateLintToInfra(ctx, mod, lintResult, infraEscalations, reason);
        infraEscalations++;
        if (!resolved) { mod.lintPassed = false; return; }
        continue;
      }

      // ── Same error type 2 consecutive rounds → infrastructure ──
      if (sameLintErrorCount >= 2) {
        const resolved = yield* this.escalateLintToInfra(ctx, mod, lintResult, infraEscalations,
          `same error persisted ${sameLintErrorCount} rounds`);
        infraEscalations++;
        if (!resolved) { mod.lintPassed = false; return; }
        sameLintErrorCount = 0;
        lastNormalizedLint = '';
        continue;
      }

      // ── Fresh rewrite at halfway (attempt 4) ──
      if (mod.lintAttempts === LINT_ATTEMPT_CAP) {
        yield { type: 'status', content: `Lint fix failed ${LINT_ATTEMPT_CAP} times for ${mod.name}, requesting fresh rewrite...` };
        const phase2 = this.phase2Outputs.get(mod.name);
        if (phase2) {
          const depPorts = this.getDependentModulePorts(mod.name);
          for await (const chunk of writeModule(ctx, phase2, depPorts, context.hdlStandard, undefined, lastLintResult)) {
            yield chunk;
          }
        }
        continue;
      }

      // ── Total cap (attempt 8) → infrastructure ──
      if (mod.lintAttempts >= LINT_ATTEMPT_CAP * 2) {
        const resolved = yield* this.escalateLintToInfra(ctx, mod, lintResult, infraEscalations,
          `${mod.lintAttempts} total attempts exhausted`);
        infraEscalations++;
        if (!resolved) { mod.lintPassed = false; return; }
        continue;
      }

      // ── Normal Designer fix ──
      await this.logWorkflow(context, 'LINT_FIX', 'start', `module=${mod.name} attempt=${mod.lintAttempts}`);
      yield { type: 'status', content: `Lint errors in ${mod.name} (attempt ${mod.lintAttempts}), fixing...` };
      const fixed = await fixLintErrors(ctx, mod.name, lintResult, context.hdlStandard);
      if (!fixed) {
        // Designer produced no code → escalate to infrastructure (not give up)
        yield { type: 'status', content: `Designer produced no fix for ${mod.name} lint error, escalating...` };
        const resolved = yield* this.escalateLintToInfra(ctx, mod, lintResult, infraEscalations,
          'Designer produced no fix');
        infraEscalations++;
        if (!resolved) { mod.lintPassed = false; return; }
        continue;
      }
    }
  }

  /**
   * Escalate a lint error to infrastructure debug.
   * Returns true if infrastructure resolved the issue (caller should re-lint).
   * Returns false if failed/capped (caller should exit runLint).
   */
  private async *escalateLintToInfra(
    ctx: StageContext,
    mod: ModuleStatus,
    lintResult: string,
    infraEscalations: number,
    reason: string,
  ): AsyncGenerator<OutputChunk, boolean> {
    if (infraEscalations >= 2) {
      yield { type: 'error', content: `Lint error for ${mod.name} persists after ${infraEscalations} infrastructure attempts (${reason}). Manual intervention required.` };
      mod.lintPassed = false;
      return false;
    }

    yield { type: 'status', content: `Lint error in ${mod.name}: ${reason} — routing to Infrastructure Debug Agent...` };

    const infraResult = yield* this.drainInfraDebug(runInfraDebug(ctx, lintResult, 'compile'));
    if (infraResult.resolved) {
      yield { type: 'status', content: `Infrastructure resolved lint issue for ${mod.name}. Re-linting...` };
      return true;
    }
    yield { type: 'error', content: `Infrastructure could not resolve lint error for ${mod.name}. Manual intervention required.` };
    mod.lintPassed = false;
    return false;
  }

  // ── UT with debug loop ──

  private async *runUTWithDebugLoop(
    mod: ModuleStatus,
    context: OrchestratorContext,
  ): AsyncGenerator<OutputChunk> {
    const ctx = this.buildStageContext(context);
    const phase2 = this.phase2Outputs.get(mod.name);
    const modDef = this.designIndex?.modules.find(m => m.name === mod.name);

    if (!modDef) {
      yield { type: 'error', content: `Module "${mod.name}" not found in design index.` };
      mod.status = 'failed';
      return;
    }

    mod.status = 'testing';
    await this.logWorkflow(context, 'VE_UT', 'start', `module=${mod.name}`);

    // Generate UT testbench — pass full P2 spec so VE can write accurate checkers
    const utReqs = phase2?.utVerification
      ? JSON.stringify(phase2.utVerification)
      : 'Basic functional verification';

    const p2Spec = phase2 ? {
      functionalSpec: phase2.functionalSpec,
      fsmDescription: phase2.fsmDescription,
      timingNotes: phase2.timingNotes,
      boundaryConditions: phase2.boundaryConditions,
    } : undefined;

    // v3: Pass relevant interface contracts so VE can write protocol checkers
    const contracts = this.phase1Output?.interfaceContracts
      ? getRelevantContracts(this.phase1Output.interfaceContracts, mod.name)
      : undefined;

    const globalParams = this.phase1Output?.globalParameters;

    for await (const chunk of generateUTTestbench(ctx, mod.name, modDef.ports, utReqs, p2Spec, contracts, globalParams)) {
      yield chunk;
    }

    // Run simulation
    if (!context.executeAction) {
      yield { type: 'status', content: `Simulation skipped for ${mod.name} (no tool)` };
      mod.status = 'done';
      return;
    }

    let simResult: string;
    try {
      simResult = await context.executeAction({
        type: 'runSimulation',
        payload: { module: mod.name, testType: 'ut' },
      });
    } catch (err) {
      yield { type: 'status', content: `Simulation skipped: ${err instanceof Error ? err.message : String(err)}` };
      mod.utPassed = false;
      mod.status = 'failed';
      return;
    }

    if (simResult.includes('TEST PASSED') || simResult.includes('PASSED')) {
      mod.utPassed = true;
      mod.status = 'done';
      await this.logWorkflow(context, 'VE_UT', 'done', `module=${mod.name} result=PASSED`);
      yield { type: 'status', content: `UT passed: ${mod.name}` };
      return;
    }

    // ── Debug loop ──
    await this.logWorkflow(context, 'VE_UT', 'done', `module=${mod.name} result=FAILED`);
    await this.logWorkflow(context, 'DEBUG', 'start', `module=${mod.name}`);
    yield { type: 'status', content: `UT failed for ${mod.name}, entering debug loop...` };
    yield* this.debugLoop(mod, simResult, context);
  }

  // -----------------------------------------------------------------------
  // Debug loop (checker-based, with tb_suspect mechanism)
  // -----------------------------------------------------------------------

  private async *debugLoop(
    mod: ModuleStatus,
    initialSimOutput: string,
    context: OrchestratorContext,
  ): AsyncGenerator<OutputChunk> {
    const ctx = this.buildStageContext(context);
    const phase2 = this.phase2Outputs.get(mod.name);
    let currentError = initialSimOutput;
    let lastNormalizedError = this.normalizeError(initialSimOutput);
    const errorCounts = new Map<string, number>();
    errorCounts.set(lastNormalizedError, 1);
    let consecutiveSimilarCheckerRounds = 0;
    let vcdEnabled = false;
    let vcdData: string | undefined;
    let compileSameErrorCount = 0;
    let compileTotalCount = 0;
    let lastCompileError = '';

    // ── Spec-Checker Audit: conclusive diagnosis before guessing (max 2 rounds) ──
    let auditResult: SpecCheckerAuditResult | undefined;
    if (phase2?.functionalSpec && !this.isCompileError(currentError)) {
      const MAX_AUDIT_ROUNDS = 2;
      for (let auditRound = 0; auditRound < MAX_AUDIT_ROUNDS; auditRound++) {
        try {
          await this.logWorkflow(context, 'SPEC_AUDIT', 'start', `module=${mod.name} round=${auditRound + 1}`);
          // Read TB code for audit (re-read each round — VE may have fixed it)
          const tbPath = `hw/dv/ut/sim/tb/tb_${mod.name}.sv`;
          let tbCode = '';
          try {
            tbCode = await ctx.readFile(tbPath);
          } catch {
            try {
              tbCode = await ctx.readFile(tbPath.replace('.sv', '.v'));
            } catch { /* no TB to audit */ }
          }

          if (!tbCode) break;

          auditResult = await auditSpecVsChecker(
            ctx, mod.name, phase2.functionalSpec, tbCode, currentError,
          );
          const verdict = auditResult.checkerCorrect ? 'checker_correct→fix_rtl' : 'checker_wrong→fix_tb';
          await this.logWorkflow(context, 'SPEC_AUDIT', 'done', `module=${mod.name} ${verdict} round=${auditRound + 1}`);
          yield {
            type: 'status',
            content: `[Spec Audit ${auditRound + 1}] ${auditResult.checkerCorrect ? 'Checker logic matches spec → RTL needs fix' : `Checker mismatch: ${auditResult.mismatch?.slice(0, 200)}`}`,
          };

          mod.debugHistory.push(
            `[Spec Audit ${auditRound + 1}] ${auditResult.recommendation}: ${auditResult.analysis.slice(0, 300)}`,
          );

          // Checker correct → no TB fix needed, proceed to debug loop
          if (auditResult.checkerCorrect || auditResult.recommendation !== 'fix_tb') break;

          // Checker wrong → fix TB
          yield { type: 'status', content: `Spec audit found TB checker error. Routing to VE for fix...` };
          const reviewResult = await reviewTB(
            ctx, mod.name,
            `Spec audit found: ${auditResult.mismatch ?? auditResult.analysis}`,
            phase2.utVerification ? JSON.stringify(phase2.utVerification) : '',
            phase2.functionalSpec,
          );
          if (!reviewResult.tbCorrect) {
            mod.debugHistory.push(`[VE fixed TB after audit] ${reviewResult.reason?.slice(0, 300) ?? ''}`);
            yield { type: 'status', content: `VE fixed TB based on audit: ${reviewResult.fixedTBPath}` };
          } else {
            // VE disagrees with audit (says TB is correct) — no point re-auditing same TB
            mod.debugHistory.push(`[Audit/VE disagree] Audit says checker wrong, VE says correct: ${reviewResult.reason?.slice(0, 200) ?? ''}`);
            break;
          }

          // Re-simulate after TB fix
          if (!context.executeAction) break;
          const reSimResult = await context.executeAction({
            type: 'runSimulation',
            payload: { module: mod.name, testType: 'ut', regression: true },
          });
          if (reSimResult.includes('TEST PASSED') || reSimResult.includes('PASSED')) {
            mod.utPassed = true;
            mod.status = 'done';
            await this.logWorkflow(context, 'DEBUG', 'done', `module=${mod.name} RESOLVED by spec audit round=${auditRound + 1}`);
            yield { type: 'status', content: `Debug resolved for ${mod.name} — TB checker was incorrect (fixed by spec audit)` };
            return;
          }
          // TB fix didn't fully resolve — update error and loop to re-audit
          currentError = reSimResult;
          lastNormalizedError = this.normalizeError(reSimResult);
          errorCounts.set(lastNormalizedError, 1);
        } catch (err) {
          await this.logWorkflow(context, 'SPEC_AUDIT', 'fail', `module=${mod.name} ${err instanceof Error ? err.message : ''}`);
          break;
        }
      }
    }

    const iterCap = context.debugConfig?.totalIterationCap ?? TOTAL_ITERATION_CAP;
    const sameErrCap = context.debugConfig?.sameErrorMaxRetries ?? SAME_ERROR_MAX_RETRIES;

    while (mod.totalIterations < iterCap) {
      mod.totalIterations++;
      const sameCount = errorCounts.get(lastNormalizedError) ?? 0;

      if (sameCount > sameErrCap) {
        yield* this.handleDebugExhausted(mod, context);
        // If counters were reset (user chose retry/infrastructure resolved), re-enter loop
        if (mod.status !== 'failed' && mod.status !== 'skipped' && mod.totalIterations === 0) {
          errorCounts.clear();
          lastNormalizedError = '';
          consecutiveSimilarCheckerRounds = 0;
          continue;
        }
        return;
      }

      yield {
        type: 'progress',
        content: `Debug iteration ${mod.totalIterations} for ${mod.name} (same-error: ${sameCount}/${sameErrCap})...`,
      };

      // Log debug loop state
      if (ctx.logTrace) {
        await ctx.logTrace({
          timestamp: new Date().toISOString(),
          role: 'Orchestrator',
          promptTokens: 0,
          completionTokens: 0,
          durationMs: 0,
          event: 'debug_loop',
          taskContext: `debug_loop:${mod.name}`,
          summary: `iter=${mod.totalIterations}/${iterCap} same_err=${sameCount}/${sameErrCap} similar_checker=${consecutiveSimilarCheckerRounds} lint=${mod.lintAttempts} ve_compile=${mod.veCompileAttempts} tb_suspect=${mod.tbSuspectCount}`,
        });
      }

      // v3.1: Compile error → specific-role fix first, escalate to infrastructure
      if (this.isCompileError(currentError)) {
        compileTotalCount++;
        const normalizedCompile = this.normalizeError(currentError);
        if (normalizedCompile === lastCompileError) {
          compileSameErrorCount++;
        } else {
          compileSameErrorCount = 1;
          lastCompileError = normalizedCompile;
        }

        const shouldEscalate =
          compileSameErrorCount > COMPILE_SAME_ERROR_CAP ||
          compileTotalCount > COMPILE_TOTAL_CAP;

        if (shouldEscalate) {
          // Escalate to Infrastructure Debug Agent
          await this.logWorkflow(context, 'DEBUG', 'start', `module=${mod.name} route=infra_debug_compile same=${compileSameErrorCount} total=${compileTotalCount}`);
          yield { type: 'status', content: `Compile fix exhausted (same-error: ${compileSameErrorCount}, total: ${compileTotalCount}) — escalating to Infrastructure Debug Agent...` };

          const infraResult = yield* this.drainInfraDebug(runInfraDebug(ctx, currentError, 'compile'));

          if (!infraResult.resolved) {
            yield { type: 'error', content: `Infrastructure Debug Agent could not resolve compile error for ${mod.name}. Manual intervention required.` };
            mod.status = 'failed';
            return;
          }
          // Infrastructure resolved it — reset compile counters and error tracking
          compileSameErrorCount = 0;
          compileTotalCount = 0;
          lastCompileError = '';
          errorCounts.clear();
          lastNormalizedError = '';
          consecutiveSimilarCheckerRounds = 0;
        } else {
          // Tier 1: Specific-role fix — route by error source
          const errorSource = this.classifyCompileError(currentError);

          if (errorSource === 'unknown') {
            // Can't determine source → skip Tier 1, go directly to infrastructure
            await this.logWorkflow(context, 'DEBUG', 'start', `module=${mod.name} route=infra_debug_compile reason=unknown_source`);
            yield { type: 'status', content: `Compile error source unclear — escalating to Infrastructure Debug Agent...` };

            const infraResult = yield* this.drainInfraDebug(runInfraDebug(ctx, currentError, 'compile'));

            if (!infraResult.resolved) {
              yield { type: 'error', content: `Infrastructure Debug Agent could not resolve compile error for ${mod.name}. Manual intervention required.` };
              mod.status = 'failed';
              return;
            }
            compileSameErrorCount = 0;
            compileTotalCount = 0;
            lastCompileError = '';
            errorCounts.clear();
            lastNormalizedError = '';
            consecutiveSimilarCheckerRounds = 0;
          } else if (errorSource === 'rtl') {
            // RTL compile error → Designer fixes (same as lint fix)
            mod.lintAttempts++;
            await this.logWorkflow(context, 'DEBUG', 'start', `module=${mod.name} route=Designer_compile same=${compileSameErrorCount}/${COMPILE_SAME_ERROR_CAP} total=${compileTotalCount}/${COMPILE_TOTAL_CAP}`);
            yield { type: 'status', content: `RTL compile error detected, routing to Designer for fix (${compileSameErrorCount}/${COMPILE_SAME_ERROR_CAP} same, ${compileTotalCount}/${COMPILE_TOTAL_CAP} total)...` };
            const fixed = await fixLintErrors(ctx, mod.name, currentError, context.hdlStandard);
            if (!fixed) {
              yield { type: 'status', content: `Designer compile fix produced no output for ${mod.name}` };
            }
          } else {
            // TB/TC compile error → VE fixes
            mod.veCompileAttempts++;
            await this.logWorkflow(context, 'DEBUG', 'start', `module=${mod.name} route=VE_compile same=${compileSameErrorCount}/${COMPILE_SAME_ERROR_CAP} total=${compileTotalCount}/${COMPILE_TOTAL_CAP}`);
            yield { type: 'status', content: `TB/TC compile error detected, routing to VE for fix (${compileSameErrorCount}/${COMPILE_SAME_ERROR_CAP} same, ${compileTotalCount}/${COMPILE_TOTAL_CAP} total)...` };
            const fixed = await fixCompileErrors(ctx, mod.name, currentError);
            if (!fixed) {
              yield { type: 'status', content: `VE compile fix produced no output for ${mod.name}` };
            }
          }
        }
      } else {
        // Ask RTL Designer to diagnose and fix (or flag tb_suspect)
        const funcDesc = phase2?.functionalSpec ?? '';
        const verifReqs = phase2?.utVerification
          ? JSON.stringify(phase2.utVerification)
          : undefined;

        await this.logWorkflow(context, 'DEBUG', 'start', `module=${mod.name} route=designer iter=${mod.totalIterations}`);
        const diagnosis: DebugDiagnosis = await debugFix(
          ctx,
          mod.name,
          currentError,
          funcDesc,
          verifReqs,
          mod.debugHistory.length > 0 ? mod.debugHistory : undefined,
          vcdData,
        );

        // v3: Collect fix_summary into debug history
        if (diagnosis.fix_summary) {
          mod.debugHistory.push(diagnosis.fix_summary);
        }

        // ── tb_suspect path ──
        if (diagnosis.diagnosis === 'tb_suspect') {
          mod.tbSuspectCount++;

          // Cap: after N tb_suspect rounds, skip VE review and treat as RTL fix
          if (mod.tbSuspectCount > TB_SUSPECT_CAP) {
            yield { type: 'status', content: `tb_suspect capped (${mod.tbSuspectCount}/${TB_SUSPECT_CAP}) — TB has been independently reviewed, focusing on RTL.` };
            mod.debugHistory.push(`[tb_suspect ignored — cap reached] ${diagnosis.reason ?? ''}`);
            // Fall through to the fix path below (diagnosis.fixedCode will be falsy, so no-op — next iteration Designer should fix RTL)
          } else {
            // v3: Record tb_suspect in debug history
            mod.debugHistory.push(`[tb_suspect] ${diagnosis.reason ?? 'no reason'}`);

            yield {
              type: 'status',
              content: `Designer suspects testbench issue: ${diagnosis.reason ?? 'no reason given'}`,
            };

            const reviewResult = await reviewTB(
              ctx,
              mod.name,
              diagnosis.reason ?? '',
              verifReqs ?? '',
              phase2?.functionalSpec,
            );

            if (reviewResult.tbCorrect) {
              const veReason = reviewResult.reason ?? 'no reason given';
              await this.logWorkflow(context, 'DEBUG', 'done', `module=${mod.name} route=tb_suspect result=TB_correct`);
              yield { type: 'status', content: `VE confirms TB is correct: ${veReason.slice(0, 200)}` };
              mod.debugHistory.push(`[VE confirms TB correct] ${veReason.slice(0, 300)}`);
            } else {
              const fixReason = reviewResult.reason ?? '';
              await this.logWorkflow(context, 'DEBUG', 'done', `module=${mod.name} route=tb_suspect result=TB_fixed`);
              yield { type: 'status', content: `VE fixed testbench: ${reviewResult.fixedTBPath}${fixReason ? ' — ' + fixReason.slice(0, 150) : ''}` };
              mod.debugHistory.push(`[VE fixed TB] ${fixReason.slice(0, 300)}`);
            }
          }
        } else {
          // ── fix path ──
          if (diagnosis.fixedCode) {
            await this.logWorkflow(context, 'DEBUG', 'done', `module=${mod.name} route=designer result=fix target=${diagnosis.targetFile ?? mod.file}`);
            yield { type: 'progress', content: `Applied RTL fix to ${diagnosis.targetFile ?? mod.file}` };

            // Re-lint after debug fix to catch syntax errors early
            if (context.executeAction) {
              try {
                const lintResult = await context.executeAction({
                  type: 'lintCode',
                  payload: { file: mod.file },
                });
                const hasLintErr = /\berror\b/i.test(lintResult) &&
                  !/\b0\s+error/i.test(lintResult) && !/no\s+error/i.test(lintResult);
                if (hasLintErr) {
                  yield { type: 'status', content: `Debug fix introduced lint error, fixing...` };
                  await fixLintErrors(ctx, mod.name, lintResult, context.hdlStandard);
                }
              } catch { /* lint tool unavailable — skip */ }
            }
          } else {
            await this.logWorkflow(context, 'DEBUG', 'done', `module=${mod.name} route=designer result=no_code`);
            yield { type: 'status', content: `Debug fix produced no code for ${mod.name}` };
          }
        }
      }

      // Re-sim: run failing TC, then regression if it passes
      if (!context.executeAction) break;

      try {
        const failingTC = this.extractFailingTC(currentError);
        const simStartMs = Date.now();
        let result = await context.executeAction({
          type: 'runSimulation',
          payload: { module: mod.name, testType: 'ut', ...(failingTC ? { tc: failingTC } : {}) },
        });
        const simDurationMs = Date.now() - simStartMs;

        let passed = result.includes('TEST PASSED') || result.includes('PASSED');

        // If failing TC now passes, run full regression to catch regressions in other TCs
        if (passed && failingTC) {
          yield { type: 'progress', content: `${failingTC} now passes, running full regression...` };
          const regResult = await context.executeAction({
            type: 'runSimulation',
            payload: { module: mod.name, testType: 'ut' },
          });
          passed = regResult.includes('TEST PASSED') || regResult.includes('PASSED');
          if (!passed) {
            // A different TC failed — switch to debugging that one
            result = regResult;
            // Reset debug state for the new TC
            vcdEnabled = false;
            errorCounts.clear();
            consecutiveSimilarCheckerRounds = 0;
            mod.sameErrorRetries = 0;
            yield { type: 'status', content: `Regression found new failure: ${this.extractFailingTC(regResult) ?? 'unknown TC'}` };
          }
        }

        // Log simulation result
        if (ctx.logTrace) {
          await ctx.logTrace({
            timestamp: new Date().toISOString(),
            role: 'Orchestrator',
            promptTokens: 0,
            completionTokens: 0,
            durationMs: simDurationMs,
            event: 'simulation',
            taskContext: `sim:${mod.name}:ut:iter${mod.totalIterations}`,
            responseChars: result.length,
            summary: passed
              ? `PASSED after iter ${mod.totalIterations}`
              : `FAILED (${result.slice(0, 120).replace(/\n/g, ' ')})`,
            responseContent: result,
          });
        }

        if (passed) {
          mod.utPassed = true;
          mod.status = 'done';
          await this.logWorkflow(context, 'DEBUG', 'done', `module=${mod.name} RESOLVED iter=${mod.totalIterations}`);
          yield { type: 'status', content: `Debug resolved for ${mod.name} after ${mod.totalIterations} iteration(s)` };
          return;
        }

        // Track error changes
        const newNormalized = this.normalizeError(result);
        if (newNormalized !== lastNormalizedError) {
          lastNormalizedError = newNormalized;
          mod.sameErrorRetries = 0;
          consecutiveSimilarCheckerRounds = 0;
        } else {
          mod.sameErrorRetries++;
          consecutiveSimilarCheckerRounds++;
        }
        errorCounts.set(lastNormalizedError, (errorCounts.get(lastNormalizedError) ?? 0) + 1);
        currentError = result;

        // v3: VCD fallback — trigger, re-sim, and parse in one step
        if (!vcdEnabled && consecutiveSimilarCheckerRounds >= VCD_FALLBACK_THRESHOLD) {
          await this.logWorkflow(context, 'DEBUG', 'start', `module=${mod.name} route=VCD_fallback similar=${consecutiveSimilarCheckerRounds}`);
          yield { type: 'status', content: `${VCD_FALLBACK_THRESHOLD} consecutive similar errors — enabling VCD for debug...` };
          const vcdAdded = await addVCDToTB(ctx, mod.name, []);
          if (vcdAdded) {
            vcdEnabled = true;
            yield { type: 'progress', content: 'VCD dump added to testbench. Re-simulating to capture waveform...' };
            // Immediate re-sim (failing TC only) to generate VCD file
            if (context.executeAction) {
              try {
                const vcdFailingTC = this.extractFailingTC(currentError);
                const vcdSimResult = await context.executeAction({
                  type: 'runSimulation',
                  payload: { module: mod.name, testType: 'ut', ...(vcdFailingTC ? { tc: vcdFailingTC } : {}) },
                });
                // Update currentError with VCD-enabled sim result
                currentError = vcdSimResult;
              } catch {
                // Re-sim failed — continue with old error
              }
            }
          }
          consecutiveSimilarCheckerRounds = 0;
        }

        // v3: Parse VCD waveform when available
        vcdData = undefined;
        if (vcdEnabled && context.projectPath) {
          try {
            const vcdPath = `${context.projectPath}/hw/dv/ut/sim/wave.vcd`;
            const parser = new VCDParser();
            const vcd = await parser.parse(vcdPath);

            // Convert checker error time (ns) to VCD time units
            const checkerErrors = parseCheckerOutput(currentError);
            const firstErrorTimeNs = checkerErrors.find(e => e.timeNs > 0)?.timeNs ?? 0;
            const vcdTimePerNs = this.parseTimescaleToNs(vcd.timescale);
            const errorTimeVCD = vcdTimePerNs > 0 ? firstErrorTimeNs / vcdTimePerNs : firstErrorTimeNs;

            // Window: 20 clock-ish units before error to 10 after
            const windowStart = errorTimeVCD > 0 ? Math.max(0, errorTimeVCD - 20) : 0;
            const windowEnd = errorTimeVCD > 0 ? errorTimeVCD + 10 : Math.min(vcd.endTime, 200);

            // Let Designer select which signals to examine
            const allSignalNames = vcd.signals.map(s => s.name);
            const funcDesc = phase2?.functionalSpec ?? '';
            let selectedSignals: string[] = [];
            if (allSignalNames.length > 25) {
              selectedSignals = await selectVCDSignals(ctx, mod.name, currentError, allSignalNames, funcDesc);
              yield { type: 'progress', content: `Designer selected ${selectedSignals.length} signals for waveform analysis` };
            }
            // If <=25 signals or selection returned nothing, use all
            if (selectedSignals.length === 0) {
              selectedSignals = allSignalNames;
            }

            const extracted = parser.extractWindow(vcd, selectedSignals, windowStart, windowEnd);
            const formatted = parser.formatAsTable(extracted, checkerErrors.map(e => e.raw));
            if (formatted && !formatted.startsWith('No ')) {
              vcdData = formatted;
              yield { type: 'progress', content: `VCD waveform: ${extracted.signals.length} signals, time ${windowStart}-${windowEnd} (${vcd.timescale})` };
            }
          } catch {
            // VCD parse failure is non-fatal — continue without waveform data
          }
        }
      } catch {
        break;
      }
    }

    // Total cap exceeded — handle exhaustion, possibly re-enter if reset
    yield* this.handleDebugExhausted(mod, context);
    if (mod.status !== 'failed' && mod.status !== 'skipped' && mod.totalIterations === 0) {
      // Counters reset — re-enter debug loop by recursion (one level only)
      yield* this.debugLoop(mod, currentError, context);
    }
  }

  private async *handleDebugExhausted(
    mod: ModuleStatus,
    context: OrchestratorContext,
  ): AsyncGenerator<OutputChunk> {
    const ctx = this.buildStageContext(context);
    const phase2 = this.phase2Outputs.get(mod.name);

    // Show downstream dependencies
    let summary = `Module ${mod.name}: debug limit reached (${mod.totalIterations} iterations).\n`;
    if (this.designIndex) {
      const deps = this.designIndex.modules
        .filter(m => m.instances?.some(inst => inst.moduleName === mod.name))
        .map(m => m.name);
      if (deps.length > 0) {
        summary += `  Downstream dependencies: ${deps.join(', ')}\n`;
      }
    }
    summary += `  Debug history:\n${mod.debugHistory.map((h, i) => `    ${i + 1}. ${h}`).join('\n')}`;
    yield { type: 'status', content: summary };

    if (context.autoMode) {
      yield { type: 'status', content: `Auto-mode: skipping module ${mod.name}.` };
      mod.status = 'failed';
      return;
    }
    if (context.askUser) {
      const answer = await context.askUser(
        'Options:\n  1) Enable Infrastructure Debug (LLM will access both RTL and TB)\n  2) Reset and continue normal debug\n  3) Skip module\n  4) Pause for manual intervention',
      );
      const choice = answer.trim();

      if (choice === '1') {
        // v3.1: Infrastructure Debug Agent for functional errors
        await this.logWorkflow(context, 'INFRA_DEBUG', 'start', `module=${mod.name} mode=functional`);
        yield { type: 'status', content: 'User authorized Infrastructure Debug — LLM will access both RTL and TB with spec as ground truth.' };

        // Build spec context for the agent
        const specParts: string[] = [];
        if (phase2?.functionalSpec) specParts.push(`Functional Spec:\n${phase2.functionalSpec}`);
        if (phase2?.utVerification) specParts.push(`Verification Requirements:\n${JSON.stringify(phase2.utVerification, null, 2)}`);
        if (phase2?.fsmDescription) specParts.push(`FSM Description:\n${phase2.fsmDescription}`);
        if (phase2?.timingNotes) specParts.push(`Timing Notes:\n${phase2.timingNotes}`);
        const specStr = specParts.length > 0 ? specParts.join('\n\n') : 'No detailed spec available.';

        // Get the last error for the agent
        const lastError = mod.debugHistory.length > 0
          ? `Module: ${mod.name}\nLast error:\n${mod.debugHistory[mod.debugHistory.length - 1]}`
          : `Module: ${mod.name}\nDebug exhausted after ${mod.totalIterations} iterations.`;

        const infraResult = yield* this.drainInfraDebug(runInfraDebug(ctx, lastError, 'functional', specStr));

        await this.logWorkflow(context, 'INFRA_DEBUG', 'done', `module=${mod.name} resolved=${infraResult.resolved} rounds=${infraResult.toolRounds}`);

        if (infraResult.resolved) {
          yield { type: 'status', content: `Infrastructure Debug resolved the issue. Re-running simulation...` };
          // Reset debug counters and re-enter debug loop by returning (caller will re-sim)
          mod.sameErrorRetries = 0;
          mod.totalIterations = 0;
          mod.debugHistory.push(`[InfraDebug resolved] ${infraResult.summary.slice(0, 200)}`);
          return;
        }
        yield { type: 'status', content: `Infrastructure Debug could not resolve: ${infraResult.summary.slice(0, 200)}` };
        mod.debugHistory.push(`[InfraDebug failed] ${infraResult.summary.slice(0, 200)}`);
        // Fall through to ask again
        const retry = await context.askUser('Infrastructure Debug did not resolve the issue.\n  1) Skip module  2) Pause for manual intervention');
        if (retry.trim() === '2') {
          mod.status = 'failed';
          yield { type: 'status', content: `Paused. Edit code manually, then use /continue to resume.` };
          return;
        }
      } else if (choice === '2') {
        mod.sameErrorRetries = 0;
        mod.totalIterations = 0;
        return;
      } else if (choice === '4') {
        mod.status = 'failed';
        yield { type: 'status', content: `Paused. Edit code manually, then use /continue to resume.` };
        return;
      }
    }
    mod.status = 'skipped';
  }

  // -----------------------------------------------------------------------
  // Stage: System Test (VE-ST)
  // -----------------------------------------------------------------------

  private async *runSystemTest(context: OrchestratorContext): AsyncGenerator<OutputChunk> {
    if (!this.phase1Output || !this.designIndex) {
      yield { type: 'status', content: 'No architecture available, skipping system test.' };
      return;
    }

    const passedModules = this.workflowState?.moduleStatuses.filter(m => m.status === 'done') ?? [];
    if (passedModules.length < 2) {
      yield { type: 'status', content: 'Fewer than 2 passing modules, skipping system test.' };
      return;
    }

    const ctx = this.buildStageContext(context);

    // v3: Auto-generate top module before ST
    if (this.phase1Output.topPorts?.length) {
      for (const topName of this.phase1Output.topModules) {
        await this.logWorkflow(context, 'TOP_GEN', 'start', `module=${topName}`);
        for await (const chunk of generateTopModule(ctx, this.phase1Output, topName, context.hdlStandard)) {
          yield chunk;
        }
        await this.logWorkflow(context, 'TOP_GEN', 'done', `module=${topName}`);
      }
    }

    const topModule = this.designIndex.topModules[0] ?? 'top';
    const stReqs = JSON.stringify(this.phase1Output.stVerification);
    const allPorts: Array<{ name: string; ports: PortDef[] }> =
      this.designIndex.modules.map(m => ({ name: m.name, ports: m.ports }));
    const contracts = this.phase1Output.interfaceContracts;

    await this.logWorkflow(context, 'VE_ST', 'start', `top=${topModule}`);
    for await (const chunk of generateSTTestbench(ctx, stReqs, allPorts, topModule, contracts, this.phase1Output.globalParameters)) {
      yield chunk;
    }

    // Run ST simulation
    if (context.executeAction) {
      try {
        const result = await context.executeAction({
          type: 'runSimulation',
          payload: { testType: 'st' },
        });
        if (result.includes('TEST PASSED') || result.includes('PASSED')) {
          await this.logWorkflow(context, 'VE_ST', 'done', 'result=PASSED');
          yield { type: 'status', content: 'System test PASSED' };
        } else {
          await this.logWorkflow(context, 'VE_ST', 'done', 'result=FAILED');
          yield { type: 'status', content: 'System test FAILED.' };

          // v3: ST triage — determine failure source
          yield* this.runSTTriage(ctx, result, context);
        }
      } catch (err) {
        yield { type: 'status', content: `System test skipped: ${err instanceof Error ? err.message : String(err)}` };
      }
    }
  }

  // ── ST Triage (v3) ──

  /** Max ST triage → fix → re-test iterations before giving up. */
  private static readonly ST_TRIAGE_MAX_ROUNDS = 3;

  private async *runSTTriage(
    ctx: StageContext,
    stOutput: string,
    context: OrchestratorContext,
  ): AsyncGenerator<OutputChunk> {
    if (!this.phase1Output || !this.designIndex) return;

    for (let stRound = 0; stRound < Orchestrator.ST_TRIAGE_MAX_ROUNDS; stRound++) {
      yield { type: 'progress', content: `Triaging system test failure (round ${stRound + 1})...` };

      // Read top module code
      const topModuleName = this.designIndex.topModules[0] ?? 'top';
      let topModuleCode = '';
      try {
        topModuleCode = await ctx.readFile(`hw/src/hdl/${topModuleName}.sv`);
      } catch {
        try {
          topModuleCode = await ctx.readFile(`hw/src/hdl/${topModuleName}.v`);
        } catch {
          topModuleCode = '(top module code not available)';
        }
      }

      const subModulePorts: Array<{ name: string; ports: PortDef[] }> =
        this.designIndex.modules.map(m => ({ name: m.name, ports: m.ports }));

      const messages = buildSTTriageMessages(stOutput, topModuleCode, subModulePorts);
      const response = await ctx.llm.complete(messages, { temperature: 0.2 });

      // Parse triage result
      let triage: STTriageDiagnosis | null = null;
      try {
        const text = response.content;
        const jsonMatch = text.match(/\{[\s\S]*?"fix_location"[\s\S]*?\}/);
        if (jsonMatch) {
          triage = JSON.parse(jsonMatch[0]) as STTriageDiagnosis;
        }
      } catch { /* parse failed */ }

      if (!triage) {
        yield { type: 'status', content: 'ST triage parse failed. Manual investigation needed.' };
        return;
      }

      yield { type: 'status', content: `ST triage: ${triage.fix_location} — ${triage.diagnosis}` };

      // ── Route A: sub-module logic issue → enter that module's debug loop ──
      if (triage.fix_location === 'module' && triage.module_name) {
        const mod = this.workflowState?.moduleStatuses.find(m => m.name === triage!.module_name);
        if (!mod) {
          yield { type: 'status', content: `Module "${triage.module_name}" not found in module list.` };
          return;
        }

        yield { type: 'status', content: `Entering debug loop for module "${mod.name}"...` };
        // Reset debug counters for the ST-triggered debug round
        mod.sameErrorRetries = 0;
        mod.totalIterations = 0;
        mod.status = 'testing';
        // Prepend triage diagnosis so Designer knows what to look for in this module
        const stErrorWithDiagnosis = `[ST Triage] ${triage.diagnosis}\n\n${stOutput}`;
        yield* this.debugLoop(mod, stErrorWithDiagnosis, context);

        if ((mod.status as string) !== 'done') {
          yield { type: 'status', content: `Debug loop for "${mod.name}" did not resolve. Manual intervention needed.` };
          return;
        }

        // Module fixed — re-run ST to check
        yield { type: 'status', content: 'Module fixed. Re-running system test...' };
        const reSimResult = await this.rerunST(context);
        if (!reSimResult) return; // sim tool unavailable
        if (reSimResult.includes('TEST PASSED') || reSimResult.includes('PASSED')) {
          yield { type: 'status', content: 'System test PASSED after fix.' };
          return;
        }
        // Still failing — loop back to triage with new output
        stOutput = reSimResult;
        yield { type: 'status', content: 'System test still failing after module fix. Re-triaging...' };
        continue;
      }

      // ── Route B: connection/contract issue → P1 revision → re-generate top → re-ST ──
      if (triage.fix_location === 'connection') {
        yield { type: 'status', content: 'Connection issue detected. Revising P1 architecture...' };

        const oldP1 = this.phase1Output;
        const revisionFeedback = `System test failure due to connection issue: ${triage.diagnosis}. Fix the interface contracts and/or module connections accordingly.`;

        // Use architect-p1 revision to fix contracts
        const prevJSON = JSON.stringify(oldP1, null, 2);
        const revisionMessages = buildArchitectP1RevisionMessages(prevJSON, revisionFeedback);
        const revResponse = await ctx.llm.complete(revisionMessages, { temperature: 0.3 });

        let newP1: ArchitectPhase1Output | null = null;
        try {
          newP1 = parsePhase1Response(revResponse);
        } catch {
          yield { type: 'status', content: 'Failed to parse revised P1. Manual intervention needed.' };
          return;
        }

        // Apply incremental rebuild
        const diff = this.diffPhase1(oldP1, newP1);
        yield { type: 'status', content: `P1 revised: ${diff.unchanged.length} unchanged, ${diff.changed.length} changed, ${diff.added.length} added, ${diff.removed.length} removed` };
        this.phase1Output = newP1;
        this.designIndex = convertToDesignIndex(newP1);
        context.designIndex = this.designIndex;
        this.applyIncrementalRebuild(diff, newP1);

        // Re-generate design_params if needed
        if (diff.globalParamsChanged) {
          for await (const chunk of generateDesignParams(ctx, newP1, context.hdlStandard)) {
            yield chunk;
          }
        }

        // Re-generate top module
        if (newP1.topPorts?.length) {
          for (const topName of newP1.topModules) {
            for await (const chunk of generateTopModule(ctx, newP1, topName, context.hdlStandard)) {
              yield chunk;
            }
          }
        }

        // Re-run any changed/added modules through RTL pipeline
        const pendingMods = this.workflowState?.moduleStatuses.filter(m => m.status === 'pending') ?? [];
        if (pendingMods.length > 0) {
          yield { type: 'status', content: `Re-building ${pendingMods.length} affected module(s)...` };
          yield* this.runRTLPipeline(context);
        }

        // Re-run ST
        yield { type: 'status', content: 'Re-running system test after P1 revision...' };
        const reSimResult = await this.rerunST(context);
        if (!reSimResult) return;
        if (reSimResult.includes('TEST PASSED') || reSimResult.includes('PASSED')) {
          yield { type: 'status', content: 'System test PASSED after P1 revision.' };
          return;
        }
        stOutput = reSimResult;
        yield { type: 'status', content: 'System test still failing after P1 revision. Re-triaging...' };
        continue;
      }

      // ── Route C: unknown → VCD fallback ──
      yield { type: 'status', content: 'Cannot determine failure source. Adding VCD dump for signal tracing...' };
      const topModName = this.designIndex.topModules[0] ?? 'top';
      await addVCDToTB(ctx, topModName, []);
      const vcdSimResult = await this.rerunST(context);
      if (!vcdSimResult) return;
      if (vcdSimResult.includes('TEST PASSED') || vcdSimResult.includes('PASSED')) {
        yield { type: 'status', content: 'System test PASSED (unexpected after VCD add).' };
        return;
      }
      // Feed VCD-enriched output back into triage for a more informed diagnosis
      stOutput = vcdSimResult;
      yield { type: 'status', content: 'VCD captured. Re-triaging with waveform data...' };
      continue;
    }

    yield { type: 'status', content: `ST triage exhausted after ${Orchestrator.ST_TRIAGE_MAX_ROUNDS} rounds. Manual intervention needed.` };
  }

  /** Re-run system test simulation and return output, or null if tool unavailable. */
  private async rerunST(context: OrchestratorContext): Promise<string | null> {
    if (!context.executeAction) return null;
    try {
      return await context.executeAction({
        type: 'runSimulation',
        payload: { testType: 'st' },
      });
    } catch (err) {
      return `Simulation error: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  // -----------------------------------------------------------------------
  // Stage: BE (synthesis)
  // -----------------------------------------------------------------------

  private async *runBE(context: OrchestratorContext): AsyncGenerator<OutputChunk> {
    // Confirmation gate
    if (!context.autoMode && context.askUser) {
      const answer = await context.askUser('Proceed with synthesis? (y/n)');
      if (!/^y/i.test(answer.trim())) {
        yield { type: 'status', content: 'Synthesis skipped.' };
        return;
      }
    }

    const ctx = this.buildStageContext(context);
    for await (const chunk of runBEStage(ctx)) {
      yield chunk;
    }
  }

  // -----------------------------------------------------------------------
  // Stage: Summary
  // -----------------------------------------------------------------------

  private async *runSummary(_context: OrchestratorContext): AsyncGenerator<OutputChunk> {
    if (!this.workflowState) {
      yield { type: 'status', content: 'No workflow state for summary.' };
      return;
    }

    for (const chunk of generateSummary(this.workflowState)) {
      yield chunk;
    }
  }

  // -----------------------------------------------------------------------
  // v3: Incremental rebuild on P1 revision
  // -----------------------------------------------------------------------

  /**
   * Diff old vs new P1 output and determine which modules need rebuild.
   * Returns lists of unchanged, changed, added, and removed modules.
   */
  private diffPhase1(
    oldP1: ArchitectPhase1Output,
    newP1: ArchitectPhase1Output,
  ): {
    unchanged: string[];
    changed: string[];
    added: string[];
    removed: string[];
    globalParamsChanged: boolean;
  } {
    const oldModMap = new Map(oldP1.modules.map(m => [m.name, m]));
    const newModMap = new Map(newP1.modules.map(m => [m.name, m]));

    const unchanged: string[] = [];
    const changed: string[] = [];
    const added: string[] = [];
    const removed: string[] = [];

    for (const [name, newMod] of newModMap) {
      const oldMod = oldModMap.get(name);
      if (!oldMod) {
        added.push(name);
      } else {
        // Compare ports serialization
        const oldPorts = JSON.stringify(oldMod.ports);
        const newPorts = JSON.stringify(newMod.ports);
        if (oldPorts === newPorts && oldMod.description === newMod.description) {
          unchanged.push(name);
        } else {
          changed.push(name);
        }
      }
    }

    for (const name of oldModMap.keys()) {
      if (!newModMap.has(name)) {
        removed.push(name);
      }
    }

    const globalParamsChanged =
      JSON.stringify(oldP1.globalParameters ?? {}) !== JSON.stringify(newP1.globalParameters ?? {});

    return { unchanged, changed, added, removed, globalParamsChanged };
  }

  /**
   * Apply incremental rebuild after P1 revision.
   * Keeps unchanged modules, resets changed/added, removes deleted.
   */
  private applyIncrementalRebuild(
    diff: ReturnType<Orchestrator['diffPhase1']>,
    newP1: ArchitectPhase1Output,
  ): void {
    if (!this.workflowState) return;

    const oldStatuses = new Map(
      this.workflowState.moduleStatuses.map(m => [m.name, m]),
    );
    const topSet = new Set(newP1.topModules);

    // Build new module statuses
    const newStatuses: ModuleStatus[] = newP1.dependencyOrder
      .filter(name => !topSet.has(name) || !newP1.topPorts?.length)
      .map(name => {
        const existing = oldStatuses.get(name);
        if (diff.unchanged.includes(name)) {
          // Keep existing status
          if (existing && (existing.status === 'done' || existing.status === 'skipped')) {
            return existing;
          }
        }
        // Changed, added, or was pending — reset (preserve file path from existing if available)
        return {
          name,
          file: existing?.file ?? `hw/src/hdl/${name}.v`,
          lintPassed: false,
          utPassed: false,
          sameErrorRetries: 0,
          totalIterations: 0,
          tbSuspectCount: 0,
          status: 'pending' as const,
          lintAttempts: 0,
          veCompileAttempts: 0,
          debugHistory: [],
        };
      });

    this.workflowState.moduleStatuses = newStatuses;
    this.workflowState.currentModuleIndex = 0;

    // Clear p2Outputs for changed/removed modules
    for (const name of [...diff.changed, ...diff.removed]) {
      this.phase2Outputs.delete(name);
      if (this.workflowState.p2Outputs) {
        delete this.workflowState.p2Outputs[name];
      }
    }
  }

  // -----------------------------------------------------------------------
  // StageContext builder (bridges OrchestratorContext → StageContext)
  // -----------------------------------------------------------------------

  private buildStageContext(context: OrchestratorContext): StageContext {
    return {
      llm: this.backend,
      projectPath: context.projectPath ?? '.',
      designIndex: this.designIndex ?? context.designIndex ?? {
        modules: [],
        hierarchy: [],
        topModules: [],
        timestamp: new Date().toISOString(),
      },
      phase1Output: this.phase1Output ?? undefined,
      autoMode: context.autoMode,
      filelistPath: context.filelistPath ?? DEFAULT_FILELIST,
      executeAction: context.executeAction
        ? (action: Action) => context.executeAction!(action)
        : async () => '',
      askUser: context.askUser
        ? (question: string) => context.askUser!(question)
        : async () => 'y',
      readFile: context.readFile
        ? (path: string) => context.readFile!(path)
        : async () => { throw new Error('readFile not available'); },
      saveState: context.saveState
        ? (state: WorkflowState) => context.saveState!(state)
        : async () => {},
      logTrace: context.logLLMTrace,
      signal: context.signal,
    };
  }

  // -----------------------------------------------------------------------
  // Helpers
  // -----------------------------------------------------------------------

  private getDependentModulePorts(moduleName: string): Array<{ name: string; ports: PortDef[] }> {
    if (!this.designIndex || !this.phase1Output) return [];

    // Find which modules this module instantiates
    const moduleBrief = this.phase1Output.modules.find(m => m.name === moduleName);
    if (!moduleBrief) return [];

    return moduleBrief.instances
      .map(inst => {
        const dep = this.designIndex!.modules.find(m => m.name === inst.moduleName);
        return dep ? { name: dep.name, ports: dep.ports } : null;
      })
      .filter((x): x is { name: string; ports: PortDef[] } => x !== null);
  }

  private async checkModuleSize(mod: ModuleStatus, context: OrchestratorContext): Promise<void> {
    if (!context.readFile) return;
    try {
      const content = await context.readFile(mod.file);
      const lineCount = content.split('\n').length;
      if (lineCount > MODULE_LINE_LIMIT) {
        if (context.autoMode) {
          // Log warning but don't block
        } else if (context.askUser) {
          await context.askUser(
            `Warning: ${mod.name} is ${lineCount} lines (limit: ${MODULE_LINE_LIMIT}). Consider splitting. Continue? (y)`,
          );
        }
      }
    } catch {
      // File read failure is non-fatal
    }
  }

  /**
   * v3: Detect if simulation output is a compile error (not a runtime failure).
   * Compile errors have no runtime output (no TEST PASSED/FAILED, no checker lines).
   */
  private isCompileError(simOutput: string): boolean {
    const lower = simOutput.toLowerCase();
    // Compile error indicators from various EDA tools (iverilog, verilator, etc.)
    const compilePatterns = [
      'syntax error',
      'compilation error',
      'undeclared',
      'undefined module',
      'cannot find',
      'include file',        // iverilog: "Include file X not found"
      'not found',           // generic "file not found", "module not found"
      'no such file',        // OS-level file not found
      'could not open',      // file open failure
      'i give up',           // iverilog fatal
      'no top level modules', // iverilog: no valid modules compiled
      'unable to bind',      // iverilog: unresolved reference
      'unknown module type', // iverilog: missing module definition
      'error(s) during elaboration', // iverilog elaboration errors
    ];
    const hasCompileIndicators = compilePatterns.some(p => lower.includes(p));
    // Runtime output means simulation actually ran (not a compile failure)
    const hasRuntimeOutput =
      lower.includes('test passed') ||
      lower.includes('test failed') ||
      /\btime\s*=?\s*\d/.test(lower) ||    // simulation time markers
      lower.includes('$finish') ||
      lower.includes('vcd info');           // VCD dump started = sim ran
    return hasCompileIndicators && !hasRuntimeOutput;
  }

  /**
   * Drain an infrastructure debug async generator, yielding all progress
   * chunks and returning the final InfraDebugResult.
   */
  private async *drainInfraDebug(
    gen: AsyncGenerator<OutputChunk, import('../stages/infra-debug.js').InfraDebugResult>,
  ): AsyncGenerator<OutputChunk, import('../stages/infra-debug.js').InfraDebugResult> {
    while (true) {
      const { value, done } = await gen.next();
      if (done) return value;
      yield value;
    }
  }

  /**
   * Detect lint errors that are inherently infrastructure issues regardless
   * of which file they reference. These can never be fixed by editing RTL code.
   *
   * Examples: MODDUP (duplicate module — filelist includes same file twice),
   * file not found, missing include path, etc.
   */
  private isInfrastructureLintError(lintOutput: string): boolean {
    const lower = lintOutput.toLowerCase();
    const infraPatterns = [
      'moddup',                      // verilator: duplicate module definition
      'already defined',             // iverilog: module already defined
      'duplicate definition',        // generic: duplicate module
      'was already defined',         // iverilog variant
      'file not found',              // missing file
      'no such file',                // missing file (unix-style)
      'cannot open',                 // file access issue
      'cannot find.*include',        // missing include
      'include file.*not found',     // iverilog include error
      'no top level modules',        // no modules in filelist
      'unable to open',              // file access
    ];
    return infraPatterns.some(p => new RegExp(p, 'i').test(lower));
  }

  /**
   * Check if a lint error references the current module's file.
   * Returns true if at least one error line mentions the module filename.
   * If false, the error is from non-RTL sources (design_params, filelist, deps).
   */
  private isModuleLintError(lintOutput: string, moduleName: string): boolean {
    const errorLineRe = /error|warning|syntax|undeclared|not found|unable/i;
    const moduleFileRe = new RegExp(`\\b${moduleName}\\.s?v\\b`);

    for (const line of lintOutput.split('\n')) {
      if (!errorLineRe.test(line)) continue;
      if (moduleFileRe.test(line)) return true;
    }
    return false;
  }

  /**
   * Normalize lint error for same-error comparison.
   * Strips file paths, line/column numbers so that the same error type
   * (e.g. MODDUP) is recognized as identical even when line numbers change
   * after a Designer "fix" attempt.
   */
  private normalizeLintError(error: string): string {
    return error
      .replace(/[\w/.~-]+\.s?vh?\s*:\s*\d+(?:\s*:\s*\d+)?/g, 'FILE:N') // file.v:15:3 → FILE:N
      .replace(/line\s+\d+/gi, 'line N')                                 // "line 15" → "line N"
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 500);
  }

  /**
   * Classify compile error source: RTL file, TB/TC file, or unknown.
   * Extracts "file:line:" patterns from error output to determine which role should fix.
   */
  private classifyCompileError(simOutput: string): 'rtl' | 'tb' | 'unknown' {
    // Extract file references from error lines (format: "path/file.ext:line:" or "In file path/file.ext")
    // Only consider lines with actual error/warning indicators
    const errorLineRe = /error|warning|syntax|undeclared|not found|unable/i;
    // Match file paths ending in .v or .sv with a line number (typical EDA error format)
    const fileRefRe = /([\w/._-]+\.s?v)\s*:\s*\d+/g;

    const rtlFiles = new Set<string>();
    const tbFiles = new Set<string>();

    for (const line of simOutput.split('\n')) {
      if (!errorLineRe.test(line)) continue;

      let match: RegExpExecArray | null;
      fileRefRe.lastIndex = 0;
      while ((match = fileRefRe.exec(line)) !== null) {
        const filePath = match[1];
        // Classify by path: hw/src/ = RTL, hw/dv/ = TB/TC
        if (/hw\/src\//.test(filePath)) {
          rtlFiles.add(filePath);
        } else if (/hw\/dv\//.test(filePath) || /\btb_/.test(filePath) || /\btc_/.test(filePath)) {
          tbFiles.add(filePath);
        }
        // Files not matching either pattern are ignored (won't affect classification)
      }
    }

    if (rtlFiles.size > 0 && tbFiles.size === 0) return 'rtl';
    if (tbFiles.size > 0 && rtlFiles.size === 0) return 'tb';
    return 'unknown';
  }

  /**
   * Convert VCD timescale string (e.g. "1ns", "10ps", "100us") to nanoseconds per unit.
   * Returns how many ns one VCD time unit represents.
   */
  private parseTimescaleToNs(timescale: string): number {
    const match = timescale.match(/(\d+)\s*(s|ms|us|ns|ps|fs)/i);
    if (!match) return 1; // default: assume 1ns
    const value = parseInt(match[1], 10);
    const unit = match[2].toLowerCase();
    const unitToNs: Record<string, number> = {
      's': 1e9, 'ms': 1e6, 'us': 1e3, 'ns': 1, 'ps': 1e-3, 'fs': 1e-6,
    };
    return value * (unitToNs[unit] ?? 1);
  }

  /** Extract failing TC filename from simulation output (e.g. "FAILING_TC: tc_counter_basic.sv") */
  private extractFailingTC(simOutput: string): string | undefined {
    const match = simOutput.match(/FAILING_TC:\s*(\S+)/);
    return match ? match[1] : undefined;
  }

  private normalizeError(error: string): string {
    return error
      .replace(/time\s+\d+/gi, 'time N')          // simulation timestamps
      .replace(/#\s*\d+/g, '# N')                  // delay values
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 500);
  }

  private compressHistory(context: OrchestratorContext): void {
    if (context.history.length <= HISTORY_MAX_MESSAGES) return;

    const systemMsgs = context.history.filter(m => m.role === 'system');
    const nonSystem = context.history.filter(m => m.role !== 'system');
    if (nonSystem.length <= HISTORY_TRIM_TO) return;

    const trimmed = nonSystem.slice(0, nonSystem.length - HISTORY_TRIM_TO);
    const kept = nonSystem.slice(nonSystem.length - HISTORY_TRIM_TO);

    const summaryMsg: ChatMessage = {
      role: 'system',
      content: `[Conversation summary - ${trimmed.length} earlier messages condensed]`,
    };

    context.history.length = 0;
    context.history.push(...systemMsgs, summaryMsg, ...kept);
  }

  private async persistState(context: OrchestratorContext): Promise<void> {
    if (this.workflowState && context.saveState) {
      this.workflowState.lastUpdated = new Date().toISOString();
      await context.saveState(this.workflowState);
    }
  }

  private describeState(state: WorkflowState): string {
    const currentStep = state.plan.steps.find(s => s.status === 'running');
    if (currentStep) {
      const modInfo = state.moduleStatuses.length > 0
        ? ` (${state.currentModuleIndex}/${state.moduleStatuses.length} modules)`
        : '';
      return `${currentStep.description}${modInfo}`;
    }
    return 'Unknown state';
  }
}
