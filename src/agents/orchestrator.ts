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
  type AttemptRecord,
  type DesignIndex,
  type FailureReport,
  type FailurePatternKind,
  type PartialAttemptRecord,
  type PastRevisionEntry,
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
  DEFAULT_REVISION_BUDGET,
  WORKFLOW_STATE_SCHEMA_VERSION,
} from './types.js';
import {
  attemptToLogString,
  detectOscillation,
  newAttemptRecord,
} from '../utils/attempt-record.js';
import { extractErrorSignature } from '../utils/error-signature.js';
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
import { runArchitectPhase2, runP2Revision } from '../stages/architect-p2.js';
import type { P2RevisionResult } from '../stages/architect-p2.js';
import { writeModule, fixLintErrors, debugFix, selectVCDSignals } from '../stages/rtl-writer.js';
import { generateUTTestbench, reviewTB, addVCDToTB, fixCompileErrors, auditSpecVsChecker } from '../stages/ve-ut.js';
import type { SpecCheckerAuditResult } from '../stages/ve-ut.js';
import { generateSTTestbench } from '../stages/ve-st.js';
import { runBEStage } from '../stages/be.js';
import { generateSummary } from '../stages/summary.js';
import { validatePhase1Structure } from '../stages/structural-validation.js';
import { generateDesignParams } from '../stages/design-params-gen.js';
import { generateTopModule, buildTopModuleContent } from '../stages/top-gen.js';
import { runInfraDebug } from '../stages/infra-debug.js';
import { selfDiagnose, formatDiagnosisAsHint } from '../stages/self-diagnose.js';
import { VCDParser } from '../parser/vcd-parser.js';
import { parseCheckerOutput } from '../parser/checker-parser.js';
import { parseSimResult } from '../parser/sim-result.js';
import { DebugBudget } from './debug-budget.js';
import {
  buildSTTriageMessages,
  buildArchitectP1RevisionMessages,
  getRelevantContracts,
} from './context-builder.js';

// Re-export for consumers
export type { OutputChunk, LLMTraceEntry };
export type OutputChunkType = OutputChunk['type'];
import { formatAttemptHistoryForPrompt } from '../utils/attempt-record.js';

/**
 * v4 Phase 2b: control-flow signal returned by handleDebugExhausted.
 * Caller (debugLoop / runUTWithDebugLoop) must honor:
 *   - 'recovered'         counters reset; re-enter the debug loop
 *   - 'redo_requested'    P2 spec revised + module reset; outer pipeline
 *                         loop should decrement its index and re-iterate
 *                         this module from RTL_WRITE
 *   - 'manual_escalation' no recovery possible; caller should set
 *                         mod.status='failed' and propagate
 */
export type ExhaustOutcome = 'recovered' | 'redo_requested' | 'manual_escalation';

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
  debugConfig?: {
    sameErrorMaxRetries?: number;
    totalIterationCap?: number;
    vcdFallbackThreshold?: number;
    compileSameErrorCap?: number;
    compileTotalCap?: number;
    tbSuspectCap?: number;
  };
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_FILELIST = 'hw/src/filelist/design.f';
const MODULE_LINE_LIMIT = 1024;
const HISTORY_MAX_MESSAGES = 60;
const HISTORY_TRIM_TO = 20;
const LINT_ATTEMPT_CAP = 4;
const VE_COMPILE_ATTEMPT_CAP = 4;
const INFRA_DEBUG_MAX_ROUNDS = 8;
// Debug-loop iteration / same-error / VCD / compile / tb_suspect caps live in DebugBudget.

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

  /**
   * Log a workflow phase transition event (near-zero cost, file append only).
   * Pass `'_global'` for module-unaware phases (P1, validation, design_params).
   */
  private async logWorkflow(
    context: OrchestratorContext,
    moduleName: string,
    phase: string,
    status: 'start' | 'done' | 'skip' | 'fail',
    detail?: string,
  ): Promise<void> {
    if (!context.logLLMTrace) return;
    await context.logLLMTrace({
      timestamp: new Date().toISOString(),
      role: 'Orchestrator',
      module: moduleName,
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
        schemaVersion: WORKFLOW_STATE_SCHEMA_VERSION,
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
    await this.logWorkflow(context, '_global', 'P1', 'start');
    const ctx = this.buildStageContext(context);
    const requirement = this.workflowState!.plan.goal;

    for await (const chunk of runArchitectPhase1(ctx, requirement)) {
      // Capture the phase1Output from metadata
      if (chunk.type === 'status' && chunk.metadata?.phase1Output) {
        this.phase1Output = chunk.metadata.phase1Output as ArchitectPhase1Output;

        // v3: Structural validation sanity check. architect-p1 now also runs
        // this inside its parse-retry loop and will not emit a phase1Output if
        // validation fails there. This block is a last-resort safety net — if
        // something slips through, fail loud instead of proceeding with a bad
        // design.
        await this.logWorkflow(context, '_global', 'P1', 'done', `modules=${this.phase1Output.dependencyOrder.length} contracts=${this.phase1Output.interfaceContracts?.length ?? 0}`);
        await this.logWorkflow(context, '_global', 'validation', 'start');
        const validation = validatePhase1Structure(this.phase1Output);
        if (validation.warnings.length > 0) {
          yield {
            type: 'progress',
            content: `Structural warnings:\n${validation.warnings.map(w => `  ⚠ ${w}`).join('\n')}`,
          };
        }
        if (!validation.valid) {
          await this.logWorkflow(context, '_global', 'validation', 'fail', `errors=${validation.errors.length}`);
          yield {
            type: 'error',
            content: `Structural validation errors (architect-p1 retries exhausted):\n${validation.errors.map(e => `  - ${e}`).join('\n')}`,
          };
          // Clear phase1Output so downstream stages don't act on a bad design.
          this.phase1Output = null;
          return;
        }

        await this.logWorkflow(context, '_global', 'validation', 'done', `errors=0 warnings=${validation.warnings.length}`);

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
              attemptHistory: [],
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
    await this.logWorkflow(context, '_global', 'design_params', 'start');
    for await (const chunk of generateDesignParams(ctx, this.phase1Output, context.hdlStandard)) {
      yield chunk;
    }
    await this.logWorkflow(context, '_global', 'design_params', 'done');
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

      // v4 Phase 2b: track whether the UT debug loop requested a P2 redo for
      // this module — if so we re-iterate with the (already-installed) revised
      // spec rather than advancing.
      let redoRequested = false;
      try {
        // ── Phase 2: detailed design ──
        yield* this.runArchitectP2ForModule(mod, context);

        // ── RTL write ──
        yield* this.runRTLWrite(mod, context);
        if ((mod.status as string) === 'failed' || (mod.status as string) === 'skipped') {
          this.backfillRevisionOutcome(mod, 'no_progress');
          continue;
        }

        // ── Lint ──
        yield* this.runLint(mod, context);
        if ((mod.status as string) === 'failed' || (mod.status as string) === 'skipped') {
          this.backfillRevisionOutcome(mod, 'no_progress');
          continue;
        }

        // ── UT generation + simulation + debug loop ──
        const utOutcome = yield* this.runUTWithDebugLoop(mod, context);
        if (utOutcome === 'redo_requested') {
          redoRequested = true;
        }
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
        this.backfillRevisionOutcome(mod, 'no_progress');
        yield { type: 'error', content: `Module "${mod.name}" failed: ${errMsg}` };
      }

      // v4 Phase 2b: handle P2 redo signal — re-iterate this module with the
      // revised spec (mod has already been reset by tryP2Redo).
      if (redoRequested) {
        await this.persistState(context);
        i--;
        continue;
      }

      // v4 Phase 2b: backfill any in-flight pastRevisions entry for this
      // module based on terminal status. Idempotent / no-op when no revision
      // is in flight. Casts via `as string` mirror the existing pattern in
      // this loop (TS narrows mod.status from the early-skip check above and
      // doesn't widen across async yields).
      if ((mod.status as string) === 'done') this.backfillRevisionOutcome(mod, 'resolved');
      else if ((mod.status as string) === 'failed') this.backfillRevisionOutcome(mod, 'no_progress');

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
    await this.logWorkflow(context, mod.name, 'P2', 'start', `module=${mod.name}`);
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
    await this.logWorkflow(context, mod.name, 'P2', 'done', `module=${mod.name}`);
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
    await this.logWorkflow(context, mod.name, 'RTL_WRITE', 'start', `module=${mod.name}`);

    // v3: Pass relevant interface contracts to RTL writer
    const contracts = this.phase1Output?.interfaceContracts
      ? getRelevantContracts(this.phase1Output.interfaceContracts, mod.name)
      : undefined;

    let writeHadError = false;
    const writeGen = writeModule(ctx, phase2, depPorts, context.hdlStandard, contracts, undefined, this.phase1Output?.designRationale);
    while (true) {
      const { value, done } = await writeGen.next();
      if (done) {
        if (value) this.recordAttempt(mod, value);
        break;
      }
      if (value.type === 'error') writeHadError = true;
      yield value;
    }

    // If RTL generation produced no code, stop the pipeline for this module
    if (writeHadError) {
      mod.status = 'failed';
      await this.logWorkflow(context, mod.name, 'RTL_WRITE', 'fail', `module=${mod.name} no_code`);
      return;
    }

    // Module size check
    await this.checkModuleSize(mod, context);
    await this.logWorkflow(context, mod.name, 'RTL_WRITE', 'done', `module=${mod.name} file=${mod.file}`);
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
    await this.logWorkflow(context, mod.name, 'LINT', 'start', `module=${mod.name}`);
    yield { type: 'progress', content: `Linting ${mod.name}...` };

    const ctx = this.buildStageContext(context);
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
        await this.logWorkflow(context, mod.name, 'LINT', 'done', `module=${mod.name} clean attempt=${mod.lintAttempts}`);
        yield { type: 'status', content: `Lint passed: ${mod.name}` };
        mod.lintPassed = true;
        return;
      }

      mod.lintAttempts++;

      // Track same-error for escalation (normalizeError strips file:line and other noise)
      const normalized = this.normalizeError(lintResult);
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
        if (!resolved) { mod.lintPassed = false; mod.status = 'failed'; return; }
        continue;
      }

      // ── Same error type 2 consecutive rounds → infrastructure ──
      if (sameLintErrorCount >= 2) {
        const resolved = yield* this.escalateLintToInfra(ctx, mod, lintResult, infraEscalations,
          `same error persisted ${sameLintErrorCount} rounds`);
        infraEscalations++;
        if (!resolved) { mod.lintPassed = false; mod.status = 'failed'; return; }
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
          const writeRecord = yield* writeModule(ctx, phase2, depPorts, context.hdlStandard, undefined, mod.attemptHistory, this.phase1Output?.designRationale);
          if (writeRecord) this.recordAttempt(mod, writeRecord);
        }
        continue;
      }

      // ── Total cap (attempt 8) → infrastructure ──
      if (mod.lintAttempts >= LINT_ATTEMPT_CAP * 2) {
        const resolved = yield* this.escalateLintToInfra(ctx, mod, lintResult, infraEscalations,
          `${mod.lintAttempts} total attempts exhausted`);
        infraEscalations++;
        if (!resolved) { mod.lintPassed = false; mod.status = 'failed'; return; }
        continue;
      }

      // ── Normal Designer fix ──
      await this.logWorkflow(context, mod.name, 'LINT_FIX', 'start', `module=${mod.name} attempt=${mod.lintAttempts}`);
      yield { type: 'status', content: `Lint errors in ${mod.name} (attempt ${mod.lintAttempts}), fixing...` };
      const lintFixResult = await fixLintErrors(ctx, mod.name, lintResult, context.hdlStandard, mod.attemptHistory);
      this.recordAttempt(mod, lintFixResult.record);
      if (!lintFixResult.ok) {
        // Designer produced no code → escalate to infrastructure (not give up)
        yield { type: 'status', content: `Designer produced no fix for ${mod.name} lint error, escalating...` };
        const resolved = yield* this.escalateLintToInfra(ctx, mod, lintResult, infraEscalations,
          'Designer produced no fix');
        infraEscalations++;
        if (!resolved) { mod.lintPassed = false; mod.status = 'failed'; return; }
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

    // v4: feed oscillation hint to infra-debug so it doesn't blindly inherit
    // the surface error and try yet another tactical fix.
    const osc = detectOscillation(mod.attemptHistory);
    const infraResult = yield* this.drainInfraDebug(
      runInfraDebug(ctx, mod.name, lintResult, 'compile', undefined, osc.hint || undefined),
    );
    this.recordEvent(
      mod,
      'infra_debug',
      'infra',
      infraResult.resolved
        ? `infra-debug resolved lint: ${infraResult.summary.slice(0, 200)}`
        : `infra-debug failed lint: ${infraResult.summary.slice(0, 200)}`,
      lintResult,
    );
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
  ): AsyncGenerator<OutputChunk, 'redo_requested' | undefined> {
    const ctx = this.buildStageContext(context);
    const phase2 = this.phase2Outputs.get(mod.name);
    const modDef = this.designIndex?.modules.find(m => m.name === mod.name);

    if (!modDef) {
      yield { type: 'error', content: `Module "${mod.name}" not found in design index.` };
      mod.status = 'failed';
      return undefined;
    }

    mod.status = 'testing';
    await this.logWorkflow(context, mod.name, 'VE_UT', 'start', `module=${mod.name}`);

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
      return undefined;
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
      return undefined;
    }

    if (parseSimResult(simResult).verdict === 'pass') {
      mod.utPassed = true;
      mod.status = 'done';
      await this.logWorkflow(context, mod.name, 'VE_UT', 'done', `module=${mod.name} result=PASSED`);
      yield { type: 'status', content: `UT passed: ${mod.name}` };
      return undefined;
    }

    // ── Debug loop ──
    await this.logWorkflow(context, mod.name, 'VE_UT', 'done', `module=${mod.name} result=FAILED`);
    await this.logWorkflow(context, mod.name, 'DEBUG', 'start', `module=${mod.name}`);
    yield { type: 'status', content: `UT failed for ${mod.name}, entering debug loop...` };
    return yield* this.debugLoop(mod, simResult, context);
  }

  // -----------------------------------------------------------------------
  // Debug loop (checker-based, with tb_suspect mechanism)
  // -----------------------------------------------------------------------

  private async *debugLoop(
    mod: ModuleStatus,
    initialSimOutput: string,
    context: OrchestratorContext,
    // v4 Phase 2b: returns 'redo_requested' if a P2 redo was triggered (caller
    // must propagate up so the outer pipeline loop re-iterates the module).
    // Returns undefined for both "module passed" and "module failed
    // terminally" — caller checks mod.status to distinguish.
  ): AsyncGenerator<OutputChunk, 'redo_requested' | undefined> {
    const ctx = this.buildStageContext(context);
    const phase2 = this.phase2Outputs.get(mod.name);
    let currentError = initialSimOutput;
    const budget = new DebugBudget(context.debugConfig, this.normalizeError(initialSimOutput));
    let vcdEnabled = false;
    let vcdData: string | undefined;
    const designRationale = this.phase1Output?.designRationale;

    // ── Spec-Checker Audit: conclusive diagnosis before guessing (max 2 rounds) ──
    let auditResult: SpecCheckerAuditResult | undefined;
    if (phase2?.functionalSpec && parseSimResult(currentError).verdict !== 'compile_error') {
      const MAX_AUDIT_ROUNDS = 2;
      for (let auditRound = 0; auditRound < MAX_AUDIT_ROUNDS; auditRound++) {
        try {
          await this.logWorkflow(context, mod.name, 'SPEC_AUDIT', 'start', `module=${mod.name} round=${auditRound + 1}`);
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
          await this.logWorkflow(context, mod.name, 'SPEC_AUDIT', 'done', `module=${mod.name} ${verdict} round=${auditRound + 1}`);
          yield {
            type: 'status',
            content: `[Spec Audit ${auditRound + 1}] ${auditResult.checkerCorrect ? 'Checker logic matches spec → RTL needs fix' : `Checker mismatch: ${auditResult.mismatch?.slice(0, 200)}`}`,
          };

          // v4: Spec audit verdict / disagreement events are logged via
          // logWorkflow already; we don't duplicate them in attemptHistory
          // (which is reserved for code-modifying attempts). Only the
          // VE's actual TB fix below earns an AttemptRecord.

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
            this.recordEvent(
              mod,
              've_tb_audit_fix',
              'llm',
              `VE fixed TB after spec audit: ${reviewResult.reason?.slice(0, 200) ?? ''}`,
              currentError,
            );
            yield { type: 'status', content: `VE fixed TB based on audit: ${reviewResult.fixedTBPath}` };
          } else {
            // VE disagrees with audit (says TB is correct) — no point re-auditing same TB
            break;
          }

          // Re-simulate after TB fix
          if (!context.executeAction) break;
          const reSimResult = await context.executeAction({
            type: 'runSimulation',
            payload: { module: mod.name, testType: 'ut', regression: true },
          });
          if (parseSimResult(reSimResult).verdict === 'pass') {
            mod.utPassed = true;
            mod.status = 'done';
            await this.logWorkflow(context, mod.name, 'DEBUG', 'done', `module=${mod.name} RESOLVED by spec audit round=${auditRound + 1}`);
            yield { type: 'status', content: `Debug resolved for ${mod.name} — TB checker was incorrect (fixed by spec audit)` };
            return;
          }
          // TB fix didn't fully resolve — update error and loop to re-audit
          currentError = reSimResult;
          budget.reseedFromError(this.normalizeError(reSimResult));
        } catch (err) {
          await this.logWorkflow(context, mod.name, 'SPEC_AUDIT', 'fail', `module=${mod.name} ${err instanceof Error ? err.message : ''}`);
          break;
        }
      }
    }

    while (mod.totalIterations < budget.iterCap) {
      mod.totalIterations++;
      const sameCount = budget.sameCount();

      if (budget.exceededSameError()) {
        const outcome = yield* this.handleDebugExhausted(mod, context);
        if (outcome === 'recovered') {
          budget.resetForNewTC();
          continue;
        }
        if (outcome === 'redo_requested') {
          return 'redo_requested';
        }
        // 'manual_escalation' — set terminal status and return
        mod.status = 'failed';
        return undefined;
      }

      yield {
        type: 'progress',
        content: `Debug iteration ${mod.totalIterations} for ${mod.name} (same-error: ${sameCount}/${budget.sameErrCap})...`,
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
          module: mod.name,
          iteration: mod.totalIterations,
          taskContext: `debug_loop:${mod.name}`,
          summary: `iter=${mod.totalIterations}/${budget.iterCap} same_err=${sameCount}/${budget.sameErrCap} similar_checker=${budget.getConsecutiveSimilar()} lint=${mod.lintAttempts} ve_compile=${mod.veCompileAttempts} tb_suspect=${mod.tbSuspectCount}`,
        });
      }

      // v3.1: Compile error → specific-role fix first, escalate to infrastructure
      const currentSim = parseSimResult(currentError);
      if (currentSim.verdict === 'compile_error') {
        const compileStatus = budget.recordCompileError(this.normalizeError(currentError));
        const { sameCount: compileSameErrorCount, totalCount: compileTotalCount } = compileStatus;

        if (compileStatus.shouldEscalate) {
          // Escalate to Infrastructure Debug Agent
          await this.logWorkflow(context, mod.name, 'DEBUG', 'start', `module=${mod.name} route=infra_debug_compile same=${compileSameErrorCount} total=${compileTotalCount}`);
          yield { type: 'status', content: `Compile fix exhausted (same-error: ${compileSameErrorCount}, total: ${compileTotalCount}) — escalating to Infrastructure Debug Agent...` };

          const oscEsc = detectOscillation(mod.attemptHistory);
          const infraResult = yield* this.drainInfraDebug(
            runInfraDebug(ctx, mod.name, currentError, 'compile', undefined, oscEsc.hint || undefined),
          );
          this.recordEvent(
            mod, 'infra_debug', 'infra',
            infraResult.resolved
              ? `infra-debug resolved compile: ${infraResult.summary.slice(0, 200)}`
              : `infra-debug failed compile: ${infraResult.summary.slice(0, 200)}`,
            currentError,
          );

          if (!infraResult.resolved) {
            yield { type: 'error', content: `Infrastructure Debug Agent could not resolve compile error for ${mod.name}. Manual intervention required.` };
            mod.status = 'failed';
            return;
          }
          // Verify before trusting RESOLVED — agent may have made a placebo edit.
          const verified = yield* this.verifyCompileInfraResolution(context, mod, currentError);
          if (!verified) {
            this.recordEvent(
              mod, 'infra_debug', 'infra',
              'infra-debug claimed RESOLVED but verify sim shows same compile error — downgraded to UNRESOLVED',
              currentError,
            );
            mod.status = 'failed';
            return;
          }
          // Verified clean — reset compile + runtime tracking
          budget.resetCompile();
          budget.resetForNewTC();
        } else {
          // Tier 1: Specific-role fix — route by error source
          const errorSource = currentSim.compileError?.source ?? 'unknown';

          if (errorSource === 'unknown') {
            // Can't determine source → skip Tier 1, go directly to infrastructure
            await this.logWorkflow(context, mod.name, 'DEBUG', 'start', `module=${mod.name} route=infra_debug_compile reason=unknown_source`);
            yield { type: 'status', content: `Compile error source unclear — escalating to Infrastructure Debug Agent...` };

            const oscUnknown = detectOscillation(mod.attemptHistory);
            const infraResult = yield* this.drainInfraDebug(
              runInfraDebug(ctx, mod.name, currentError, 'compile', undefined, oscUnknown.hint || undefined),
            );
            this.recordEvent(
              mod, 'infra_debug', 'infra',
              infraResult.resolved
                ? `infra-debug resolved compile (unknown source): ${infraResult.summary.slice(0, 200)}`
                : `infra-debug failed compile (unknown source): ${infraResult.summary.slice(0, 200)}`,
              currentError,
            );

            if (!infraResult.resolved) {
              yield { type: 'error', content: `Infrastructure Debug Agent could not resolve compile error for ${mod.name}. Manual intervention required.` };
              mod.status = 'failed';
              return;
            }
            // Verify before trusting RESOLVED — agent may have made a placebo edit.
            const verified = yield* this.verifyCompileInfraResolution(context, mod, currentError);
            if (!verified) {
              this.recordEvent(
                mod, 'infra_debug', 'infra',
                'infra-debug claimed RESOLVED (unknown source) but verify sim shows same compile error — downgraded to UNRESOLVED',
                currentError,
              );
              mod.status = 'failed';
              return;
            }
            budget.resetCompile();
            budget.resetForNewTC();
          } else if (errorSource === 'rtl') {
            // RTL compile error → Designer fixes (same as lint fix)
            mod.lintAttempts++;
            await this.logWorkflow(context, mod.name, 'DEBUG', 'start', `module=${mod.name} route=Designer_compile same=${compileSameErrorCount}/${budget.compileSameCap} total=${compileTotalCount}/${budget.compileTotalCap}`);
            yield { type: 'status', content: `RTL compile error detected, routing to Designer for fix (${compileSameErrorCount}/${budget.compileSameCap} same, ${compileTotalCount}/${budget.compileTotalCap} total)...` };
            const fixResult = await fixLintErrors(ctx, mod.name, currentError, context.hdlStandard, mod.attemptHistory);
            this.recordAttempt(mod, { ...fixResult.record, stage: 'rtl_compile_fix' });
            if (!fixResult.ok) {
              yield { type: 'status', content: `Designer compile fix produced no output for ${mod.name}` };
            }
          } else {
            // TB/TC compile error → VE fixes
            mod.veCompileAttempts++;
            await this.logWorkflow(context, mod.name, 'DEBUG', 'start', `module=${mod.name} route=VE_compile same=${compileSameErrorCount}/${budget.compileSameCap} total=${compileTotalCount}/${budget.compileTotalCap}`);
            yield { type: 'status', content: `TB/TC compile error detected, routing to VE for fix (${compileSameErrorCount}/${budget.compileSameCap} same, ${compileTotalCount}/${budget.compileTotalCap} total)...` };
            const fixResult = await fixCompileErrors(ctx, mod.name, currentError, mod.attemptHistory);
            this.recordAttempt(mod, fixResult.record);
            if (!fixResult.ok) {
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

        await this.logWorkflow(context, mod.name, 'DEBUG', 'start', `module=${mod.name} route=designer iter=${mod.totalIterations}`);
        const debugResult = await debugFix(
          ctx,
          mod.name,
          currentError,
          funcDesc,
          verifReqs,
          mod.attemptHistory,
          vcdData,
          designRationale,
        );
        const diagnosis: DebugDiagnosis = debugResult.diagnosis;
        // v4: AttemptRecord now carries fix_summary, errorSig, diff, etc.
        this.recordAttempt(mod, debugResult.record);

        // ── tb_suspect path ──
        if (diagnosis.diagnosis === 'tb_suspect') {
          mod.tbSuspectCount++;

          // Cap: after N tb_suspect rounds, skip VE review and treat as RTL fix
          if (mod.tbSuspectCount > budget.tbSuspectCap) {
            yield { type: 'status', content: `tb_suspect capped (${mod.tbSuspectCount}/${budget.tbSuspectCap}) — TB has been independently reviewed, focusing on RTL.` };
            // Fall through to the fix path below (diagnosis.fixedCode will be falsy, so no-op — next iteration Designer should fix RTL)
          } else {
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
              await this.logWorkflow(context, mod.name, 'DEBUG', 'done', `module=${mod.name} route=tb_suspect result=TB_correct`);
              yield { type: 'status', content: `VE confirms TB is correct: ${veReason.slice(0, 200)}` };
            } else {
              const fixReason = reviewResult.reason ?? '';
              await this.logWorkflow(context, mod.name, 'DEBUG', 'done', `module=${mod.name} route=tb_suspect result=TB_fixed`);
              yield { type: 'status', content: `VE fixed testbench: ${reviewResult.fixedTBPath}${fixReason ? ' — ' + fixReason.slice(0, 150) : ''}` };
              this.recordEvent(
                mod, 've_tb_audit_fix', 'llm',
                `VE fixed TB after tb_suspect: ${fixReason.slice(0, 200)}`,
                currentError,
              );
            }
          }
        } else {
          // ── fix path ──
          if (diagnosis.fixedCode) {
            await this.logWorkflow(context, mod.name, 'DEBUG', 'done', `module=${mod.name} route=designer result=fix target=${diagnosis.targetFile ?? mod.file}`);
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
                  const lintFixRes = await fixLintErrors(ctx, mod.name, lintResult, context.hdlStandard, mod.attemptHistory);
                  this.recordAttempt(mod, lintFixRes.record);
                }
              } catch { /* lint tool unavailable — skip */ }
            }
          } else {
            await this.logWorkflow(context, mod.name, 'DEBUG', 'done', `module=${mod.name} route=designer result=no_code`);
            yield { type: 'status', content: `Debug fix produced no code for ${mod.name}` };
            // Surface a forward-looking directive to next iteration's attemptHistory
            // so the Designer doesn't silently skip again. The recordAttempt above
            // captures the *what* (no code returned); this event adds the *what to do*.
            const noCodeNote = diagnosis.fix_summary
              ? `[orchestrator] previous round returned fix_summary "${diagnosis.fix_summary.slice(0, 200)}" but no fixedCode — provide concrete code this round or flag tb_suspect`
              : `[orchestrator] previous round returned neither fixedCode nor fix_summary — provide concrete fixedCode this round or flag tb_suspect`;
            this.recordEvent(mod, 'rtl_debug_fix', 'unknown', noCodeNote, currentError);
          }
        }
      }

      // Re-sim: run failing TC, then regression if it passes
      if (!context.executeAction) break;

      try {
        const failingTC = parseSimResult(currentError).failingTC;
        const simStartMs = Date.now();
        let result = await context.executeAction({
          type: 'runSimulation',
          payload: { module: mod.name, testType: 'ut', ...(failingTC ? { tc: failingTC } : {}) },
        });
        const simDurationMs = Date.now() - simStartMs;

        let passed = parseSimResult(result).verdict === 'pass';

        // If failing TC now passes, run full regression to catch regressions in other TCs
        if (passed && failingTC) {
          yield { type: 'progress', content: `${failingTC} now passes, running full regression...` };
          const regResult = await context.executeAction({
            type: 'runSimulation',
            payload: { module: mod.name, testType: 'ut' },
          });
          const regSim = parseSimResult(regResult);
          passed = regSim.verdict === 'pass';
          if (!passed) {
            // A different TC failed — switch to debugging that one
            result = regResult;
            // Reset debug state for the new TC
            vcdEnabled = false;
            budget.resetForNewTC();
            mod.sameErrorRetries = 0;
            yield { type: 'status', content: `Regression found new failure: ${regSim.failingTC ?? 'unknown TC'}` };
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
            module: mod.name,
            iteration: mod.totalIterations,
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
          await this.logWorkflow(context, mod.name, 'DEBUG', 'done', `module=${mod.name} RESOLVED iter=${mod.totalIterations}`);
          yield { type: 'status', content: `Debug resolved for ${mod.name} after ${mod.totalIterations} iteration(s)` };
          return;
        }

        // Track error changes
        const trackResult = budget.recordRuntimeError(this.normalizeError(result));
        if (trackResult.isSame) {
          mod.sameErrorRetries++;
        } else {
          mod.sameErrorRetries = 0;
        }
        currentError = result;

        // v3: VCD fallback — trigger, re-sim, and parse in one step
        if (budget.shouldEnableVCD(vcdEnabled)) {
          await this.logWorkflow(context, mod.name, 'DEBUG', 'start', `module=${mod.name} route=VCD_fallback similar=${trackResult.consecutiveSimilar}`);
          yield { type: 'status', content: `${budget.vcdThreshold} consecutive similar errors — enabling VCD for debug...` };
          const vcdAdded = await addVCDToTB(ctx, mod.name, []);
          if (vcdAdded) {
            vcdEnabled = true;
            yield { type: 'progress', content: 'VCD dump added to testbench. Re-simulating to capture waveform...' };
            // Immediate re-sim (failing TC only) to generate VCD file
            if (context.executeAction) {
              try {
                const vcdFailingTC = parseSimResult(currentError).failingTC;
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
          budget.resetConsecutiveSimilar();
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
    const outcome = yield* this.handleDebugExhausted(mod, context);
    if (outcome === 'recovered') {
      // Counters reset — re-enter debug loop by recursion (one level only).
      // Propagate any redo signal from the recursive call up.
      const inner = yield* this.debugLoop(mod, currentError, context);
      return inner;
    }
    if (outcome === 'redo_requested') {
      return 'redo_requested';
    }
    // 'manual_escalation' — set terminal status
    mod.status = 'failed';
    return undefined;
  }

  private async *handleDebugExhausted(
    mod: ModuleStatus,
    context: OrchestratorContext,
  ): AsyncGenerator<OutputChunk, ExhaustOutcome> {
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
    if (mod.attemptHistory.length > 0) {
      summary += `  Attempt history:\n${mod.attemptHistory.map(r => `    ${attemptToLogString(r)}`).join('\n')}`;
    }
    yield { type: 'status', content: summary };

    if (context.autoMode) {
      // v3.1: Auto-mode invokes Infrastructure Debug as the final escalation
      // before giving up — mirroring the compile-error escalation path (which
      // runs infra-debug unconditionally). Without this, auto-mode would skip
      // the module without using its last-resort tool.
      yield { type: 'status', content: `Auto-mode: debug loop exhausted for ${mod.name} — invoking Infrastructure Debug (final escalation)...` };
      const infraResult = yield* this.runFunctionalInfraDebug(mod, ctx, phase2, context);
      this.recordEvent(
        mod, 'infra_debug', 'infra',
        infraResult.resolved
          ? `infra-debug resolved functional: ${infraResult.summary.slice(0, 200)}`
          : `infra-debug failed functional: ${infraResult.summary.slice(0, 200)}`,
      );
      if (infraResult.resolved) {
        yield { type: 'status', content: `Infrastructure Debug resolved ${mod.name}. Re-running simulation...` };
        // Reset counters so the caller re-enters the debug loop with fresh state.
        mod.sameErrorRetries = 0;
        mod.totalIterations = 0;
        return 'recovered';
      }
      // v4 Phase 2b: infra-debug failed → consider P2 redo before giving up
      const p2Outcome = yield* this.tryP2Redo(mod, phase2, ctx, context);
      if (p2Outcome !== 'no_redo') return p2Outcome;
      yield { type: 'status', content: `Auto-mode: Infrastructure Debug could not resolve ${mod.name} (${infraResult.summary.slice(0, 200)}). Skipping module.` };
      return 'manual_escalation';
    }
    if (context.askUser) {
      const answer = await context.askUser(
        'Options:\n  1) Enable Infrastructure Debug (LLM will access both RTL and TB)\n  2) Reset and continue normal debug\n  3) Skip module\n  4) Pause for manual intervention',
      );
      const choice = answer.trim();

      if (choice === '1') {
        // v3.1: Infrastructure Debug Agent for functional errors
        yield { type: 'status', content: 'User authorized Infrastructure Debug — LLM will access both RTL and TB with spec as ground truth.' };
        const infraResult = yield* this.runFunctionalInfraDebug(mod, ctx, phase2, context);
        this.recordEvent(
          mod, 'infra_debug', 'infra',
          infraResult.resolved
            ? `infra-debug resolved functional: ${infraResult.summary.slice(0, 200)}`
            : `infra-debug failed functional: ${infraResult.summary.slice(0, 200)}`,
        );

        if (infraResult.resolved) {
          yield { type: 'status', content: `Infrastructure Debug resolved the issue. Re-running simulation...` };
          // Reset debug counters and re-enter debug loop by returning (caller will re-sim)
          mod.sameErrorRetries = 0;
          mod.totalIterations = 0;
          return 'recovered';
        }
        yield { type: 'status', content: `Infrastructure Debug could not resolve: ${infraResult.summary.slice(0, 200)}` };
        // v4 Phase 2b: infra-debug failed → consider P2 redo before manual
        const p2Outcome = yield* this.tryP2Redo(mod, phase2, ctx, context);
        if (p2Outcome !== 'no_redo') return p2Outcome;
        // Fall through to ask again
        const retry = await context.askUser('Infrastructure Debug did not resolve the issue.\n  1) Skip module  2) Pause for manual intervention');
        if (retry.trim() === '2') {
          yield { type: 'status', content: `Paused. Edit code manually, then use /continue to resume.` };
          return 'manual_escalation';
        }
      } else if (choice === '2') {
        mod.sameErrorRetries = 0;
        mod.totalIterations = 0;
        return 'recovered';
      } else if (choice === '4') {
        yield { type: 'status', content: `Paused. Edit code manually, then use /continue to resume.` };
        return 'manual_escalation';
      }
    }
    return 'manual_escalation';
  }

  /**
   * v4 Phase 2b: attempt a P2 redo for a module whose functional infra-debug
   * has failed. Internal control:
   *   - Returns 'redo_requested' if P2 issued a revised spec → caller propagates
   *     up so the outer loop re-iterates this module.
   *   - Returns 'manual_escalation' if architect declared revisionNotHelpful
   *     (still consumes a budget unit; reason recorded in pastRevisions).
   *   - Returns 'no_redo' if budget is exhausted or LLM call errored —
   *     caller should fall through to its existing manual-escalation path.
   *
   * Constructs the FailureReport BEFORE pushing the new pastRevisions entry,
   * so the in-flight entry doesn't appear in its own "past revisions" list.
   */
  private async *tryP2Redo(
    mod: ModuleStatus,
    phase2: ArchitectPhase2Output | undefined,
    ctx: StageContext,
    context: OrchestratorContext,
  ): AsyncGenerator<OutputChunk, ExhaustOutcome | 'no_redo'> {
    if (!phase2) {
      // Cannot revise without a previous spec — fall through to manual.
      return 'no_redo';
    }
    const consumed = await this.tryConsumeP2Budget(mod.name, context);
    if (!consumed) {
      yield { type: 'status', content: `P2 redo budget exhausted for ${mod.name}; cannot retry with revised spec.` };
      return 'no_redo';
    }

    // 1. Build failure report from pastRevisions BEFORE pushing the new entry.
    const snapshot = formatAttemptHistoryForPrompt(mod.attemptHistory, { framing: 'spec_revision' });
    const osc = detectOscillation(mod.attemptHistory);
    const patternKind: FailurePatternKind = osc.kind === 'none'
      ? 'infra_unresolved'
      : (osc.kind as 'repeating' | 'alternating');
    const failureReport: FailureReport = {
      reportingStage: 'infra_debug',
      module: mod.name,
      patternKind,
      attemptHistorySnapshot: snapshot,
      ...(mod.lastDiagnosis?.rootCauseHypothesis
        ? { rootCauseHypothesis: mod.lastDiagnosis.rootCauseHypothesis }
        : {}),
      pastRevisions: this.getPastRevisions(mod.name),
      suggestedTarget: 'p2',
      ts: new Date().toISOString(),
    };

    // 2. Push the in-flight entry (outcome left undefined; backfilled at terminal).
    this.recordPastRevision(mod.name, {
      target: 'p2',
      attemptHistorySnapshot: snapshot,
      ...(mod.lastDiagnosis?.rootCauseHypothesis
        ? { diagnosisSnapshot: mod.lastDiagnosis.rootCauseHypothesis }
        : {}),
      appliedAt: new Date().toISOString(),
    });

    // 3. Call architect for revision.
    yield { type: 'status', content: `Requesting P2 revision for ${mod.name} — infra-debug exhausted, asking architect to reconsider spec...` };
    const prevP2JSON = JSON.stringify(phase2, null, 2);
    const revisionResult: P2RevisionResult = yield* runP2Revision(ctx, prevP2JSON, failureReport);

    if (revisionResult.kind === 'error') {
      // LLM error / parse failure — fall through to manual; entry stays with
      // outcome=undefined and will be backfilled to no_progress at terminal.
      yield { type: 'error', content: `P2 revision failed: ${revisionResult.reason}` };
      return 'manual_escalation';
    }

    if (revisionResult.kind === 'not_helpful') {
      await this.emitTelemetry(context, 'revision_not_helpful_declared', {
        scope: 'p2',
        module: mod.name,
        reason: revisionResult.reason.slice(0, 200),
      });
      const list = this.workflowState?.pastRevisions?.[mod.name];
      const last = list?.[list.length - 1];
      if (last) {
        last.declaredReason = revisionResult.reason;
        last.stopReason = 'revision_not_helpful';
        last.outcome = 'no_progress';
      }
      yield { type: 'status', content: `Architect declared revision not helpful for ${mod.name}: ${revisionResult.reason.slice(0, 200)}` };
      return 'manual_escalation';
    }

    // revisionResult.kind === 'revised' — install new spec, reset module, request redo.
    this.phase2Outputs.set(mod.name, revisionResult.phase2);
    if (this.workflowState?.p2Outputs) {
      this.workflowState.p2Outputs[mod.name] = revisionResult.phase2;
    }
    this.resetModuleForRedo(mod);
    yield { type: 'status', content: `P2 revision installed for ${mod.name}. Restarting RTL pipeline for this module...` };
    return 'redo_requested';
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
        await this.logWorkflow(context, topName, 'TOP_GEN', 'start', `module=${topName}`);
        for await (const chunk of generateTopModule(ctx, this.phase1Output, topName, context.hdlStandard)) {
          yield chunk;
        }
        await this.logWorkflow(context, topName, 'TOP_GEN', 'done', `module=${topName}`);
      }
    }

    const topModule = this.designIndex.topModules[0] ?? 'top';
    const stReqs = JSON.stringify(this.phase1Output.stVerification);
    const allPorts: Array<{ name: string; ports: PortDef[] }> =
      this.designIndex.modules.map(m => ({ name: m.name, ports: m.ports }));
    const contracts = this.phase1Output.interfaceContracts;

    await this.logWorkflow(context, topModule, 'VE_ST', 'start', `top=${topModule}`);
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
        if (parseSimResult(result).verdict === 'pass') {
          await this.logWorkflow(context, topModule, 'VE_ST', 'done', 'result=PASSED');
          yield { type: 'status', content: 'System test PASSED' };
        } else {
          await this.logWorkflow(context, topModule, 'VE_ST', 'done', 'result=FAILED');
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

  /**
   * Max ST triage → fix → re-test iterations before giving up.
   * Set to 4 (not 3) so a (F) escalation triggered at round N-2 still leaves
   * one round for re-triaging with the VCD-enriched output it just produced.
   */
  private static readonly ST_TRIAGE_MAX_ROUNDS = 4;

  private async *runSTTriage(
    ctx: StageContext,
    stOutput: string,
    context: OrchestratorContext,
  ): AsyncGenerator<OutputChunk> {
    if (!this.phase1Output || !this.designIndex) return;

    let routeBFailCount = 0;

    for (let stRound = 0; stRound < Orchestrator.ST_TRIAGE_MAX_ROUNDS; stRound++) {
      yield { type: 'progress', content: `Triaging system test failure (round ${stRound + 1})...` };

      const topModuleName = this.designIndex.topModules[0] ?? 'top';

      // (E) Deterministic top consistency check — first thing each round, before any
      // LLM call. Covers all routes (A/B/C) uniformly: ensures the top.sv the LLM
      // sees in triage context is canonical, ensures Route C's VCD analysis isn't
      // looking at stale wiring, and short-circuits the round entirely if a re-sync
      // turns out to fix the failure.
      const expectedTop = buildTopModuleContent(this.phase1Output, topModuleName, context.hdlStandard);
      if ('content' in expectedTop) {
        let onDisk = '';
        try { onDisk = await ctx.readFile(expectedTop.filePath); } catch { /* missing → treat as drift */ }
        if (onDisk !== expectedTop.content) {
          yield { type: 'status', content: `Top "${expectedTop.filePath}" drifted from canonical generator output. Overwriting and re-running ST.` };
          await ctx.executeAction({
            type: 'writeFile',
            payload: { path: expectedTop.filePath, content: expectedTop.content },
          });
          const reSimResult = await this.rerunST(context);
          if (!reSimResult) return;
          if (parseSimResult(reSimResult).verdict === 'pass') {
            yield { type: 'status', content: 'System test PASSED after top resync.' };
            return;
          }
          stOutput = reSimResult;
          yield { type: 'status', content: 'Top resync did not resolve. Re-triaging with fresh top context...' };
          continue;
        }
      }

      // Read top module code (now guaranteed to match canonical generator output)
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

      // (F) escalate to Route C if Route B has failed to converge twice — text triage
      // is not getting traction, give the next round VCD-informed signals to look at.
      if (triage.fix_location === 'connection' && routeBFailCount >= 2) {
        yield { type: 'status', content: `Route B (P1 revision) failed ${routeBFailCount} times. Escalating to VCD fallback for waveform-informed re-triage.` };
        triage.fix_location = 'unknown';
      }

      yield { type: 'status', content: `ST triage: ${triage.fix_location} — ${triage.diagnosis}` };

      // ── Route A: sub-module logic issue → enter that module's debug loop ──
      if (triage.fix_location === 'module') {
        // Guard: triage must specify which module to debug. Without this, the
        // hardening default below would emit an inaccurate "Unrecognized
        // fix_location" message for what is really a missing-field problem.
        if (!triage.module_name) {
          yield { type: 'status', content: 'Triage marked fix_location=module but did not specify module_name. Manual investigation needed.' };
          return;
        }

        const mod = this.workflowState?.moduleStatuses.find(m => m.name === triage!.module_name);

        // Top is deterministically generated and excluded from moduleStatuses on purpose.
        // If triage names a top module here, treat it as a routing mistake and reroute
        // to Route B (P1 revision is the only legitimate channel to fix top issues).
        if (!mod && this.phase1Output.topModules.includes(triage.module_name)) {
          yield { type: 'status', content: `Triage reported top module "${triage.module_name}" under fix_location='module'. Top is deterministically generated; rerouting to Route B (P1 revision).` };
          const outcome = yield* this.runSTTriageRouteB(triage.diagnosis, ctx, context);
          if (outcome.kind === 'aborted') return;
          if (outcome.kind === 'passed') return;
          stOutput = outcome.nextStOutput;
          routeBFailCount++;
          continue;
        }

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
        if (parseSimResult(reSimResult).verdict === 'pass') {
          yield { type: 'status', content: 'System test PASSED after fix.' };
          return;
        }
        // Still failing — loop back to triage with new output
        stOutput = reSimResult;
        yield { type: 'status', content: 'System test still failing after module fix. Re-triaging...' };
        continue;
      } else if (triage.fix_location === 'connection') {
        // ── Route B: connection/contract issue → P1 revision → re-generate top → re-ST ──
        const outcome = yield* this.runSTTriageRouteB(triage.diagnosis, ctx, context);
        if (outcome.kind === 'aborted') return;
        if (outcome.kind === 'passed') return;
        stOutput = outcome.nextStOutput;
        routeBFailCount++;
        continue;
      } else if (triage.fix_location === 'unknown') {
        // ── Route C: unknown → VCD fallback ──
        yield { type: 'status', content: 'Cannot determine failure source. Adding VCD dump for signal tracing...' };
        const topModName = this.designIndex.topModules[0] ?? 'top';
        await addVCDToTB(ctx, topModName, []);
        const vcdSimResult = await this.rerunST(context);
        if (!vcdSimResult) return;
        if (parseSimResult(vcdSimResult).verdict === 'pass') {
          yield { type: 'status', content: 'System test PASSED (unexpected after VCD add).' };
          return;
        }
        // Feed VCD-enriched output back into triage for a more informed diagnosis
        stOutput = vcdSimResult;
        yield { type: 'status', content: 'VCD captured. Re-triaging with waveform data...' };
        continue;
      } else {
        // Hardening: triage returned a value not in the documented enum. Without
        // this explicit reject, the loop would silently spin until exhaustion
        // with the same bad classification each round.
        yield { type: 'status', content: `Unrecognized fix_location "${triage.fix_location as string}". Manual investigation needed.` };
        return;
      }
    }

    yield { type: 'status', content: `ST triage exhausted after ${Orchestrator.ST_TRIAGE_MAX_ROUNDS} rounds. Manual intervention needed.` };
  }

  /**
   * Route B body extracted as a generator helper so Route A's "top reported under
   * module" fallthrough can reuse it. Returns a discriminated outcome so the outer
   * triage loop can decide whether to return, continue with new sim output, or
   * increment the routeBFailCount.
   */
  private async *runSTTriageRouteB(
    triageDiagnosis: string,
    ctx: StageContext,
    context: OrchestratorContext,
  ): AsyncGenerator<OutputChunk, { kind: 'passed' } | { kind: 'failed'; nextStOutput: string } | { kind: 'aborted' }> {
    if (!this.phase1Output) return { kind: 'aborted' };

    yield { type: 'status', content: 'Connection issue detected. Revising P1 architecture...' };

    const oldP1 = this.phase1Output;
    const revisionFeedback = `System test failure due to connection issue: ${triageDiagnosis}. Fix the interface contracts and/or module connections accordingly.`;

    // Use architect-p1 revision to fix contracts
    const prevJSON = JSON.stringify(oldP1, null, 2);
    const revisionMessages = buildArchitectP1RevisionMessages(prevJSON, revisionFeedback);
    const revResponse = await ctx.llm.complete(revisionMessages, { temperature: 0.3 });

    let newP1: ArchitectPhase1Output | null = null;
    try {
      newP1 = parsePhase1Response(revResponse);
    } catch {
      yield { type: 'status', content: 'Failed to parse revised P1. Manual intervention needed.' };
      return { kind: 'aborted' };
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
    if (!reSimResult) return { kind: 'aborted' };
    if (parseSimResult(reSimResult).verdict === 'pass') {
      yield { type: 'status', content: 'System test PASSED after P1 revision.' };
      return { kind: 'passed' };
    }
    yield { type: 'status', content: 'System test still failing after P1 revision. Re-triaging...' };
    return { kind: 'failed', nextStOutput: reSimResult };
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

    const globalParamsChanged =
      JSON.stringify(oldP1.globalParameters ?? {}) !== JSON.stringify(newP1.globalParameters ?? {});

    // Hash the contracts a given module participates in (as producer or consumer).
    // Sorted by contract name so reordering alone doesn't trigger a rebuild.
    const contractsHashFor = (
      modName: string,
      contracts: InterfaceContract[] | undefined,
    ): string => {
      if (!contracts) return '';
      const relevant = contracts
        .filter(c => c.producer === modName || c.consumers.includes(modName))
        .slice()
        .sort((a, b) => a.name.localeCompare(b.name));
      return JSON.stringify(relevant);
    };

    for (const [name, newMod] of newModMap) {
      const oldMod = oldModMap.get(name);
      if (!oldMod) {
        added.push(name);
        continue;
      }
      // Global params change invalidates every module (any module may reference them).
      if (globalParamsChanged) {
        changed.push(name);
        continue;
      }
      const portsEqual = JSON.stringify(oldMod.ports) === JSON.stringify(newMod.ports);
      const descEqual = oldMod.description === newMod.description;
      const contractsEqual =
        contractsHashFor(name, oldP1.interfaceContracts) ===
        contractsHashFor(name, newP1.interfaceContracts);
      if (portsEqual && descEqual && contractsEqual) {
        unchanged.push(name);
      } else {
        changed.push(name);
      }
    }

    for (const name of oldModMap.keys()) {
      if (!newModMap.has(name)) {
        removed.push(name);
      }
    }

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
          attemptHistory: [],
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

  // v3.2: isCompileError / classifyCompileError / extractFailingTC moved to
  // src/parser/sim-result.ts as parseSimResult(). Callers use parseSimResult
  // directly so all sim-output heuristics live in one place.

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
   * After infra-debug claims RESOLVED for a compile error, run a sim to
   * verify the same compile error does not immediately reappear.
   *
   * Why: infra-debug.ts already downgrades RESOLVED→UNRESOLVED when the
   * agent took zero actions (placebo describe-only summary). But an agent
   * that did call write_file/run_command can still self-deceive — wrong
   * file edited, symptom commented out, root cause untouched. Without
   * this verify, downstream `budget.resetCompile()` would zero the
   * same-error counter and the loop would climb back to escalation
   * threshold one wasted iteration at a time.
   *
   * Returns true to proceed with reset (verified clean OR couldn't
   * verify — failing to verify is not the agent's fault). Returns false
   * if the same compile error persists; caller should treat as
   * UNRESOLVED and fail the module.
   *
   * Cost: one extra sim per infra-resolved compile escalation. Picked
   * over delayed-reset for implementation simplicity (single-iteration
   * locality, no cross-iteration state).
   */
  private async *verifyCompileInfraResolution(
    context: OrchestratorContext,
    mod: ModuleStatus,
    preInfraError: string,
  ): AsyncGenerator<OutputChunk, boolean> {
    if (!context.executeAction) return true;
    yield { type: 'status', content: `Verifying infra-debug fix for ${mod.name}...` };
    const failingTC = parseSimResult(preInfraError).failingTC;
    let verifyOutput: string;
    try {
      verifyOutput = await context.executeAction({
        type: 'runSimulation',
        payload: { module: mod.name, testType: 'ut', ...(failingTC ? { tc: failingTC } : {}) },
      });
    } catch (err) {
      yield {
        type: 'error',
        content: `Verify sim threw: ${err instanceof Error ? err.message : String(err)} — trusting infra-debug and proceeding with reset.`,
      };
      return true;
    }
    const verifySim = parseSimResult(verifyOutput);
    if (verifySim.verdict !== 'compile_error') {
      yield { type: 'progress', content: `Verify clean (verdict=${verifySim.verdict}) — proceeding with reset.` };
      return true;
    }
    if (this.normalizeError(verifyOutput) !== this.normalizeError(preInfraError)) {
      yield { type: 'progress', content: `Verify shows different compile error — infra fix made progress, proceeding with reset.` };
      return true;
    }
    yield { type: 'error', content: `Verify shows same compile error after infra-debug — self-deception, treating as UNRESOLVED.` };
    return false;
  }

  /**
   * Invoke the Infrastructure Debug Agent for a functional error. Builds the
   * spec context from phase2 and the last error from attemptHistory, then
   * runs the agent. Shared between auto-mode (final escalation) and interactive
   * mode (user authorization). Returns the InfraDebugResult so callers can
   * handle post-resolution state.
   */
  private async *runFunctionalInfraDebug(
    mod: ModuleStatus,
    ctx: StageContext,
    phase2: ArchitectPhase2Output | undefined,
    context: OrchestratorContext,
  ): AsyncGenerator<OutputChunk, import('../stages/infra-debug.js').InfraDebugResult> {
    const specParts: string[] = [];
    if (phase2?.functionalSpec) specParts.push(`Functional Spec:\n${phase2.functionalSpec}`);
    if (phase2?.utVerification) specParts.push(`Verification Requirements:\n${JSON.stringify(phase2.utVerification, null, 2)}`);
    if (phase2?.fsmDescription) specParts.push(`FSM Description:\n${phase2.fsmDescription}`);
    if (phase2?.timingNotes) specParts.push(`Timing Notes:\n${phase2.timingNotes}`);
    const specStr = specParts.length > 0 ? specParts.join('\n\n') : 'No detailed spec available.';

    // v4: pull last actual error from attemptHistory; fall back to a generic
    // "exhausted" message if the module has no recorded attempts (rare).
    const lastAttempt = mod.attemptHistory.length > 0
      ? mod.attemptHistory[mod.attemptHistory.length - 1]
      : undefined;
    const lastError = lastAttempt?.errorRaw
      ? `Module: ${mod.name}\nLast error:\n${lastAttempt.errorRaw}`
      : `Module: ${mod.name}\nDebug exhausted after ${mod.totalIterations} iterations.`;

    // v4: pass oscillation hint if the recent history shows a pattern, so
    // the infra-debug agent investigates structurally rather than trying yet
    // another tactical fix.
    const osc = detectOscillation(mod.attemptHistory);

    // v4 Phase 2a: gated self-diagnosis. Fires at most once per module
    // lifetime, immediately before the first functional infra-debug
    // escalation, to seed a root-cause hypothesis the infra agent can use
    // instead of inheriting only the surface error.
    let diagnosisHint = '';
    if (this.shouldSelfDiagnose(mod)) {
      yield { type: 'status', content: `Pattern detected in ${mod.name} attempts — running self-diagnosis before infra escalation...` };
      const diagnosis = await selfDiagnose(ctx, mod.name, specStr, lastError, mod.attemptHistory);
      mod.selfDiagnoseRun = true;
      if (diagnosis) {
        // v4 Phase 2b: cache the structured diagnosis on the module so the
        // P2-redo path (downstream) can record it in pastRevisions[].diagnosisSnapshot.
        // selfDiagnoseRun=true with lastDiagnosis=undefined indicates we tried
        // but parsing failed — no hypothesis available for downstream consumers.
        mod.lastDiagnosis = diagnosis;
        diagnosisHint = formatDiagnosisAsHint(diagnosis);
        yield { type: 'progress', content: `Self-diagnosis (${diagnosis.confidence}): ${diagnosis.rootCauseHypothesis.slice(0, 200)}` };
      } else {
        yield { type: 'status', content: `Self-diagnosis returned no parseable result; proceeding with oscillation hint only.` };
      }
    }
    const combinedHint = [osc.hint, diagnosisHint].filter(s => s.length > 0).join('\n\n');

    await this.logWorkflow(context, mod.name, 'INFRA_DEBUG', 'start', `module=${mod.name} mode=functional pattern=${osc.kind} diagnosed=${diagnosisHint.length > 0}`);
    const infraResult = yield* this.drainInfraDebug(
      runInfraDebug(ctx, mod.name, lastError, 'functional', specStr, combinedHint || undefined),
    );
    await this.logWorkflow(context, mod.name, 'INFRA_DEBUG', 'done', `module=${mod.name} resolved=${infraResult.resolved} total=${infraResult.toolRounds} action=${infraResult.actionRounds}`);
    return infraResult;
  }

  /**
   * v4 Phase 2a: gating predicate for selfDiagnose. Returns true when
   * (a) we have not already diagnosed this module, AND
   * (b) either the recent fingerprint pattern shows oscillation/repetition,
   *     OR the attempt history is long enough that surface fixes alone
   *     have clearly not converged.
   */
  private shouldSelfDiagnose(mod: ModuleStatus): boolean {
    if (mod.selfDiagnoseRun) return false;
    const osc = detectOscillation(mod.attemptHistory);
    if (osc.kind !== 'none') return true;
    if (mod.attemptHistory.length >= 5) return true;
    return false;
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

  /**
   * v4: Append a structured attempt record to a module's history.
   * Stages return PartialAttemptRecord; this helper assigns the monotonic
   * `n` and `ts` fields and pushes onto mod.attemptHistory.
   */
  private recordAttempt(mod: ModuleStatus, partial: PartialAttemptRecord): AttemptRecord {
    const rec = newAttemptRecord(mod.attemptHistory, partial);
    mod.attemptHistory.push(rec);
    return rec;
  }

  /**
   * v4: Wrap an error string into an in-place AttemptRecord (used when the
   * orchestrator itself wants to log an event that originates from outside
   * the standard stage call sites — e.g., infra-debug result, audit verdict).
   */
  private recordEvent(
    mod: ModuleStatus,
    stage: PartialAttemptRecord['stage'],
    author: PartialAttemptRecord['author'],
    summary: string,
    errorRaw?: string,
  ): AttemptRecord {
    const errorSig = errorRaw ? extractErrorSignature(errorRaw) : undefined;
    return this.recordAttempt(mod, {
      stage,
      author,
      errorRaw,
      errorSig,
      summary,
    });
  }

  // -----------------------------------------------------------------------
  // v4 Phase 2b: revision budget + cross-stage failure feedback helpers
  // -----------------------------------------------------------------------

  /**
   * Lazily initialize and return the workflow's revision budget.
   * Per-module p2 entries are created on first access at the default cap.
   */
  private getRevisionBudget(): { p1: number; p2: Record<string, number> } {
    if (!this.workflowState) {
      throw new Error('Cannot access revision budget without workflow state.');
    }
    if (!this.workflowState.revisionBudget) {
      this.workflowState.revisionBudget = {
        p1: DEFAULT_REVISION_BUDGET.p1,
        p2: {},
      };
    }
    return this.workflowState.revisionBudget;
  }

  /**
   * Get the remaining P2 revision budget for a module, lazy-initializing
   * the per-module entry to DEFAULT_REVISION_BUDGET.p2PerModule on first
   * access. Pure read; does not mutate.
   */
  private getP2BudgetRemaining(moduleName: string): number {
    const budget = this.getRevisionBudget();
    if (!(moduleName in budget.p2)) {
      budget.p2[moduleName] = DEFAULT_REVISION_BUDGET.p2PerModule;
    }
    return budget.p2[moduleName]!;
  }

  /**
   * Attempt to consume one unit of P2 revision budget for a module.
   * Returns true if consumed (caller may proceed with revision); false if
   * already exhausted. Emits a budget_exhausted trace event when it
   * transitions from "had budget" to "exhausted by this call".
   */
  private async tryConsumeP2Budget(
    moduleName: string,
    context: OrchestratorContext,
  ): Promise<boolean> {
    const budget = this.getRevisionBudget();
    const remaining = this.getP2BudgetRemaining(moduleName);
    if (remaining <= 0) {
      // Already exhausted before this call — emit exhausted event so callers
      // that re-check after the fact still see the signal.
      await this.emitTelemetry(context, 'budget_exhausted', {
        scope: 'p2',
        module: moduleName,
        usedAttempts: DEFAULT_REVISION_BUDGET.p2PerModule,
      });
      return false;
    }
    budget.p2[moduleName] = remaining - 1;
    await this.emitTelemetry(context, 'revision_proposed', {
      scope: 'p2',
      module: moduleName,
      remainingAfter: budget.p2[moduleName],
    });
    if (budget.p2[moduleName] === 0) {
      await this.emitTelemetry(context, 'budget_exhausted', {
        scope: 'p2',
        module: moduleName,
        usedAttempts: DEFAULT_REVISION_BUDGET.p2PerModule,
      });
    }
    return true;
  }

  /**
   * Attempt to consume one unit of project-level P1 revision budget.
   * Symmetric with tryConsumeP2Budget but at the project scope.
   */
  private async tryConsumeP1Budget(context: OrchestratorContext): Promise<boolean> {
    const budget = this.getRevisionBudget();
    if (budget.p1 <= 0) {
      await this.emitTelemetry(context, 'budget_exhausted', {
        scope: 'p1',
        usedAttempts: DEFAULT_REVISION_BUDGET.p1,
      });
      return false;
    }
    budget.p1 -= 1;
    await this.emitTelemetry(context, 'revision_proposed', {
      scope: 'p1',
      remainingAfter: budget.p1,
    });
    if (budget.p1 === 0) {
      await this.emitTelemetry(context, 'budget_exhausted', {
        scope: 'p1',
        usedAttempts: DEFAULT_REVISION_BUDGET.p1,
      });
    }
    return true;
  }

  /**
   * Append a past-revision record for a module. Lazy-initializes the
   * pastRevisions map on first call.
   */
  private recordPastRevision(moduleName: string, entry: PastRevisionEntry): void {
    if (!this.workflowState) return;
    if (!this.workflowState.pastRevisions) {
      this.workflowState.pastRevisions = {};
    }
    const list = this.workflowState.pastRevisions[moduleName] ?? [];
    list.push(entry);
    this.workflowState.pastRevisions[moduleName] = list;
  }

  /** Read current pastRevisions for a module (empty array if none). */
  private getPastRevisions(moduleName: string): PastRevisionEntry[] {
    return this.workflowState?.pastRevisions?.[moduleName] ?? [];
  }

  /**
   * Backfill the most recent pastRevisions entry's `outcome` if still
   * undefined. Called at the three module-state-transition points where
   * the module reaches a terminal state under the revised spec:
   *   (1) outer loop sets mod.utPassed=true / mod.status='done'  → 'resolved'
   *   (2) outer loop sets mod.status='failed' from manual_escalation → 'no_progress'
   *   (3) lint loop sets mod.lintPassed=false / mod.status='failed' → 'no_progress'
   *
   * The undefined-guard makes this idempotent and safe to call when no
   * revision is in progress (no-op).
   */
  private backfillRevisionOutcome(mod: ModuleStatus, value: 'resolved' | 'no_progress'): void {
    const list = this.workflowState?.pastRevisions?.[mod.name];
    if (!list || list.length === 0) return;
    const last = list[list.length - 1]!;
    if (last.outcome === undefined) {
      last.outcome = value;
    }
  }

  /**
   * Reset a module's per-revision state when a P2 redo installs a new
   * spec. The new spec invalidates all per-attempt accumulators (counters,
   * attempt history, diagnosis cache, tb_suspect counter). pastRevisions
   * is intentionally NOT reset — it lives on WorkflowState and accumulates
   * across redos to feed cross-revision pattern detection.
   *
   * IMPORTANT: when adding a new field to ModuleStatus, update this list.
   * The ModuleStatus type doc points back here as a reminder.
   */
  private resetModuleForRedo(mod: ModuleStatus): void {
    mod.attemptHistory = [];
    mod.selfDiagnoseRun = undefined;
    mod.lastDiagnosis = undefined;
    mod.lintAttempts = 0;
    mod.veCompileAttempts = 0;
    mod.tbSuspectCount = 0;
    mod.sameErrorRetries = 0;
    mod.totalIterations = 0;
    mod.lintPassed = false;
    mod.utPassed = false;
    mod.status = 'pending';
  }

  /**
   * Emit a structured telemetry event into the LLM trace stream. Uses the
   * existing `event` field on LLMTraceEntry; the `taskContext` payload is
   * a JSON-encoded summary for downstream analysis tools.
   */
  private async emitTelemetry(
    context: OrchestratorContext,
    event: 'revision_proposed' | 'budget_exhausted' | 'revision_not_helpful_declared',
    payload: Record<string, unknown>,
  ): Promise<void> {
    if (!context.logLLMTrace) return;
    const moduleName = typeof payload['module'] === 'string' ? payload['module'] : '_global';
    await context.logLLMTrace({
      timestamp: new Date().toISOString(),
      role: 'Orchestrator',
      module: moduleName,
      promptTokens: 0,
      completionTokens: 0,
      durationMs: 0,
      event,
      taskContext: `${event}:${JSON.stringify(payload)}`,
      summary: `${event} ${JSON.stringify(payload)}`,
    });
  }

  private normalizeError(error: string): string {
    return error
      // File paths with line[:col] (file.v:15 / file.sv:15:3 / file.vh:15) → FILE:N
      // Strips line-number drift so the same error type is recognized as identical
      // even after a fix shifts surrounding lines.
      .replace(/[\w/.~-]+\.s?vh?\s*:\s*\d+(?:\s*:\s*\d+)?/g, 'FILE:N')
      // Timestamps / delays / cycle / line counters
      .replace(/time\s+\d+/gi, 'time N')
      .replace(/#\s*\d+/g, '# N')
      .replace(/\b(line|cycle|iteration|round|step)\s+\d+/gi, '$1 N')
      // Verilog literals: 8'hFF, 32'b01xx, 16'd123 → N'X (width irrelevant for same-error match)
      .replace(/\b\d+\s*'\s*[bhdoBHDO]\s*[0-9a-fA-F_xzXZ?]+/g, "N'X")
      // C-style hex literals: 0xDEADBEEF → 0xN
      .replace(/\b0x[0-9a-fA-F]+\b/gi, '0xN')
      // Value after = / == / != / < / > / <= / >= — decimal OR bare hex (e.g. =aa, =00, =ff)
      // First char must be hex digit (0-9a-fA-F) to avoid matching identifiers like "null".
      // Trailing lookahead ensures we stop at a token boundary so "addr1" is not mis-matched
      // (the `r` is not in the hex class, so the match would break before the boundary).
      .replace(/([=<>!]=?\s*)-?[0-9a-fA-F][0-9a-fA-F_xzXZ?]*(?:\.[0-9]+)?(?=[\s,;:)\]}\n]|$)/gi, '$1N')
      // Value after common reporting words — accepts decimal, bare hex, or mixed (e.g. "expected aa", "got 0")
      .replace(/\b(expected|actual|got|observed|value|result|exp|act)\s*[:=]?\s*-?[0-9a-fA-F][0-9a-fA-F_xzXZ?]*(?:\.[0-9]+)?(?=[\s,;:)\]}\n]|$)/gi, '$1 N')
      // Collapse whitespace and cap length
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
