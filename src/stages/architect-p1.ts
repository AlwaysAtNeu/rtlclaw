/**
 * Architect Phase 1: Global architecture design.
 *
 * Two-step process:
 *  1. Requirements analysis — clarify missing info with user BEFORE designing
 *  2. Architecture design — produce module decomposition based on confirmed requirements
 *
 * The user confirms, requests modifications, or rejects the design.
 */

import type { Message, LLMResponse } from '../llm/types.js';
import type {
  ArchitectPhase1Output,
  ArchitectModuleBrief,
  DesignIndex,
  ModuleEntry,
  HierarchyNode,
  InterfaceContract,
  InterfaceContractSignal,
  TopPort,
  GlobalParameters,
} from '../agents/types.js';
import type { StageContext, OutputChunk } from './types.js';
import {
  buildRequirementsAnalysisMessages,
  buildArchitectP1Messages,
  buildArchitectP1RevisionMessages,
} from '../agents/context-builder.js';
import { ARCHITECT_TOOL_SCHEMA } from '../agents/prompts.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_PARSE_RETRIES = 2;

// ---------------------------------------------------------------------------
// JSON extraction helpers
// ---------------------------------------------------------------------------

/**
 * Try to extract a JSON object from free-form LLM text output.
 * Looks for ```json fenced blocks first, then bare top-level braces.
 */
function extractJsonFromText(text: string): unknown | null {
  // Try fenced code block first
  const fencedMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)```/);
  if (fencedMatch) {
    try {
      return JSON.parse(fencedMatch[1].trim());
    } catch {
      // fall through
    }
  }

  // Try to find the outermost { ... }
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
 * Strip any HDL code blocks from LLM text output.
 * This is a safety net: the architect prompt forbids code, but LLMs may still include it.
 */
function stripHdlCodeBlocks(text: string): string {
  // Remove fenced code blocks with HDL language tags
  let cleaned = text.replace(/```(?:verilog|systemverilog|sv|vhdl|hdl)[^\n]*\n[\s\S]*?```/gi, '');
  // Remove inline Verilog module declarations (module ... endmodule)
  cleaned = cleaned.replace(/\bmodule\s+\w+[\s\S]*?\bendmodule\b/g, '');
  // Remove inline always blocks
  cleaned = cleaned.replace(/\balways\s*@[\s\S]*?\bend\b/g, '');
  // Remove inline assign statements
  cleaned = cleaned.replace(/\bassign\s+\w+\s*=.*;/g, '');
  return cleaned;
}

/**
 * Check if text contains HDL code patterns (Verilog/SV/VHDL).
 */
function containsHdlCode(text: string): boolean {
  // Fenced HDL code blocks
  if (/```(?:verilog|systemverilog|sv|vhdl|hdl)/i.test(text)) return true;
  // Inline Verilog patterns
  if (/\bmodule\s+\w+\s*[#(]/.test(text)) return true;
  if (/\balways\s*@\s*\(/.test(text)) return true;
  if (/\bendmodule\b/.test(text)) return true;
  return false;
}

/**
 * Validate and coerce a raw parsed object into ArchitectPhase1Output.
 * Throws if required fields are missing.
 */
function validatePhase1Output(raw: unknown): ArchitectPhase1Output {
  if (!raw || typeof raw !== 'object') {
    throw new Error('Parsed result is not an object');
  }

  const obj = raw as Record<string, unknown>;

  if (!Array.isArray(obj.modules) || obj.modules.length === 0) {
    throw new Error('Missing or empty "modules" array');
  }
  if (!Array.isArray(obj.topModules) || obj.topModules.length === 0) {
    throw new Error('Missing or empty "topModules" array');
  }
  if (!Array.isArray(obj.dependencyOrder) || obj.dependencyOrder.length === 0) {
    throw new Error('Missing or empty "dependencyOrder" array');
  }

  const modules: ArchitectModuleBrief[] = (obj.modules as unknown[]).map((m) => {
    const mod = m as Record<string, unknown>;
    return {
      name: String(mod.name ?? ''),
      description: String(mod.description ?? ''),
      ports: Array.isArray(mod.ports)
        ? (mod.ports as unknown[]).map((p) => {
            const port = p as Record<string, unknown>;
            return {
              name: String(port.name ?? ''),
              direction: (port.direction as 'input' | 'output' | 'inout') ?? 'input',
              width: Number(port.width ?? 1),
              widthExpr: String(port.widthExpr ?? ''),
            };
          })
        : [],
      params: Array.isArray(mod.params)
        ? (mod.params as unknown[]).map((p) => {
            const param = p as Record<string, unknown>;
            return {
              name: String(param.name ?? ''),
              defaultValue: String(param.defaultValue ?? ''),
            };
          })
        : [],
      instances: Array.isArray(mod.instances)
        ? (mod.instances as unknown[]).map((i) => {
            const inst = i as Record<string, unknown>;
            return {
              moduleName: String(inst.moduleName ?? ''),
              instanceName: String(inst.instanceName ?? ''),
            };
          })
        : [],
      estimatedLines: Number(mod.estimatedLines ?? 100),
    };
  });

  const stVerification = obj.stVerification as Record<string, unknown> | undefined;

  const result: ArchitectPhase1Output = {
    modules,
    topModules: (obj.topModules as unknown[]).map(String),
    dependencyOrder: (obj.dependencyOrder as unknown[]).map(String),
    stVerification: {
      scenarios: Array.isArray(stVerification?.scenarios)
        ? (stVerification!.scenarios as unknown[]).map(String)
        : [],
      integrationPaths: Array.isArray(stVerification?.integrationPaths)
        ? (stVerification!.integrationPaths as unknown[]).map(String)
        : [],
    },
  };

  // Optional fields
  if (Array.isArray(obj.clockDomains)) {
    result.clockDomains = (obj.clockDomains as unknown[]).map((cd) => {
      const d = cd as Record<string, unknown>;
      return { name: String(d.name ?? ''), frequencyMhz: Number(d.frequencyMhz ?? 0) };
    });
  }
  if (typeof obj.resetStrategy === 'string') {
    result.resetStrategy = obj.resetStrategy;
  }
  if (obj.pipelineStages && typeof obj.pipelineStages === 'object') {
    result.pipelineStages = obj.pipelineStages as Record<string, number>;
  }

  // v3: Interface contracts
  if (Array.isArray(obj.interfaceContracts)) {
    result.interfaceContracts = (obj.interfaceContracts as unknown[]).map((ic) => {
      const c = ic as Record<string, unknown>;
      const signals: InterfaceContractSignal[] = Array.isArray(c.signals)
        ? (c.signals as unknown[]).map((s) => {
            const sig = s as Record<string, unknown>;
            return {
              name: String(sig.name ?? ''),
              direction: (sig.direction as 'input' | 'output') ?? 'output',
              width: Number(sig.width ?? 1),
              widthExpr: sig.widthExpr ? String(sig.widthExpr) : undefined,
              description: sig.description ? String(sig.description) : undefined,
            };
          })
        : [];
      return {
        name: String(c.name ?? ''),
        protocol: String(c.protocol ?? ''),
        producer: String(c.producer ?? ''),
        consumers: Array.isArray(c.consumers) ? (c.consumers as unknown[]).map(String) : [],
        signals,
        timing: String(c.timing ?? ''),
        dataFormat: c.dataFormat ? String(c.dataFormat) : undefined,
        signalMapping: c.signalMapping as Record<string, Record<string, string>> | undefined,
      } satisfies InterfaceContract;
    });
  }

  // v3: Top ports
  if (Array.isArray(obj.topPorts)) {
    result.topPorts = (obj.topPorts as unknown[]).map((tp) => {
      const p = tp as Record<string, unknown>;
      return {
        name: String(p.name ?? ''),
        direction: (p.direction as 'input' | 'output' | 'inout') ?? 'input',
        width: Number(p.width ?? 1),
        widthExpr: p.widthExpr ? String(p.widthExpr) : undefined,
        mappedTo: p.mappedTo ? String(p.mappedTo) : undefined,
      } satisfies TopPort;
    });
  }

  // v3: Global parameters
  if (obj.globalParameters && typeof obj.globalParameters === 'object' && !Array.isArray(obj.globalParameters)) {
    const gp: GlobalParameters = {};
    for (const [key, value] of Object.entries(obj.globalParameters as Record<string, unknown>)) {
      if (typeof value === 'number' || typeof value === 'string') {
        gp[key] = value;
      }
    }
    if (Object.keys(gp).length > 0) {
      result.globalParameters = gp;
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Parse requirements analysis response
// ---------------------------------------------------------------------------

interface RequirementsAnalysis {
  understood: string;
  assumptions: Record<string, string>;
  questions: string[];
}

function parseRequirementsAnalysis(response: LLMResponse): RequirementsAnalysis {
  const text = stripHdlCodeBlocks(response.content);
  const parsed = extractJsonFromText(text);
  if (!parsed || typeof parsed !== 'object') {
    // If parse fails, return empty (proceed without questions)
    return { understood: '', assumptions: {}, questions: [] };
  }
  const obj = parsed as Record<string, unknown>;
  return {
    understood: String(obj.understood ?? ''),
    assumptions: (obj.assumptions && typeof obj.assumptions === 'object')
      ? obj.assumptions as Record<string, string>
      : {},
    questions: Array.isArray(obj.questions) ? obj.questions.map(String) : [],
  };
}

// ---------------------------------------------------------------------------
// Parse LLM response (function-call path + text fallback)
// ---------------------------------------------------------------------------

export function parsePhase1Response(response: LLMResponse): ArchitectPhase1Output {
  // Path 1: function calling — tool_calls with submit_architecture
  if (response.toolCalls.length > 0) {
    const call = response.toolCalls.find((tc) => tc.name === 'submit_architecture');
    if (call) {
      return validatePhase1Output(call.arguments);
    }
  }

  // Path 2: fallback — strip any code blocks, then extract JSON from text content
  const cleanedText = stripHdlCodeBlocks(response.content);
  const parsed = extractJsonFromText(cleanedText);
  if (parsed !== null) {
    return validatePhase1Output(parsed);
  }

  throw new Error('Could not parse Architect Phase 1 output: no tool call and no valid JSON found in response text');
}

// ---------------------------------------------------------------------------
// Logging helper
// ---------------------------------------------------------------------------

async function logLLMTrace(
  ctx: StageContext,
  response: LLMResponse,
  taskContext: string,
  extra?: { durationMs?: number; promptChars?: number; summary?: string; promptContent?: Array<{ role: string; content: string }> },
): Promise<void> {
  if (!ctx.logTrace) return;
  await ctx.logTrace({
    timestamp: new Date().toISOString(),
    role: 'Architect-P1',
    promptTokens: response.usage.promptTokens,
    completionTokens: response.usage.completionTokens,
    durationMs: extra?.durationMs ?? 0,
    taskContext,
    promptChars: extra?.promptChars,
    responseChars: response.content.length,
    retryCount: response.retryCount,
    summary: extra?.summary,
    promptContent: extra?.promptContent,
    responseContent: response.content,
  });
}

// ---------------------------------------------------------------------------
// Format requirements summary for display
// ---------------------------------------------------------------------------

function formatRequirementsSummary(
  analysis: RequirementsAnalysis,
  userAnswers?: string,
): string {
  const lines: string[] = [];
  lines.push('=== Requirements Analysis ===');
  lines.push('');

  if (analysis.understood) {
    lines.push(`Understanding: ${analysis.understood}`);
    lines.push('');
  }

  if (Object.keys(analysis.assumptions).length > 0) {
    lines.push('Design assumptions:');
    for (const [key, value] of Object.entries(analysis.assumptions)) {
      lines.push(`  - ${key}: ${value}`);
    }
    lines.push('');
  }

  if (userAnswers) {
    lines.push(`User clarifications: ${userAnswers}`);
    lines.push('');
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Build confirmed requirement string for P1
// ---------------------------------------------------------------------------

function buildConfirmedRequirement(
  originalRequirement: string,
  analysis: RequirementsAnalysis,
  userAnswers?: string,
): string {
  const parts: string[] = [];
  parts.push(`User requirement: ${originalRequirement}`);

  if (Object.keys(analysis.assumptions).length > 0) {
    parts.push('\nConfirmed design assumptions:');
    for (const [key, value] of Object.entries(analysis.assumptions)) {
      parts.push(`  - ${key}: ${value}`);
    }
  }

  if (userAnswers) {
    parts.push(`\nUser clarifications: ${userAnswers}`);
  }

  return parts.join('\n');
}

// ---------------------------------------------------------------------------
// Main generator: runArchitectPhase1
// ---------------------------------------------------------------------------

export async function* runArchitectPhase1(
  ctx: StageContext,
  requirement: string,
): AsyncGenerator<OutputChunk> {
  // =========================================================================
  // Step 1: Requirements Analysis — clarify before designing
  // =========================================================================

  yield { type: 'progress', content: 'Analyzing requirements...' };

  let analysis: RequirementsAnalysis = { understood: '', assumptions: {}, questions: [] };
  let userAnswers: string | undefined;

  try {
    const reqMessages = buildRequirementsAnalysisMessages(requirement);
    const reqStartMs = Date.now();
    const reqResponse = await ctx.llm.complete(reqMessages, { temperature: 0.2 });
    await logLLMTrace(ctx, reqResponse, 'architect_requirements_analysis', {
      durationMs: Date.now() - reqStartMs,
      promptChars: reqMessages.reduce((s, m) => s + m.content.length, 0),
      summary: `requirements analysis (${reqResponse.content.length} chars)`,
      promptContent: reqMessages,
    });
    analysis = parseRequirementsAnalysis(reqResponse);
  } catch (err) {
    // Requirements analysis is best-effort — LLM backend already retries transient errors.
    // If it still fails, proceed without it; the user will confirm architecture later anyway.
    yield {
      type: 'status',
      content: `Requirements analysis skipped: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  // Show analysis to user and ask for confirmation
  if (analysis.understood || Object.keys(analysis.assumptions).length > 0) {
    const analysisSummary = formatRequirementsSummary(analysis);
    yield { type: 'text', content: analysisSummary };

    if (ctx.autoMode) {
      yield { type: 'status', content: 'Auto-mode: proceeding with assumptions above.' };
    } else if (analysis.questions.length > 0) {
      // Format questions for the user
      const questionsText = analysis.questions
        .map((q, i) => `  ${i + 1}. ${q}`)
        .join('\n');
      yield {
        type: 'text',
        content: `Before designing, I need to clarify:\n${questionsText}\n\nPlease answer these questions, or type "proceed" to use the assumptions above.`,
      };

      const answer = await ctx.askUser(
        'Please answer the questions above (or "proceed" to use defaults):',
      );
      const trimmedAnswer = answer.trim().toLowerCase();
      if (trimmedAnswer !== 'proceed' && trimmedAnswer !== 'p' && trimmedAnswer !== '') {
        userAnswers = answer.trim();
      }
    } else {
      yield {
        type: 'confirm',
        content: 'Please review the assumptions above. Type "proceed" to continue or provide corrections.',
      };

      const answer = await ctx.askUser(
        'Confirm requirements? (proceed / <corrections>):',
      );
      const trimmedAnswer = answer.trim().toLowerCase();
      if (trimmedAnswer !== 'proceed' && trimmedAnswer !== 'p' && trimmedAnswer !== 'y' && trimmedAnswer !== 'yes' && trimmedAnswer !== '') {
        userAnswers = answer.trim();
      }
    }
  }

  // =========================================================================
  // Step 2: Architecture Design — with confirmed requirements
  // =========================================================================

  yield { type: 'progress', content: 'Designing global architecture (Phase 1)...' };

  // Build the complete requirement string with confirmed info
  const confirmedReq = buildConfirmedRequirement(requirement, analysis, userAnswers);
  let messages: Message[] = buildArchitectP1Messages(confirmedReq);
  let phase1Output: ArchitectPhase1Output | null = null;

  // Attempt LLM call with retries for parse failures
  for (let attempt = 0; attempt <= MAX_PARSE_RETRIES; attempt++) {
    yield {
      type: 'progress',
      content: attempt === 0
        ? 'Calling LLM for architecture design...'
        : `Retrying architecture parse (attempt ${attempt + 1})...`,
    };

    let response: LLMResponse;
    try {
      // Try function calling first
      response = await ctx.llm.complete(messages, {
        tools: [ARCHITECT_TOOL_SCHEMA as never],
        temperature: 0.3,
      });
    } catch (err) {
      // If function calling is unsupported or timed out, fall back to JSON-mode completion
      yield {
        type: 'progress',
        content: `Function calling unavailable, using JSON mode...`,
      };
      try {
        response = await ctx.llm.complete(messages, {
          temperature: 0.3,
          responseFormat: 'json',
        });
      } catch (innerErr) {
        yield {
          type: 'error',
          content: `LLM call failed: ${innerErr instanceof Error ? innerErr.message : String(innerErr)}`,
        };
        return;
      }
    }

    await logLLMTrace(ctx, response, 'architect_p1', {
      promptChars: messages.reduce((s, m) => s + m.content.length, 0),
      summary: `P1 architecture (${response.content.length} chars, ${response.toolCalls.length} tool calls)`,
      promptContent: messages,
    });

    const hadHdlCode = containsHdlCode(response.content);
    if (hadHdlCode) {
      yield {
        type: 'progress',
        content: 'Warning: Architect response contained HDL/RTL code (stripping before parse).',
      };
    }

    try {
      phase1Output = parsePhase1Response(response);
      // Parsed OK — if there was HDL code, warn but don't waste a retry
      if (hadHdlCode) {
        yield {
          type: 'progress',
          content: 'Architecture JSON parsed successfully despite HDL code presence.',
        };
      }
      break; // success
    } catch (parseErr) {
      const errMsg = parseErr instanceof Error ? parseErr.message : String(parseErr);
      if (attempt < MAX_PARSE_RETRIES) {
        // HDL code likely corrupted the JSON → tell LLM explicitly
        const correctionMsg = hadHdlCode
          ? `VIOLATION: Your response contained RTL/HDL code (module declarations, always blocks, etc.) which corrupted the JSON output. ` +
            `You are the ARCHITECT — you must NEVER write implementation code. ` +
            `Your ONLY output is a structured JSON object. Error: ${errMsg}\n` +
            `Please respond again with ONLY the JSON architecture object. No code, no Verilog/SystemVerilog/VHDL.`
          : `Your response could not be parsed as valid JSON. Error: ${errMsg}\n` +
            `Please respond with ONLY a valid JSON object matching the required schema. Do NOT include any code blocks.`;
        yield {
          type: 'progress',
          content: hadHdlCode
            ? `HDL code corrupted JSON parse. Retrying with explicit correction...`
            : `Parse error: ${errMsg}. Retrying...`,
        };
        const cleanContent = stripHdlCodeBlocks(response.content);
        messages = [
          ...messages,
          { role: 'assistant', content: cleanContent },
          { role: 'user', content: correctionMsg },
        ];
      } else {
        yield {
          type: 'error',
          content: `Failed to parse Architect Phase 1 output after ${MAX_PARSE_RETRIES + 1} attempts: ${errMsg}`,
        };
        return;
      }
    }
  }

  if (!phase1Output) {
    yield { type: 'error', content: 'Architect Phase 1 produced no output.' };
    return;
  }

  // =========================================================================
  // Step 3: Display architecture and get user confirmation
  // =========================================================================

  const summary = formatArchitectureSummary(phase1Output);
  yield { type: 'text', content: summary };

  let confirmed = false;

  while (!confirmed) {
    if (ctx.autoMode) {
      yield { type: 'status', content: 'Auto-mode: architecture approved automatically.' };
      confirmed = true;
      break;
    }

    yield {
      type: 'confirm',
      content: 'Do you approve this architecture? (approve / modify <feedback> / reject)',
    };

    const userResponse = await ctx.askUser(
      'Do you approve this architecture? (approve / modify <feedback> / reject)',
    );
    const trimmed = userResponse.trim().toLowerCase();

    if (trimmed === 'approve' || trimmed === 'yes' || trimmed === 'y') {
      yield { type: 'status', content: 'Architecture approved by user.' };
      confirmed = true;
    } else if (trimmed === 'reject' || trimmed === 'no' || trimmed === 'n') {
      yield { type: 'status', content: 'Architecture rejected by user.' };
      yield {
        type: 'error',
        content: 'Architecture design was rejected. Please provide new requirements.',
      };
      return;
    } else if (trimmed.startsWith('modify')) {
      // Extract modification feedback
      const feedback = userResponse.replace(/^modify\s*/i, '').trim();
      if (!feedback) {
        yield { type: 'text', content: 'Please provide modification feedback after "modify".' };
        continue;
      }

      yield {
        type: 'progress',
        content: `Revising architecture based on feedback: "${feedback.slice(0, 80)}${feedback.length > 80 ? '...' : ''}"`,
      };

      // Build revision messages and re-run
      const prevJSON = JSON.stringify(phase1Output, null, 2);
      const revisionMessages = buildArchitectP1RevisionMessages(prevJSON, feedback);

      let revisionOutput: ArchitectPhase1Output | null = null;
      for (let attempt = 0; attempt <= MAX_PARSE_RETRIES; attempt++) {
        let response: LLMResponse;
        try {
          response = await ctx.llm.complete(revisionMessages, {
            tools: [ARCHITECT_TOOL_SCHEMA as never],
            temperature: 0.3,
          });
        } catch {
          try {
            response = await ctx.llm.complete(revisionMessages, { temperature: 0.3, responseFormat: 'json' });
          } catch (innerErr) {
            yield {
              type: 'error',
              content: `LLM revision call failed: ${innerErr instanceof Error ? innerErr.message : String(innerErr)}`,
            };
            return;
          }
        }

        await logLLMTrace(ctx, response, 'architect_p1_revision');

        try {
          revisionOutput = parsePhase1Response(response);
          break;
        } catch (parseErr) {
          if (attempt >= MAX_PARSE_RETRIES) {
            yield {
              type: 'error',
              content: `Failed to parse revised architecture: ${parseErr instanceof Error ? parseErr.message : String(parseErr)}`,
            };
            return;
          }
        }
      }

      if (revisionOutput) {
        phase1Output = revisionOutput;
        const revisedSummary = formatArchitectureSummary(phase1Output);
        yield { type: 'text', content: revisedSummary };
      }
    } else {
      // Unrecognized input — re-prompt
      yield {
        type: 'text',
        content: `Unrecognized response: "${trimmed}". Please enter: approve, modify <feedback>, or reject.`,
      };
      continue;
    }
  }

  // Yield final result with metadata
  yield {
    type: 'status',
    content: 'Architect Phase 1 complete.',
    metadata: { phase1Output },
  };
}

// ---------------------------------------------------------------------------
// convertToDesignIndex
// ---------------------------------------------------------------------------

/**
 * Convert ArchitectPhase1Output into a DesignIndex for downstream stages.
 * Since Phase 1 does not produce files yet, file paths are placeholders.
 */
export function convertToDesignIndex(phase1: ArchitectPhase1Output): DesignIndex {
  const modules: ModuleEntry[] = phase1.modules.map((mod) => ({
    name: mod.name,
    file: `hw/src/hdl/${mod.name}.v`,
    language: 'verilog' as const,
    ports: mod.ports,
    params: mod.params,
    instances: mod.instances.map((inst) => ({
      moduleName: inst.moduleName,
      instanceName: inst.instanceName,
      file: `hw/src/hdl/${inst.moduleName}.v`,
      line: 0,
    })),
    estimatedLines: mod.estimatedLines,
    semanticSummary: mod.description,
  }));

  // Build hierarchy tree from the module list
  const hierarchy = buildHierarchy(phase1);

  return {
    modules,
    hierarchy,
    topModules: [...phase1.topModules],
    timestamp: new Date().toISOString(),
  };
}

/**
 * Build HierarchyNode[] from Phase 1 output.
 * Top modules are roots; children are derived from each module's instances array.
 */
function buildHierarchy(phase1: ArchitectPhase1Output): HierarchyNode[] {
  const moduleMap = new Map(phase1.modules.map((m) => [m.name, m]));

  function buildNode(moduleName: string, instanceName: string): HierarchyNode {
    const mod = moduleMap.get(moduleName);
    const children: HierarchyNode[] = mod
      ? mod.instances.map((inst) => buildNode(inst.moduleName, inst.instanceName))
      : [];
    return { moduleName, instanceName, children };
  }

  return phase1.topModules.map((topName) => buildNode(topName, topName));
}

// ---------------------------------------------------------------------------
// formatArchitectureSummary
// ---------------------------------------------------------------------------

/**
 * Format a human-readable summary of the Phase 1 architecture for display.
 */
export function formatArchitectureSummary(phase1: ArchitectPhase1Output): string {
  const lines: string[] = [];

  lines.push('=== Architecture Design ===');
  lines.push('');
  lines.push(`Top modules: ${phase1.topModules.join(', ')}`);
  lines.push(`Dependency order: ${phase1.dependencyOrder.join(' -> ')}`);

  if (phase1.clockDomains?.length) {
    lines.push('');
    lines.push('Clock domains:');
    for (const cd of phase1.clockDomains) {
      lines.push(`  - ${cd.name}: ${cd.frequencyMhz} MHz`);
    }
  }

  if (phase1.resetStrategy) {
    lines.push(`Reset strategy: ${phase1.resetStrategy}`);
  }

  lines.push('');
  lines.push('Modules:');
  for (const mod of phase1.modules) {
    lines.push(`  ${mod.name} (~${mod.estimatedLines} lines)`);
    // Show description with proper indentation
    for (const descLine of mod.description.split('\n')) {
      lines.push(`    ${descLine}`);
    }

    if (mod.ports.length > 0) {
      lines.push('    Ports:');
      for (const p of mod.ports) {
        const w = p.widthExpr || (p.width > 1 ? `[${p.width - 1}:0]` : '');
        lines.push(`      ${p.direction} ${w} ${p.name}`.trimEnd());
      }
    }

    if (mod.params.length > 0) {
      lines.push('    Parameters:');
      for (const param of mod.params) {
        lines.push(`      ${param.name} = ${param.defaultValue}`);
      }
    }

    if (mod.instances.length > 0) {
      lines.push(`    Instantiates: ${mod.instances.map((i) => `${i.moduleName} (${i.instanceName})`).join(', ')}`);
    }

    lines.push('');
  }

  if (phase1.stVerification.scenarios.length > 0) {
    lines.push('System test scenarios:');
    for (const s of phase1.stVerification.scenarios) {
      lines.push(`  - ${s}`);
    }
  }

  if (phase1.stVerification.integrationPaths.length > 0) {
    lines.push('Integration paths:');
    for (const p of phase1.stVerification.integrationPaths) {
      lines.push(`  - ${p}`);
    }
  }

  // v3: Interface contracts
  if (phase1.interfaceContracts?.length) {
    lines.push('');
    lines.push('Interface contracts:');
    for (const ic of phase1.interfaceContracts) {
      lines.push(`  ${ic.name}: ${ic.protocol}`);
      lines.push(`    Producer: ${ic.producer} -> Consumers: ${ic.consumers.join(', ')}`);
      lines.push(`    Timing: ${ic.timing}`);
      if (ic.dataFormat) lines.push(`    Data format: ${ic.dataFormat}`);
      lines.push(`    Signals: ${ic.signals.map(s => s.name).join(', ')}`);
    }
  }

  // v3: Top ports
  if (phase1.topPorts?.length) {
    lines.push('');
    lines.push('Top-level ports:');
    for (const tp of phase1.topPorts) {
      const w = tp.widthExpr || (tp.width > 1 ? `[${tp.width - 1}:0]` : '');
      lines.push(`  ${tp.direction} ${w} ${tp.name}`.trimEnd());
    }
  }

  // v3: Global parameters
  if (phase1.globalParameters && Object.keys(phase1.globalParameters).length > 0) {
    lines.push('');
    lines.push('Global parameters:');
    for (const [key, value] of Object.entries(phase1.globalParameters)) {
      lines.push(`  ${key} = ${value}`);
    }
  }

  return lines.join('\n');
}
