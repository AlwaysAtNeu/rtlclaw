/**
 * Architect Phase 2: Per-module detailed design.
 *
 * Given the Phase 1 global architecture and a specific module name,
 * produces a detailed functional specification, FSM descriptions,
 * timing notes, boundary conditions, and UT verification requirements.
 *
 * This stage is NOT shown to the user — it only yields 'progress' chunks.
 */

import type { LLMResponse, Message } from '../llm/types.js';
import type {
  ArchitectPhase1Output,
  ArchitectPhase2Output,
  FailureReport,
  ModuleVerificationReq,
} from '../agents/types.js';
import type { StageContext, OutputChunk } from './types.js';
import {
  buildArchitectP2Messages,
  buildArchitectP2RevisionMessages,
} from '../agents/context-builder.js';

function promptChars(msgs: Message[]): number {
  return msgs.reduce((sum, m) => sum + m.content.length, 0);
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_PARSE_RETRIES = 2;

// ---------------------------------------------------------------------------
// JSON extraction helpers
// ---------------------------------------------------------------------------

/**
 * Extract JSON from LLM text output.
 * Tries fenced code blocks first, then bare brace matching.
 */
function extractJsonFromText(text: string): unknown | null {
  // Fenced code block
  const fencedMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)```/);
  if (fencedMatch) {
    try {
      return JSON.parse(fencedMatch[1].trim());
    } catch {
      // fall through
    }
  }

  // Bare braces
  const firstBrace = text.indexOf('{');
  const lastBrace = text.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    try {
      return JSON.parse(text.slice(firstBrace, lastBrace + 1));
    } catch {
      // fall through
    }
  }

  return null;
}

/**
 * Validate and coerce a raw parsed object into ArchitectPhase2Output.
 */
function validatePhase2Output(raw: unknown, expectedModuleName: string): ArchitectPhase2Output {
  if (!raw || typeof raw !== 'object') {
    throw new Error('Parsed result is not an object');
  }

  const obj = raw as Record<string, unknown>;

  if (typeof obj.functionalSpec !== 'string' || !obj.functionalSpec) {
    throw new Error('Missing or empty "functionalSpec"');
  }

  // Build utVerification with defaults for missing fields
  const rawUt = (obj.utVerification ?? {}) as Record<string, unknown>;
  const utVerification: ModuleVerificationReq = {
    scenarios: Array.isArray(rawUt.scenarios)
      ? (rawUt.scenarios as unknown[]).map(String)
      : [],
    edgeCases: Array.isArray(rawUt.edgeCases)
      ? (rawUt.edgeCases as unknown[]).map(String)
      : [],
    expectedBehavior: Array.isArray(rawUt.expectedBehavior)
      ? (rawUt.expectedBehavior as unknown[]).map(String)
      : [],
  };

  const result: ArchitectPhase2Output = {
    moduleName: typeof obj.moduleName === 'string' ? obj.moduleName : expectedModuleName,
    functionalSpec: obj.functionalSpec as string,
    utVerification,
  };

  // Optional fields
  if (typeof obj.fsmDescription === 'string' && obj.fsmDescription) {
    result.fsmDescription = obj.fsmDescription;
  }
  if (typeof obj.timingNotes === 'string' && obj.timingNotes) {
    result.timingNotes = obj.timingNotes;
  }
  if (Array.isArray(obj.boundaryConditions) && obj.boundaryConditions.length > 0) {
    result.boundaryConditions = (obj.boundaryConditions as unknown[]).map(String);
  }

  return result;
}

// ---------------------------------------------------------------------------
// Logging helper
// ---------------------------------------------------------------------------

async function logLLMTrace(
  ctx: StageContext,
  response: LLMResponse,
  moduleName: string,
  messages: Message[],
  durationMs: number,
  parseSuccess: boolean,
): Promise<void> {
  if (!ctx.logTrace) return;
  await ctx.logTrace({
    timestamp: new Date().toISOString(),
    role: 'Architect-P2',
    module: moduleName,
    promptTokens: response.usage.promptTokens,
    completionTokens: response.usage.completionTokens,
    durationMs,
    taskContext: `architect_p2:${moduleName}`,
    promptChars: promptChars(messages),
    responseChars: response.content.length,
    hasCodeBlock: false,
    retryCount: response.retryCount,
    summary: parseSuccess
      ? `P2 design generated for ${moduleName}`
      : `P2 parse failed for ${moduleName}`,
    promptContent: messages,
    responseContent: response.content,
  });
}

// ---------------------------------------------------------------------------
// Main generator: runArchitectPhase2
// ---------------------------------------------------------------------------

export async function* runArchitectPhase2(
  ctx: StageContext,
  phase1Output: ArchitectPhase1Output,
  moduleName: string,
): AsyncGenerator<OutputChunk> {
  yield {
    type: 'progress',
    content: `Architect Phase 2: generating detailed design for module "${moduleName}"...`,
  };

  let messages = buildArchitectP2Messages(phase1Output, moduleName);
  let phase2Output: ArchitectPhase2Output | null = null;

  for (let attempt = 0; attempt <= MAX_PARSE_RETRIES; attempt++) {
    if (attempt > 0) {
      yield {
        type: 'progress',
        content: `Retrying Phase 2 parse for "${moduleName}" (attempt ${attempt + 1})...`,
      };
    }

    let response: LLMResponse;
    const startMs = Date.now();
    try {
      response = await ctx.llm.complete(messages, { temperature: 0.2, signal: ctx.signal });
    } catch (err) {
      yield {
        type: 'error',
        content: `LLM call failed for Phase 2 design of "${moduleName}": ${err instanceof Error ? err.message : String(err)}`,
      };
      return;
    }
    const durationMs = Date.now() - startMs;

    const parsed = extractJsonFromText(response.content);
    if (parsed !== null) {
      try {
        phase2Output = validatePhase2Output(parsed, moduleName);
        await logLLMTrace(ctx, response, moduleName, messages, durationMs, true);
        break; // success
      } catch (parseErr) {
        const errMsg = parseErr instanceof Error ? parseErr.message : String(parseErr);
        await logLLMTrace(ctx, response, moduleName, messages, durationMs, false);
        if (attempt < MAX_PARSE_RETRIES) {
          yield {
            type: 'progress',
            content: `Phase 2 validation error for "${moduleName}": ${errMsg}. Retrying...`,
          };
          // Append correction hint for the retry
          messages = [
            ...messages,
            { role: 'assistant', content: response.content },
            {
              role: 'user',
              content: `Your response could not be validated. Error: ${errMsg}\nPlease respond with a valid JSON object matching the required schema. Make sure "functionalSpec" is a non-empty string and "utVerification" has scenarios, edgeCases, and expectedBehavior arrays.`,
            },
          ];
        } else {
          yield {
            type: 'error',
            content: `Failed to parse Phase 2 output for "${moduleName}" after ${MAX_PARSE_RETRIES + 1} attempts: ${errMsg}`,
          };
          return;
        }
      }
    } else {
      await logLLMTrace(ctx, response, moduleName, messages, durationMs, false);
      if (attempt < MAX_PARSE_RETRIES) {
        yield {
          type: 'progress',
          content: `No JSON found in Phase 2 response for "${moduleName}". Retrying...`,
        };
        messages = [
          ...messages,
          { role: 'assistant', content: response.content },
          {
            role: 'user',
            content: 'Your response did not contain valid JSON. Please respond with ONLY a JSON object matching the required schema.',
          },
        ];
      } else {
        yield {
          type: 'error',
          content: `No valid JSON found in Phase 2 response for "${moduleName}" after ${MAX_PARSE_RETRIES + 1} attempts.`,
        };
        return;
      }
    }
  }

  if (!phase2Output) {
    yield {
      type: 'error',
      content: `Architect Phase 2 produced no output for module "${moduleName}".`,
    };
    return;
  }

  yield {
    type: 'progress',
    content: `Phase 2 design complete for "${moduleName}": ${phase2Output.utVerification.scenarios.length} test scenarios defined.`,
  };

  // Yield final result with metadata (not 'text' — Phase 2 is internal)
  yield {
    type: 'status',
    content: `Architect Phase 2 complete for "${moduleName}".`,
    metadata: { phase2Output },
  };
}

// ---------------------------------------------------------------------------
// runP2Revision (Phase 2b — cross-stage failure feedback)
// ---------------------------------------------------------------------------

/**
 * Result of an Architect P2 revision request. Two terminal shapes:
 *  - { phase2: ArchitectPhase2Output } — architect issued a revised spec
 *  - { revisionNotHelpful: true, reason: '...' } — architect declared this
 *    module cannot be addressed at the P2 layer (orchestrator still consumes
 *    one budget unit; reason flows into PastRevisionEntry.declaredReason)
 *  - { error: '...' } — LLM call or parse failed; orchestrator should
 *    treat as `manual_escalation` (no budget refunded — the LLM was paid)
 */
export type P2RevisionResult =
  | { kind: 'revised'; phase2: ArchitectPhase2Output }
  | { kind: 'not_helpful'; reason: string }
  | { kind: 'error'; reason: string };

/**
 * Request a revised P2 specification given the previous P2 JSON and a
 * structured FailureReport summarizing why the previous spec didn't
 * converge. The architect prompt allows either a revised spec or an
 * explicit `revisionNotHelpful` declaration.
 */
export async function* runP2Revision(
  ctx: StageContext,
  prevP2JSON: string,
  failure: FailureReport,
): AsyncGenerator<OutputChunk, P2RevisionResult> {
  const moduleName = failure.module;
  yield {
    type: 'progress',
    content: `Architect P2 revision: requesting revised spec for "${moduleName}"...`,
  };

  let messages = buildArchitectP2RevisionMessages(prevP2JSON, failure);

  for (let attempt = 0; attempt <= MAX_PARSE_RETRIES; attempt++) {
    if (attempt > 0) {
      yield {
        type: 'progress',
        content: `Retrying P2 revision parse for "${moduleName}" (attempt ${attempt + 1})...`,
      };
    }

    let response: LLMResponse;
    const startMs = Date.now();
    try {
      response = await ctx.llm.complete(messages, { temperature: 0.2, signal: ctx.signal });
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      yield { type: 'error', content: `LLM call failed for P2 revision of "${moduleName}": ${errMsg}` };
      return { kind: 'error', reason: `LLM call failed: ${errMsg}` };
    }
    const durationMs = Date.now() - startMs;

    const parsed = extractJsonFromText(response.content);
    if (parsed === null) {
      await logLLMTrace(ctx, response, moduleName, messages, durationMs, false);
      if (attempt < MAX_PARSE_RETRIES) {
        yield { type: 'progress', content: `No JSON in P2 revision response for "${moduleName}". Retrying...` };
        messages = [
          ...messages,
          { role: 'assistant', content: response.content },
          { role: 'user', content: 'Your response did not contain valid JSON. Output ONLY a JSON object — either a revised P2 spec or { revisionNotHelpful: true, reason: "..." }.' },
        ];
        continue;
      }
      yield { type: 'error', content: `No valid JSON in P2 revision after ${MAX_PARSE_RETRIES + 1} attempts.` };
      return { kind: 'error', reason: 'Architect produced no parseable JSON for revision request.' };
    }

    // Branch 1: revisionNotHelpful declaration
    if (typeof parsed === 'object' && parsed !== null && (parsed as Record<string, unknown>)['revisionNotHelpful'] === true) {
      const reasonField = (parsed as Record<string, unknown>)['reason'];
      const reason = typeof reasonField === 'string' && reasonField.trim().length > 0
        ? reasonField
        : 'Architect declared revision-not-helpful without a reason.';
      await logLLMTrace(ctx, response, moduleName, messages, durationMs, true);
      yield { type: 'status', content: `Architect declared revision not helpful for "${moduleName}": ${reason.slice(0, 200)}` };
      return { kind: 'not_helpful', reason };
    }

    // Branch 2: revised P2 spec
    try {
      const phase2 = validatePhase2Output(parsed, moduleName);
      await logLLMTrace(ctx, response, moduleName, messages, durationMs, true);
      yield { type: 'status', content: `P2 revision accepted for "${moduleName}": ${phase2.utVerification.scenarios.length} scenarios.` };
      return { kind: 'revised', phase2 };
    } catch (parseErr) {
      const errMsg = parseErr instanceof Error ? parseErr.message : String(parseErr);
      await logLLMTrace(ctx, response, moduleName, messages, durationMs, false);
      if (attempt < MAX_PARSE_RETRIES) {
        yield { type: 'progress', content: `P2 revision validation error for "${moduleName}": ${errMsg}. Retrying...` };
        messages = [
          ...messages,
          { role: 'assistant', content: response.content },
          { role: 'user', content: `Your response could not be validated. Error: ${errMsg}\nOutput ONLY a valid JSON object — either a revised P2 spec or { revisionNotHelpful: true, reason: "..." }.` },
        ];
        continue;
      }
      yield { type: 'error', content: `P2 revision parse failed after ${MAX_PARSE_RETRIES + 1} attempts: ${errMsg}` };
      return { kind: 'error', reason: `Validation failed: ${errMsg}` };
    }
  }

  // Unreachable — loop body always returns
  return { kind: 'error', reason: 'P2 revision loop exhausted without resolution.' };
}
