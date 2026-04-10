/**
 * RTL Designer stage for RTL-Claw v2.
 *
 * Handles RTL code generation, lint fix, and debug fix.
 * Each function builds a minimal context via context-builder,
 * calls the LLM once (non-streaming), and processes the result.
 */

import type { Action, ArchitectPhase2Output, DebugDiagnosis, PortDef, InterfaceContract } from '../agents/types.js';
import type { Message } from '../llm/types.js';
import type { OutputChunk, StageContext } from './types.js';
import {
  buildRTLWriteMessages,
  buildRTLLintFixMessages,
  buildRTLDebugFixMessages,
  buildRTLDebugWithVerifReqMessages,
  buildSignalSelectMessages,
} from '../agents/context-builder.js';

/** Sum total characters in a message array (for trace logging). */
function promptChars(msgs: Message[]): number {
  return msgs.reduce((sum, m) => sum + m.content.length, 0);
}

// ---------------------------------------------------------------------------
// Helper: parse LLM response to extract code blocks and writeFile actions
// ---------------------------------------------------------------------------

/**
 * Extracts fenced code blocks from LLM text. Blocks with a filename
 * (either on the fence line or via a `// filename: ...` first-line comment)
 * become writeFile actions. All blocks are returned as artifacts.
 */
export function parseLLMResponse(text: string): { actions: Action[]; artifacts: string[] } {
  const actions: Action[] = [];
  const artifacts: string[] = [];

  const codeBlockRegex = /```(\w+)?(?:\s+(\S+))?\n([\s\S]*?)```/g;
  let match: RegExpExecArray | null;

  while ((match = codeBlockRegex.exec(text)) !== null) {
    const lang = match[1] ?? '';
    let filename = match[2] ?? '';
    const codeContent = match[3] ?? '';

    // Fallback: look for a filename/path comment on the first line.
    // Models may output various formats:
    //   // filename: hw/src/hdl/counter.v
    //   // File: hw/src/hdl/counter.v
    //   // hw/src/hdl/counter.v
    if (!filename) {
      const firstLineMatch = codeContent.match(
        /^\/\/\s*(?:file(?:name)?:\s*)?(\S+\.(?:s?vh?|svh))\s*$/m,
      );
      if (firstLineMatch) filename = firstLineMatch[1]!;
    }

    const label = filename ? `[${lang || 'code'}] ${filename}` : `[${lang || 'code'}]`;
    artifacts.push(`${label}\n${codeContent}`);

    if (filename) {
      actions.push({
        type: 'writeFile',
        payload: { path: filename, content: codeContent },
      });
    }
  }

  return { actions, artifacts };
}

// ---------------------------------------------------------------------------
// writeModule — generate RTL for a single module
// ---------------------------------------------------------------------------

export async function* writeModule(
  ctx: StageContext,
  phase2Design: ArchitectPhase2Output,
  dependentModulePorts: Array<{ name: string; ports: PortDef[] }>,
  hdlStandard?: string,
  interfaceContracts?: InterfaceContract[],
  previousLintError?: string,
): AsyncGenerator<OutputChunk> {
  const moduleName = phase2Design.moduleName;

  yield { type: 'status', content: `Writing RTL for module "${moduleName}"...` };

  // Build messages and call LLM (v3: pass interface contracts)
  const messages = buildRTLWriteMessages(phase2Design, dependentModulePorts, hdlStandard, interfaceContracts, previousLintError);
  const startMs = Date.now();
  const response = await ctx.llm.complete(messages);
  const durationMs = Date.now() - startMs;

  // Parse code blocks from LLM output
  const { actions, artifacts } = parseLLMResponse(response.content);
  const hasCode = actions.length > 0;

  // Log trace
  if (ctx.logTrace) {
    await ctx.logTrace({
      timestamp: new Date().toISOString(),
      role: 'RTLDesigner',
      promptTokens: response.usage.promptTokens,
      completionTokens: response.usage.completionTokens,
      durationMs,
      taskContext: `writeModule:${moduleName}`,
      promptChars: promptChars(messages),
      responseChars: response.content.length,
      hasCodeBlock: hasCode,
      retryCount: response.retryCount,
      summary: hasCode
        ? `wrote ${actions.length} file(s) for ${moduleName}`
        : `no code blocks in response for ${moduleName}`,
      promptContent: messages,
      responseContent: response.content,
    });
  }

  if (!hasCode) {
    yield { type: 'error', content: `No code blocks found in LLM response for module "${moduleName}".` };
    return;
  }

  yield {
    type: 'progress',
    content: `Extracted ${actions.length} file(s) for module "${moduleName}".`,
  };

  // Execute writeFile actions
  for (const action of actions) {
    const filePath = action.payload['path'] as string;
    try {
      await ctx.executeAction(action);
      yield {
        type: 'progress',
        content: `Wrote file: ${filePath}`,
      };

      // Append to filelist
      await ctx.executeAction({
        type: 'writeFile',
        payload: {
          path: ctx.filelistPath,
          content: filePath,
          append: true,
        },
      });
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      yield { type: 'error', content: `Failed to write "${filePath}": ${errMsg}` };
    }
  }

  // Update design index
  try {
    await ctx.executeAction({ type: 'updateIndex', payload: {} });
    yield {
      type: 'progress',
      content: `Design index updated after writing module "${moduleName}".`,
    };
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    yield { type: 'error', content: `Failed to update design index: ${errMsg}` };
  }

  yield {
    type: 'status',
    content: `RTL generation complete for module "${moduleName}".`,
    metadata: { moduleName, artifacts: artifacts.length },
  };
}

// ---------------------------------------------------------------------------
// fixLintErrors — read current code, ask LLM to fix lint issues
// ---------------------------------------------------------------------------

export async function fixLintErrors(
  ctx: StageContext,
  moduleName: string,
  lintOutput: string,
  hdlStandard?: string,
): Promise<boolean> {
  // Read current RTL code
  const filePath = `hw/src/hdl/${moduleName}.sv`;
  let rtlCode: string;
  try {
    rtlCode = await ctx.readFile(filePath);
  } catch {
    // Try .v extension as fallback
    try {
      rtlCode = await ctx.readFile(`hw/src/hdl/${moduleName}.v`);
    } catch {
      if (ctx.logTrace) {
        await ctx.logTrace({
          timestamp: new Date().toISOString(),
          role: 'RTLDesigner',
          promptTokens: 0,
          completionTokens: 0,
          durationMs: 0,
          taskContext: `fixLintErrors:${moduleName}:file_not_found`,
        });
      }
      return false;
    }
  }

  // Build messages and call LLM
  const messages = buildRTLLintFixMessages(moduleName, lintOutput, rtlCode, hdlStandard);
  const startMs = Date.now();
  const response = await ctx.llm.complete(messages);
  const durationMs = Date.now() - startMs;

  // Parse the fixed code
  const { actions } = parseLLMResponse(response.content);
  const hasCode = actions.length > 0;

  if (ctx.logTrace) {
    await ctx.logTrace({
      timestamp: new Date().toISOString(),
      role: 'RTLDesigner',
      promptTokens: response.usage.promptTokens,
      completionTokens: response.usage.completionTokens,
      durationMs,
      taskContext: `fixLintErrors:${moduleName}`,
      promptChars: promptChars(messages),
      responseChars: response.content.length,
      hasCodeBlock: hasCode,
      retryCount: response.retryCount,
      summary: hasCode ? `lint fix applied for ${moduleName}` : `no code in lint fix response for ${moduleName}`,
      promptContent: messages,
      responseContent: response.content,
    });
  }

  if (!hasCode) {
    return false;
  }

  // Write the first code block as the fixed file
  const fixAction = actions[0]!;
  const fixedContent = fixAction.payload['content'] as string;
  const targetPath = (fixAction.payload['path'] as string) || filePath;

  try {
    await ctx.executeAction({
      type: 'writeFile',
      payload: { path: targetPath, content: fixedContent },
    });
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// selectVCDSignals — Designer selects signals to examine from VCD waveform
// ---------------------------------------------------------------------------

export async function selectVCDSignals(
  ctx: StageContext,
  moduleName: string,
  checkerOutput: string,
  signalList: string[],
  funcDescription: string,
): Promise<string[]> {
  const messages = buildSignalSelectMessages(moduleName, checkerOutput, signalList, funcDescription);

  const startMs = Date.now();
  const response = await ctx.llm.complete(messages, { temperature: 0.0 });
  const durationMs = Date.now() - startMs;

  if (ctx.logTrace) {
    await ctx.logTrace({
      timestamp: new Date().toISOString(),
      role: 'RTLDesigner',
      promptTokens: response.usage.promptTokens,
      completionTokens: response.usage.completionTokens,
      durationMs,
      taskContext: `designer:signal-select:${moduleName}`,
      promptChars: promptChars(messages),
      responseChars: response.content.length,
      hasCodeBlock: false,
      retryCount: response.retryCount,
      summary: `Signal selection for ${moduleName}`,
      promptContent: messages,
      responseContent: response.content,
    });
  }

  // Parse JSON array from response
  try {
    const jsonMatch = response.content.match(/\[[\s\S]*?\]/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]) as unknown[];
      return parsed.filter((s): s is string => typeof s === 'string');
    }
  } catch {
    // Fall back to line-based parsing
  }

  // Fallback: extract quoted strings
  const quoted = [...response.content.matchAll(/"([^"]+)"/g)].map(m => m[1]);
  return quoted;
}

// ---------------------------------------------------------------------------
// debugFix — diagnose checker failure, fix RTL or flag tb_suspect
// ---------------------------------------------------------------------------

export async function debugFix(
  ctx: StageContext,
  moduleName: string,
  checkerOutput: string,
  funcDescription: string,
  verificationReqs?: string,
  debugHistory?: string[],
  vcdData?: string,
): Promise<DebugDiagnosis> {
  // Read current RTL code
  const filePath = `hw/src/hdl/${moduleName}.sv`;
  let rtlCode: string;
  try {
    rtlCode = await ctx.readFile(filePath);
  } catch {
    try {
      rtlCode = await ctx.readFile(`hw/src/hdl/${moduleName}.v`);
    } catch {
      return {
        diagnosis: 'fix',
        reason: `Cannot read RTL file for module "${moduleName}".`,
      };
    }
  }

  // Build messages: use verif-req variant if verification requirements provided
  const messages = verificationReqs
    ? buildRTLDebugWithVerifReqMessages(
        moduleName,
        checkerOutput,
        rtlCode,
        funcDescription,
        verificationReqs,
        debugHistory,
        vcdData,
      )
    : buildRTLDebugFixMessages(moduleName, checkerOutput, rtlCode, funcDescription, debugHistory, vcdData);

  const pChars = promptChars(messages);
  const startMs = Date.now();
  const response = await ctx.llm.complete(messages);
  const durationMs = Date.now() - startMs;

  const responseText = response.content;

  // Check for tb_suspect JSON first
  const tbSuspectMatch = responseText.match(/```json\s*\n?\s*\{[\s\S]*?"diagnosis"\s*:\s*"tb_suspect"[\s\S]*?\}\s*\n?\s*```/);
  if (tbSuspectMatch) {
    let reason = 'Testbench suspected by RTL Designer.';
    try {
      const jsonStr = tbSuspectMatch[0].replace(/```json\s*\n?/, '').replace(/\n?\s*```/, '');
      const parsed = JSON.parse(jsonStr) as Record<string, unknown>;
      if (typeof parsed['reason'] === 'string') {
        reason = parsed['reason'];
      }
    } catch {
      // Use default reason if JSON parsing fails
    }
    if (ctx.logTrace) {
      await ctx.logTrace({
        timestamp: new Date().toISOString(),
        role: 'RTLDesigner',
        promptTokens: response.usage.promptTokens,
        completionTokens: response.usage.completionTokens,
        durationMs,
        taskContext: `debugFix:${moduleName}`,
        promptChars: pChars,
        responseChars: responseText.length,
        hasCodeBlock: false,
        retryCount: response.retryCount,
        summary: `tb_suspect for ${moduleName}: ${reason.slice(0, 100)}`,
        promptContent: messages,
        responseContent: responseText,
      });
    }
    return { diagnosis: 'tb_suspect', reason };
  }

  // v3: Parse fix_summary from JSON block before code
  let fixSummary: string | undefined;
  const fixJsonMatch = responseText.match(/```json\s*\n?\s*(\{[\s\S]*?"diagnosis"\s*:\s*"fix"[\s\S]*?\})\s*\n?\s*```/);
  if (fixJsonMatch) {
    try {
      const parsed = JSON.parse(fixJsonMatch[1]) as Record<string, unknown>;
      if (typeof parsed['fix_summary'] === 'string') {
        fixSummary = parsed['fix_summary'];
      }
    } catch {
      // Ignore parse errors — fix_summary is best-effort
    }
  }

  // Otherwise, look for code blocks with the fix
  const { actions } = parseLLMResponse(responseText);
  const hasCode = actions.length > 0;

  if (ctx.logTrace) {
    const summaryStr = hasCode
      ? `fix applied for ${moduleName}${fixSummary ? ': ' + fixSummary.slice(0, 80) : ''}`
      : responseText.length === 0
        ? `EMPTY response for ${moduleName} (${durationMs}ms, ${response.usage.promptTokens} prompt tokens)`
        : `no code block in debugFix response for ${moduleName} (${responseText.length} chars)`;
    await ctx.logTrace({
      timestamp: new Date().toISOString(),
      role: 'RTLDesigner',
      promptTokens: response.usage.promptTokens,
      completionTokens: response.usage.completionTokens,
      durationMs,
      taskContext: `debugFix:${moduleName}${verificationReqs ? ':with_verif' : ''}`,
      promptChars: pChars,
      responseChars: responseText.length,
      hasCodeBlock: hasCode,
      retryCount: response.retryCount,
      summary: summaryStr,
      promptContent: messages,
      responseContent: responseText,
    });
  }

  if (hasCode) {
    const fixAction = actions[0]!;
    const fixedCode = fixAction.payload['content'] as string;
    const targetFile = (fixAction.payload['path'] as string) || filePath;

    // Write the fixed file
    try {
      await ctx.executeAction({
        type: 'writeFile',
        payload: { path: targetFile, content: fixedCode },
      });
    } catch {
      // Return the diagnosis even if write fails — caller can retry
    }

    return { diagnosis: 'fix', fixedCode, targetFile, fix_summary: fixSummary };
  }

  // No code blocks and no tb_suspect — return a fix diagnosis with no code
  return {
    diagnosis: 'fix',
    reason: 'LLM response did not contain extractable code blocks.',
    fix_summary: fixSummary,
  };
}
