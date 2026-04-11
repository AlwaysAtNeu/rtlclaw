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

const MAX_TOOL_ROUNDS = 8;

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
  /** Number of tool rounds used */
  toolRounds: number;
}

// ---------------------------------------------------------------------------
// System prompts
// ---------------------------------------------------------------------------

function buildCompileDebugPrompt(): string {
  return `You are an Infrastructure Debug Agent for an RTL (chip design) project.

A compilation error has occurred that the specific-role agents (RTL Designer, Verification Engineer) could not fix after multiple attempts. Your job is to investigate the root cause and fix it.

You have access to tools: list_files, read_file, write_file, run_command.

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
3. Identify the root cause
4. Fix the issue (write_file to correct files, or note what needs changing)
5. Run the compilation/simulation again to verify your fix

When done, output a summary starting with "RESOLVED:" or "UNRESOLVED:" followed by what you found and did.`;
}

function buildFunctionalDebugPrompt(spec: string): string {
  return `You are an Infrastructure Debug Agent for an RTL (chip design) project.

The normal debug loop (RTL Designer fixing RTL, VE fixing testbench) has been exhausted without resolving the issue. The user has authorized you to investigate with full access to both RTL and testbench code.

CRITICAL RULE: The design specification below is the IMMUTABLE GROUND TRUTH.
- If RTL behavior doesn't match the spec → fix the RTL
- If TB checker expectations don't match the spec → fix the TB
- NEVER adjust one side to match the other's buggy behavior
- NEVER modify the spec

Design Specification:
${spec}

You have access to tools: list_files, read_file, write_file, run_command.

Approach:
1. Read the error output and understand what signal/value/time is failing
2. Read the RTL code — check if it implements the spec correctly
3. Read the TB/TC code — check if checkers match the spec expectations
4. Identify which side (RTL or TB) deviates from spec
5. Fix the deviating code
6. Run simulation to verify

When done, output a summary starting with "RESOLVED:" or "UNRESOLVED:" followed by what you found and did.`;
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

  yield { type: 'status', content: `Infrastructure Debug Agent started (${mode} mode, max ${MAX_TOOL_ROUNDS} rounds)` };

  for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
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
        return { resolved: false, summary: 'Provider does not support tool calling', modifiedFiles: [], toolRounds: 0 };
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
        summary: `round ${round}/${MAX_TOOL_ROUNDS}, ${response.toolCalls.length} tool calls`,
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
      if (toolErrors === response.toolCalls.length && round >= 3) {
        messages.push({
          role: 'user',
          content: 'Multiple tool calls have failed. Summarize what you found so far. Start with "RESOLVED:" or "UNRESOLVED:".',
        });
      }

      // Force summary on last round
      if (round >= MAX_TOOL_ROUNDS) {
        messages.push({
          role: 'user',
          content: 'Tool call limit reached. Provide your final summary. Start with "RESOLVED:" or "UNRESOLVED:".',
        });
        const finalResp = await ctx.llm.complete(messages, { temperature: 0.1, signal: ctx.signal });
        if (finalResp.content) {
          fullContent += finalResp.content;
          yield { type: 'text', content: finalResp.content };
        }
      }

      continue; // Next round
    }

    // No tool calls — LLM is done
    break;
  }

  // Parse result from LLM's summary
  const resolved = fullContent.includes('RESOLVED:') && !fullContent.includes('UNRESOLVED:');
  const summaryMatch = fullContent.match(/(?:RESOLVED|UNRESOLVED):\s*([\s\S]*?)$/);
  const summary = summaryMatch ? summaryMatch[1].trim().slice(0, 500) : fullContent.slice(-300).trim();

  yield { type: 'status', content: `Infrastructure Debug Agent finished: ${resolved ? 'RESOLVED' : 'UNRESOLVED'} (${toolRounds} tool rounds)` };

  return {
    resolved,
    summary,
    modifiedFiles,
    toolRounds,
  };
}
