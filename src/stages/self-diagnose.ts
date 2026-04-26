/**
 * Self-diagnosis stage (Phase 2a — gated, pre-infra-debug).
 *
 * Inserted exactly once in a module's lifetime, immediately before the
 * orchestrator escalates to functional infrastructure-debug. Asks the
 * LLM to step back from surface fixes and hypothesize the root cause.
 *
 * Design contract:
 *  - NO routing decision (no `suggestedRoute`). Routing belongs to the
 *    orchestrator's gating + budget logic, not to this LLM call.
 *  - Output is pure semantic content the next agent can consume.
 *  - Failure (LLM error / unparseable JSON) returns null — caller proceeds
 *    without diagnosis hint. Self-diagnose is best-effort.
 */

import type { AttemptRecord, SelfDiagnosis } from '../agents/types.js';
import type { OutputChunk, StageContext } from './types.js';
import type { Message } from '../llm/types.js';
import { buildSelfDiagnosisMessages } from '../agents/context-builder.js';

function promptChars(msgs: Message[]): number {
  return msgs.reduce((sum, m) => sum + m.content.length, 0);
}

/**
 * Run the self-diagnosis LLM call. Returns null if the LLM output cannot
 * be parsed into a SelfDiagnosis — the caller should treat null as "no
 * diagnosis available" and proceed with normal escalation.
 */
export async function selfDiagnose(
  ctx: StageContext,
  moduleName: string,
  spec: string,
  recentError: string,
  attemptHistory: AttemptRecord[],
): Promise<SelfDiagnosis | null> {
  const messages = buildSelfDiagnosisMessages(moduleName, spec, recentError, attemptHistory);

  let response;
  const startMs = Date.now();
  try {
    response = await ctx.llm.complete(messages, { temperature: 0.0, signal: ctx.signal });
  } catch {
    return null;
  }
  const durationMs = Date.now() - startMs;

  const parsed = parseDiagnosisJson(response.content);

  if (ctx.logTrace) {
    await ctx.logTrace({
      timestamp: new Date().toISOString(),
      role: 'SelfDiagnose',
      module: moduleName,
      promptTokens: response.usage.promptTokens,
      completionTokens: response.usage.completionTokens,
      durationMs,
      taskContext: `selfDiagnose:${moduleName}`,
      promptChars: promptChars(messages),
      responseChars: response.content.length,
      retryCount: response.retryCount,
      summary: parsed
        ? `diagnosis(${parsed.confidence}): ${parsed.rootCauseHypothesis.slice(0, 100)}`
        : `diagnosis parse failed for ${moduleName}`,
      promptContent: messages,
      responseContent: response.content,
    });
  }

  return parsed;
}

/**
 * Format a diagnosis as a hint string ready to template into
 * runInfraDebug's oscillationHint parameter. Combines with any existing
 * pattern hint via simple newline concatenation upstream.
 */
export function formatDiagnosisAsHint(diagnosis: SelfDiagnosis): string {
  const parts: string[] = [
    `Root-cause hypothesis (confidence: ${diagnosis.confidence}): ${diagnosis.rootCauseHypothesis}`,
  ];
  if (diagnosis.additionalContext) {
    parts.push(`Additional observation: ${diagnosis.additionalContext}`);
  }
  return parts.join('\n');
}

// ---------------------------------------------------------------------------
// JSON parsing
// ---------------------------------------------------------------------------

function parseDiagnosisJson(text: string): SelfDiagnosis | null {
  // Try fenced code block first
  const block = /```json\s*\n([\s\S]*?)```/.exec(text);
  let candidate: string | undefined;
  if (block) {
    candidate = block[1];
  } else {
    // Fall back to first { ... } that parses
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start >= 0 && end > start) {
      candidate = text.slice(start, end + 1);
    }
  }
  if (!candidate) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate);
  } catch {
    return null;
  }

  if (!parsed || typeof parsed !== 'object') return null;
  const obj = parsed as Record<string, unknown>;

  const hypothesis = obj['rootCauseHypothesis'];
  const confidence = obj['confidence'];
  if (typeof hypothesis !== 'string' || hypothesis.trim().length === 0) return null;
  if (confidence !== 'low' && confidence !== 'medium' && confidence !== 'high') return null;

  const additional = typeof obj['additionalContext'] === 'string' ? obj['additionalContext'] : undefined;

  return {
    rootCauseHypothesis: hypothesis,
    confidence,
    ...(additional && additional.trim().length > 0 ? { additionalContext: additional } : {}),
  };
}

// Re-export type for stage consumers' convenience
export type { SelfDiagnosis };

// Bag of chunk-yielding utilities is unused for this stage — single LLM
// call, no streaming required. Kept consistent with other stage modules
// by exporting OutputChunk for future expansion.
export type { OutputChunk };
