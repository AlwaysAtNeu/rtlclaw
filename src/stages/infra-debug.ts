/**
 * Infrastructure Debug Agent for RTL-Claw.
 *
 * Tool-calling agent that can investigate and fix problems beyond the scope
 * of specific-role fixes (Designer for RTL, VE for TB). Has access to
 * list_files, read_file, write_file, and run_command tools.
 *
 * Two use cases:
 * 1. Compile errors: after specific-role fix fails (no independence concern)
 * 2. Functional errors: user-authorized escalation (spec is immutable ground truth)
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { Message, ToolSchema, ToolCall } from '../llm/types.js';
import type { StageContext, OutputChunk, LLMTraceEntry } from './types.js';
import { execAsync, assertSafePath } from '../utils/exec.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_ACTION_ROUNDS = 8;
const MAX_TOTAL_ROUNDS = 32;
const ACTION_TOOLS = new Set(['write_file', 'run_command']);

// ---------------------------------------------------------------------------
// Tool schemas (subset of ClawMode tools)
// ---------------------------------------------------------------------------

const INFRA_TOOLS: ToolSchema[] = [
  {
    name: 'list_files',
    description: 'List files and directories at the given path.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Relative directory path (default: ".")' },
      },
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
    name: 'run_command',
    description: 'Run a shell command in the project directory and return output. Use for lint, compilation, simulation.',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'Shell command to execute (bash)' },
      },
      required: ['command'],
    },
  },
];

// ---------------------------------------------------------------------------
// Tool executor
// ---------------------------------------------------------------------------

async function executeTool(
  toolName: string,
  args: Record<string, unknown>,
  projectPath: string,
  signal?: AbortSignal,
): Promise<string> {
  const baseDir = projectPath;

  try {
    switch (toolName) {
      case 'list_files': {
        const dirPath = assertSafePath(baseDir, (args.path as string) ?? '.');
        const entries = await fs.readdir(dirPath, { withFileTypes: true });
        return entries.map(e => `${e.isDirectory() ? '[dir] ' : '      '}${e.name}`).join('\n');
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
      case 'run_command': {
        const cmd = args.command as string;
        const output = await execAsync(cmd, {
          cwd: baseDir,
          timeout: 120_000,
          signal,
        });
        return output || '(no output)';
      }
      default:
        return `Unknown tool: ${toolName}`;
    }
  } catch (err) {
    // Abort errors propagate up to cancel the tool loop
    if (err instanceof Error && (err.name === 'AbortError' || err.message.includes('aborted'))) {
      throw err;
    }
    if (err instanceof Error && 'stdout' in err) {
      const execErr = err as { stdout?: string; stderr?: string };
      return `Command failed:\n${execErr.stdout || execErr.stderr || err.message}`;
    }
    return `Error: ${err instanceof Error ? err.message : String(err)}`;
  }
}

// ---------------------------------------------------------------------------
// Result type
// ---------------------------------------------------------------------------

export interface InfraDebugResult {
  /** Whether the agent believes the issue is resolved */
  resolved: boolean;
  /** Summary of what was done */
  summary: string;
  /** Files that were modified */
  modifiedFiles: string[];
  /** Number of LLM turns that invoked tools (read + action) */
  toolRounds: number;
  /** Number of LLM turns that invoked write_file / run_command */
  actionRounds: number;
}

// ---------------------------------------------------------------------------
// System prompts
// ---------------------------------------------------------------------------

function buildCompileDebugPrompt(): string {
  return `You are an Infrastructure Debug Agent for an RTL (chip design) project.

A compilation error has occurred that the specific-role agents (RTL Designer, Verification Engineer) could not fix after multiple attempts. Your job is to investigate the root cause AND APPLY THE FIX.

You have access to tools: list_files, read_file, write_file, run_command.

CONFIDENT FIX → APPLY IT YOURSELF. NOT CONFIDENT → STOP AND REPORT UNRESOLVED.
- If you have identified the root cause and know the correct fix: call write_file to apply it, then run_command to verify.
- If you cannot find the root cause, are guessing, or the issue is outside your scope (env/permissions/user config): output UNRESOLVED with what you found. Do NOT make speculative edits.
- Forbidden: "you should change X to Y", "the fix would be to...", "I recommend updating..." — if you know the fix, apply it; if you don't, say UNRESOLVED.
- Equally forbidden: writing a placebo edit just to satisfy the RESOLVED requirement. A wrong fix is worse than UNRESOLVED.

Common root causes:
- Filelist (.f file) has invalid entries, wrong paths, or missing files
- Include paths (+incdir+) are wrong or missing
- File was written to wrong directory
- Module name doesn't match filename
- Missing dependency files
- Compilation command is wrong

Approach:
1. Read the error message carefully
2. Use list_files and read_file to investigate the project structure
3. Try to identify the root cause
4. If confident in the fix → call write_file to apply it, then run_command to verify
5. If verification fails → iterate (re-read, re-fix, re-run)
6. If you cannot find the root cause after investigation → stop and output UNRESOLVED

Output a summary starting with "RESOLVED:" or "UNRESOLVED:".
- RESOLVED requires: you actually applied a fix (write_file or a configuration-changing run_command) AND a follow-up run_command shows the original error is gone.
- If you only investigated, only described a fix, or are unsure → output UNRESOLVED. The user will take over.
- A transient error that disappears on a clean re-run also counts: a single run_command that shows the error is gone (with your explanation) is acceptable as RESOLVED.`;
}

function buildFunctionalDebugPrompt(spec: string): string {
  return `You are an Infrastructure Debug Agent for an RTL (chip design) project.

The normal debug loop (RTL Designer fixing RTL, VE fixing testbench) has been exhausted without resolving the issue. The user has authorized you to investigate with full access to both RTL and testbench code AND TO APPLY THE FIX YOURSELF.

CRITICAL RULE: The design specification below is the IMMUTABLE GROUND TRUTH.
- If RTL behavior doesn't match the spec → fix the RTL
- If TB checker expectations don't match the spec → fix the TB
- NEVER adjust one side to match the other's buggy behavior
- NEVER modify the spec

Design Specification:
${spec}

You have access to tools: list_files, read_file, write_file, run_command.

CONFIDENT FIX → APPLY IT YOURSELF. NOT CONFIDENT → STOP AND REPORT UNRESOLVED.
- If you can pinpoint exactly which side (RTL or TB) deviates from spec and know the correct fix: call write_file to apply it, then run_command to re-simulate.
- If you cannot decide which side is wrong, or are guessing: output UNRESOLVED with what you found. The user will take over.
- Forbidden: "the RTL should be changed to...", "I recommend updating the checker...", "the fix would be..." — if you know the fix, apply it; if you don't, say UNRESOLVED.
- Equally forbidden: writing a placebo edit just to satisfy the RESOLVED requirement. A wrong fix corrupts a working side and is worse than UNRESOLVED.

Approach:
1. Read the error output and understand what signal/value/time is failing
2. Read the RTL code — check if it implements the spec correctly
3. Read the TB/TC code — check if checkers match the spec expectations
4. Decide which side (RTL or TB) deviates from spec — only proceed if you are confident
5. If confident → call write_file to apply the fix, then run_command to re-simulate
6. If still failing → iterate (re-read, re-fix, re-run)
7. If you cannot confidently identify the bad side → stop and output UNRESOLVED

Output a summary starting with "RESOLVED:" or "UNRESOLVED:".
- RESOLVED requires: you actually called write_file AND a follow-up run_command shows the failure is gone.
- If you only investigated, only described a fix, or are unsure which side is wrong → output UNRESOLVED.`;
}

// ---------------------------------------------------------------------------
// Main agent function
// ---------------------------------------------------------------------------

/**
 * Run the infrastructure debug agent.
 * Uses tool-calling to investigate and fix issues beyond specific-role scope.
 */
export async function* runInfraDebug(
  ctx: StageContext,
  errorOutput: string,
  mode: 'compile' | 'functional',
  spec?: string,
): AsyncGenerator<OutputChunk, InfraDebugResult> {
  const systemPrompt = mode === 'compile'
    ? buildCompileDebugPrompt()
    : buildFunctionalDebugPrompt(spec ?? 'No spec available.');

  const messages: Message[] = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: `The following error needs to be investigated and fixed:\n\n${errorOutput}` },
  ];

  let fullContent = '';
  const modifiedFiles: string[] = [];
  let toolRounds = 0;
  let actionRounds = 0;

  yield { type: 'status', content: `Infrastructure Debug Agent started (${mode} mode, action≤${MAX_ACTION_ROUNDS} total≤${MAX_TOTAL_ROUNDS})` };

  for (let round = 0; round < MAX_TOTAL_ROUNDS; round++) {
    const startMs = Date.now();
    let response;

    try {
      response = await ctx.llm.complete(messages, {
        tools: INFRA_TOOLS,
        temperature: 0.1,
        signal: ctx.signal,
      });
    } catch (err) {
      // If tool-calling not supported, fall back to text-only
      const msg = err instanceof Error ? err.message : String(err);
      if (/tools?\s*(is\s+)?not\s+support|unsupported.*tool/i.test(msg)) {
        yield { type: 'error', content: 'LLM provider does not support tool calling — infrastructure debug requires it.' };
        return { resolved: false, summary: 'Provider does not support tool calling', modifiedFiles: [], toolRounds: 0, actionRounds: 0 };
      }
      throw err;
    }

    const durationMs = Date.now() - startMs;

    // Log the LLM call
    if (ctx.logTrace) {
      await ctx.logTrace({
        timestamp: new Date().toISOString(),
        role: 'InfraDebug',
        promptTokens: response.usage.promptTokens,
        completionTokens: response.usage.completionTokens,
        durationMs,
        taskContext: `infra-debug:${mode}:round${round}`,
        responseChars: response.content.length,
        hasCodeBlock: false,
        retryCount: response.retryCount,
        summary: `round ${round + 1}/${MAX_TOTAL_ROUNDS} (action ${actionRounds}/${MAX_ACTION_ROUNDS}), ${response.toolCalls.length} tool calls`,
        promptContent: messages,
        responseContent: response.content,
      });
    }

    // Emit text content
    if (response.content) {
      fullContent += response.content;
      yield { type: 'text', content: response.content };
    }

    // Process tool calls
    if (response.toolCalls && response.toolCalls.length > 0) {
      toolRounds++;
      const hasAction = response.toolCalls.some(tc => ACTION_TOOLS.has(tc.name));
      if (hasAction) actionRounds++;
      messages.push({
        role: 'assistant',
        content: response.content || '',
        toolCalls: response.toolCalls,
      });

      let toolErrors = 0;
      for (const tc of response.toolCalls) {
        yield { type: 'progress', content: `  > ${tc.name}: ${JSON.stringify(tc.arguments).slice(0, 150)}` };
        const result = await executeTool(tc.name, tc.arguments, ctx.projectPath, ctx.signal);
        const isErr = result.startsWith('Error:') || result.startsWith('Command failed:');
        if (isErr) toolErrors++;

        // Track written files
        if (tc.name === 'write_file' && !isErr) {
          modifiedFiles.push(tc.arguments.path as string);
        }

        // Show truncated result
        const display = result.length > 500 ? result.slice(0, 500) + '\n... (truncated)' : result;
        yield { type: 'progress', content: isErr ? `  ✗ ${display}` : `  ${display}` };

        messages.push({
          role: 'tool',
          content: result,
          toolResult: { toolCallId: tc.id, content: result, isError: isErr },
        });
      }

      // If all tools failed repeatedly, ask LLM to wrap up
      if (toolErrors === response.toolCalls.length && toolRounds >= 3) {
        messages.push({
          role: 'user',
          content: 'Multiple tool calls have failed. Summarize what you found so far. Start with "RESOLVED:" or "UNRESOLVED:".',
        });
      }

      // Force summary when either budget is exhausted
      const actionHit = actionRounds >= MAX_ACTION_ROUNDS;
      const totalHit = toolRounds >= MAX_TOTAL_ROUNDS;
      if (actionHit || totalHit) {
        const reason = actionHit
          ? `Action round cap reached (${MAX_ACTION_ROUNDS} write/run turns used)`
          : `Total round cap reached (${MAX_TOTAL_ROUNDS} tool turns used)`;
        messages.push({
          role: 'user',
          content: `${reason}. Provide your final summary. Start with "RESOLVED:" or "UNRESOLVED:".`,
        });
        const finalStart = Date.now();
        const finalResp = await ctx.llm.complete(messages, { temperature: 0.1, signal: ctx.signal });
        const finalDuration = Date.now() - finalStart;
        if (ctx.logTrace) {
          await ctx.logTrace({
            timestamp: new Date().toISOString(),
            role: 'InfraDebug',
            promptTokens: finalResp.usage.promptTokens,
            completionTokens: finalResp.usage.completionTokens,
            durationMs: finalDuration,
            taskContext: `infra-debug:${mode}:final-summary`,
            responseChars: finalResp.content.length,
            hasCodeBlock: false,
            retryCount: finalResp.retryCount,
            summary: `forced summary (${reason})`,
            promptContent: messages,
            responseContent: finalResp.content,
          });
        }
        if (finalResp.content) {
          fullContent += finalResp.content;
          yield { type: 'text', content: finalResp.content };
        }
        break;
      }

      continue; // Next round
    }

    // No tool calls — LLM is done
    break;
  }

  // Parse result from LLM's summary
  const claimedResolved = fullContent.includes('RESOLVED:') && !fullContent.includes('UNRESOLVED:');
  const summaryMatch = fullContent.match(/(?:RESOLVED|UNRESOLVED):\s*([\s\S]*?)$/);
  let summary = summaryMatch ? summaryMatch[1].trim().slice(0, 500) : fullContent.slice(-300).trim();

  // Guardrail: claiming RESOLVED without ever calling write_file/run_command means
  // the agent only described a fix instead of applying it. Downgrade to UNRESOLVED.
  let resolved = claimedResolved;
  if (claimedResolved && actionRounds === 0) {
    resolved = false;
    const note = 'Agent claimed RESOLVED but never called write_file/run_command — fix was only described, not applied. Downgraded to UNRESOLVED.';
    yield { type: 'error', content: note };
    summary = `${note}\nOriginal summary: ${summary}`.slice(0, 500);
  }

  yield { type: 'status', content: `Infrastructure Debug Agent finished: ${resolved ? 'RESOLVED' : 'UNRESOLVED'} (${toolRounds} total, ${actionRounds} action)` };

  return {
    resolved,
    summary,
    modifiedFiles,
    toolRounds,
    actionRounds,
  };
}
