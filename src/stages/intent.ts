/**
 * Intent classification stage for RTL-Claw v2.
 *
 * Classifies user messages into: new_project, additive_change, spec_change,
 * module_redo, question, general.
 */

import type { LLMBackend } from '../llm/base.js';
import type { IntentClassification } from '../agents/types.js';
import type { LLMTraceEntry } from './types.js';
import { buildIntentClassificationMessages } from '../agents/context-builder.js';

// ---------------------------------------------------------------------------
// Quick heuristic check (no LLM call)
// ---------------------------------------------------------------------------

/**
 * Returns true if the message is very likely a question (skip full classification).
 */
export function quickQuestionCheck(message: string): boolean {
  const trimmed = message.trim();
  // English question patterns
  if (/^(what|how|why|when|where|can|does|is|are|do|could|would|should|explain|tell|describe|show)\b/i.test(trimmed)) {
    return true;
  }
  // Chinese question patterns
  if (/[？?]$/.test(trimmed)) return true;
  if (/^(什么|怎么|为什么|如何|能不能|是不是|请问|解释|说明)/.test(trimmed)) return true;
  return false;
}

/**
 * Quick heuristic check: does this message look like a design/build request?
 * Only messages that match this should go through full LLM intent classification.
 * Everything else goes straight to chat (no extra LLM round-trip).
 */
export function quickDesignRequestCheck(message: string): boolean {
  const trimmed = message.trim().toLowerCase();
  // English design action verbs — match anywhere (users often prefix with "please", "can you", "help me" etc.)
  if (/\b(design|create|build|implement|make|write|generate|add|modify|change|update|remove|delete|redo|refactor|replace|fix|rewrite)\b/i.test(trimmed)) {
    return true;
  }
  // Mentions of HDL / hardware concepts that suggest a design task
  if (/\b(module|rtl|verilog|vhdl|systemverilog|fpga|asic|testbench|synthesis)\b/i.test(trimmed) &&
      /\b(design|create|build|implement|write|generate|add|modify)\b/i.test(trimmed)) {
    return true;
  }
  // Chinese design patterns — match anywhere (users often prefix with 帮我/请/我想/能不能 etc.)
  if (/(设计|创建|实现|编写|生成|添加|修改|删除|重构|重写)/.test(trimmed)) {
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// LLM-based intent classification
// ---------------------------------------------------------------------------

/**
 * Classify user intent using LLM complete call.
 * Returns null if classification fails (caller should fall back to chat).
 */
export async function classifyIntent(
  llm: LLMBackend,
  userMessage: string,
  logTrace?: (entry: LLMTraceEntry) => Promise<void>,
): Promise<IntentClassification | null> {
  const messages = buildIntentClassificationMessages(userMessage);

  try {
    const start = Date.now();
    const response = await llm.complete(messages, { temperature: 0.0 });
    const durationMs = Date.now() - start;

    if (logTrace) {
      await logTrace({
        timestamp: new Date().toISOString(),
        role: 'intent',
        promptTokens: response.usage.promptTokens,
        completionTokens: response.usage.completionTokens,
        durationMs,
        taskContext: `classify: ${userMessage.slice(0, 80)}`,
      }).catch(() => {});
    }

    const parsed = parseJsonFromResponse(response.content);
    if (parsed && parsed['intent']) {
      return parsed as unknown as IntentClassification;
    }
  } catch {
    // Classification failed, fall through
  }

  return null;
}

// ---------------------------------------------------------------------------
// JSON parsing helper
// ---------------------------------------------------------------------------

function parseJsonFromResponse(text: string): Record<string, unknown> | null {
  // Try JSON code block first
  const jsonBlock = /```json\s*\n([\s\S]*?)```/.exec(text);
  if (jsonBlock) {
    try { return JSON.parse(jsonBlock[1]!) as Record<string, unknown>; } catch { /* fall through */ }
  }
  // Try raw JSON
  const braceStart = text.indexOf('{');
  const braceEnd = text.lastIndexOf('}');
  if (braceStart >= 0 && braceEnd > braceStart) {
    try { return JSON.parse(text.slice(braceStart, braceEnd + 1)) as Record<string, unknown>; } catch { /* ignore */ }
  }
  return null;
}
