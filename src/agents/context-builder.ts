/**
 * Context builder for RTL-Claw v3.
 *
 * CRITICAL: This implements context minimization — every agent call gets ONLY
 * the information it needs. NO full conversation history is ever passed.
 *
 * Each build* function returns a Message[] tailored for one specific LLM call.
 *
 * v3 additions: interface contracts in P2/RTL/VE contexts, debug history,
 * VE compile fix, ST triage messages.
 */

import type { Message } from '../llm/types.js';
import type {
  PortDef,
  DesignIndex,
  ArchitectPhase1Output,
  ArchitectPhase2Output,
  ArchitectModuleBrief,
  DesignRationale,
  InterfaceContract,
  AttemptRecord,
  FailureReport,
} from './types.js';
import { formatAttemptHistoryForPrompt } from '../utils/attempt-record.js';
import {
  INTENT_CLASSIFICATION_PROMPT,
  ARCHITECT_REQUIREMENTS_PROMPT,
  ARCHITECT_P1_PROMPT,
  ARCHITECT_P2_PROMPT,
  RTL_DESIGNER_PROMPT,
  RTL_DESIGNER_DEBUG_PROMPT,
  VE_UT_PROMPT,
  VE_ST_PROMPT,
  VE_TB_REVIEW_PROMPT,
  BE_PROMPT,
  ST_TRIAGE_PROMPT,
  VE_COMPILE_FIX_PROMPT,
  SPEC_CHECKER_AUDIT_PROMPT,
  SELF_DIAGNOSE_PROMPT,
  ARCHITECT_P2_REVISION_PROMPT,
  getHdlSyntaxRules,
} from './prompts.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatPortDefs(ports: PortDef[]): string {
  return ports.map(p => {
    const w = p.widthExpr || (p.width > 1 ? `[${p.width - 1}:0]` : '');
    return `  ${p.direction} ${w} ${p.name}`.trim();
  }).join('\n');
}

function formatModuleBrief(mod: ArchitectModuleBrief): string {
  const ports = formatPortDefs(mod.ports);
  const inst = mod.instances.length > 0
    ? `\nInstantiates: ${mod.instances.map(i => `${i.moduleName} (${i.instanceName})`).join(', ')}`
    : '';
  return `Module: ${mod.name}\nDescription: ${mod.description}\nPorts:\n${ports}${inst}`;
}

// ---------------------------------------------------------------------------
// v3: Interface contract helpers
// ---------------------------------------------------------------------------

export function formatInterfaceContracts(contracts: InterfaceContract[]): string {
  if (contracts.length === 0) return '';
  return contracts.map(c => {
    const signals = c.signals.map(s => {
      const w = s.widthExpr || (s.width > 1 ? `[${s.width - 1}:0]` : '');
      return `    ${s.direction} ${w} ${s.name}${s.description ? ` — ${s.description}` : ''}`.trim();
    }).join('\n');
    const mapping = c.signalMapping
      ? `\n  Signal mapping overrides: ${JSON.stringify(c.signalMapping)}`
      : '';
    return `Interface: ${c.name}
  Protocol: ${c.protocol}
  Producer: ${c.producer} → Consumers: ${c.consumers.join(', ')}
  Timing: ${c.timing}${c.dataFormat ? `\n  Data format: ${c.dataFormat}` : ''}
  Signals:\n${signals}${mapping}`;
  }).join('\n\n');
}

export function getRelevantContracts(
  contracts: InterfaceContract[],
  moduleName: string,
): InterfaceContract[] {
  return contracts.filter(
    c => c.producer === moduleName || c.consumers.includes(moduleName),
  );
}

/**
 * v3.2: Render the Architect's cross-cutting rationale as a short prompt
 * block. Returns '' if no rationale fields are populated, so callers can
 * concatenate unconditionally without leaking empty headers.
 */
export function formatDesignRationale(dr: DesignRationale | undefined): string {
  if (!dr) return '';
  const parts: string[] = [];
  if (dr.handshake) parts.push(`- Handshake: ${dr.handshake}`);
  if (dr.clockDomains) parts.push(`- Clocking: ${dr.clockDomains}`);
  if (dr.resetStrategy) parts.push(`- Reset: ${dr.resetStrategy}`);
  if (parts.length === 0) return '';
  return `Architect rationale (cross-cutting choices to honor):\n${parts.join('\n')}`;
}

function formatDesignIndexBrief(index: DesignIndex): string {
  const lines = index.modules.map(m => {
    const ports = m.ports.map(p => `${p.direction} ${p.name}`).join(', ');
    return `  ${m.name}: [${ports}]`;
  });
  return `Top modules: ${index.topModules.join(', ')}\nModules:\n${lines.join('\n')}`;
}

// ---------------------------------------------------------------------------
// Intent classification
// ---------------------------------------------------------------------------

export function buildIntentClassificationMessages(userMessage: string): Message[] {
  return [
    { role: 'system', content: INTENT_CLASSIFICATION_PROMPT },
    { role: 'user', content: userMessage },
  ];
}

// ---------------------------------------------------------------------------
// Architect: Requirements analysis (pre-design clarification)
// ---------------------------------------------------------------------------

export function buildRequirementsAnalysisMessages(requirement: string): Message[] {
  return [
    { role: 'system', content: ARCHITECT_REQUIREMENTS_PROMPT },
    { role: 'user', content: requirement },
  ];
}

// ---------------------------------------------------------------------------
// Architect Phase 1
// ---------------------------------------------------------------------------

/**
 * Build P1 messages with the full confirmed requirements
 * (original requirement + assumptions + user answers to questions).
 */
export function buildArchitectP1Messages(requirement: string): Message[] {
  return [
    { role: 'system', content: ARCHITECT_P1_PROMPT },
    { role: 'user', content: requirement },
  ];
}

export function buildArchitectP1RevisionMessages(
  prevArchJSON: string,
  modificationRequest: string,
): Message[] {
  return [
    { role: 'system', content: ARCHITECT_P1_PROMPT },
    {
      role: 'user',
      content: `Here is the previous architecture design:\n\`\`\`json\n${prevArchJSON}\n\`\`\`\n\nPlease revise it based on this feedback: ${modificationRequest}`,
    },
  ];
}

// ---------------------------------------------------------------------------
// Architect Phase 2
// ---------------------------------------------------------------------------

export function buildArchitectP2Messages(
  phase1Output: ArchitectPhase1Output,
  moduleName: string,
): Message[] {
  const mod = phase1Output.modules.find(m => m.name === moduleName);
  const globalSummary = phase1Output.modules.map(m =>
    `  ${m.name}: ${m.description} (${m.ports.length} ports)`
  ).join('\n');

  const modDetail = mod ? formatModuleBrief(mod) : `Module: ${moduleName}`;

  // v3: Include relevant interface contracts
  let contractsSection = '';
  if (phase1Output.interfaceContracts?.length) {
    const relevant = getRelevantContracts(phase1Output.interfaceContracts, moduleName);
    if (relevant.length > 0) {
      contractsSection = `\n\nRelevant interface contracts:\n${formatInterfaceContracts(relevant)}`;
    }
  }

  // v3.2: Carry Architect's cross-cutting rationale into P2
  const rationaleBlock = formatDesignRationale(phase1Output.designRationale);
  const rationaleSection = rationaleBlock ? `\n\n${rationaleBlock}` : '';

  return [
    { role: 'system', content: ARCHITECT_P2_PROMPT },
    {
      role: 'user',
      content: `Global architecture:\n${globalSummary}\n\nTop modules: ${phase1Output.topModules.join(', ')}\nDependency order: ${phase1Output.dependencyOrder.join(' -> ')}\n\nProvide detailed design for:\n${modDetail}${contractsSection}${rationaleSection}`,
    },
  ];
}

// ---------------------------------------------------------------------------
// Architect Phase 2 Revision (Phase 2b — cross-stage failure feedback)
// ---------------------------------------------------------------------------

/**
 * Build messages for the P2 revision call. Carries:
 *  - the previous P2 spec (JSON-stringified)
 *  - all past revisions for this module, each with the formatted attempt
 *    snapshot showing what was tried under that revision
 *  - the current FailureReport's attemptHistorySnapshot (under the most
 *    recent revision)
 *  - the optional rootCauseHypothesis from selfDiagnose (Phase 2a output)
 *
 * The pastRevisions section is the key part: it stops the architect from
 * proposing an equivalent of a prior revision by showing what failed under
 * each one, with the same negative-example framing used elsewhere.
 */
export function buildArchitectP2RevisionMessages(
  prevP2JSON: string,
  failure: FailureReport,
): Message[] {
  const sections: string[] = [];

  sections.push(`Previous module specification (your most recent version for "${failure.module}"):
\`\`\`json
${prevP2JSON}
\`\`\``);

  if (failure.pastRevisions.length > 0) {
    sections.push('Past revisions you have already issued for this module — DO NOT propose anything equivalent to these:');
    failure.pastRevisions.forEach((rev, i) => {
      const diagBlock = rev.diagnosisSnapshot
        ? `\n  Root-cause hypothesis at that time: ${rev.diagnosisSnapshot}`
        : '';
      const declaredBlock = rev.declaredReason
        ? `\n  Declared reason at that time (revision-not-helpful was used): ${rev.declaredReason}`
        : '';
      const outcomeStr = rev.outcome ?? 'in-progress';
      sections.push(`Revision #${i + 1} (target=${rev.target}, applied ${rev.appliedAt}, outcome=${outcomeStr}):${diagBlock}${declaredBlock}
  Attempts that ran under that revision:
${indentBlock(rev.attemptHistorySnapshot, '    ')}`);
    });
    sections.push('Note: if a hypothesis recurred across multiple past revisions, the issue is likely structural (P1-level) rather than spec-level — that is a strong signal to declare revisionNotHelpful with that reason.');
  }

  sections.push(`Failure context for this revision request:
  Reporting stage: ${failure.reportingStage}
  Pattern detected: ${failure.patternKind}

  Attempts under your most recent spec:
${indentBlock(failure.attemptHistorySnapshot, '  ')}`);

  if (failure.rootCauseHypothesis) {
    sections.push(`Root-cause hypothesis from upstream diagnosis (current):
  ${failure.rootCauseHypothesis}`);
  }

  sections.push(`Issue a revised P2 specification (or signal revisionNotHelpful if the issue is structural). Output JSON only.`);

  return [
    { role: 'system', content: ARCHITECT_P2_REVISION_PROMPT },
    { role: 'user', content: sections.join('\n\n') },
  ];
}

function indentBlock(block: string, prefix: string): string {
  return block.split('\n').map(l => `${prefix}${l}`).join('\n');
}

// ---------------------------------------------------------------------------
// RTL Designer: write module
// ---------------------------------------------------------------------------

export function buildRTLWriteMessages(
  phase2Design: ArchitectPhase2Output,
  dependentModulePorts: Array<{ name: string; ports: PortDef[] }>,
  hdlStandard?: string,
  interfaceContracts?: InterfaceContract[],
  attemptHistory?: AttemptRecord[],
  designRationale?: DesignRationale,
): Message[] {
  let prompt = RTL_DESIGNER_PROMPT;
  if (hdlStandard) {
    prompt += `\n\n${getHdlSyntaxRules(hdlStandard)}`;
  }

  let userContent = `Write RTL code for module "${phase2Design.moduleName}".

Functional specification:
${phase2Design.functionalSpec}`;

  if (phase2Design.fsmDescription) {
    userContent += `\n\nFSM design:\n${phase2Design.fsmDescription}`;
  }
  if (phase2Design.timingNotes) {
    userContent += `\n\nTiming notes:\n${phase2Design.timingNotes}`;
  }
  if (phase2Design.boundaryConditions?.length) {
    userContent += `\n\nBoundary conditions:\n${phase2Design.boundaryConditions.map(b => `- ${b}`).join('\n')}`;
  }

  if (dependentModulePorts.length > 0) {
    userContent += '\n\nDependency module ports (for instantiation):';
    for (const dep of dependentModulePorts) {
      userContent += `\n\n${dep.name}:\n${formatPortDefs(dep.ports)}`;
    }
  }

  // v3: Include relevant interface contracts
  if (interfaceContracts?.length) {
    userContent += `\n\nInterface contracts (define protocol/timing for this module's connections):\n${formatInterfaceContracts(interfaceContracts)}`;
  }

  // v3.2: Architect rationale (so Designer honors handshake/clocking/reset intent)
  const rationaleBlock = formatDesignRationale(designRationale);
  if (rationaleBlock) {
    userContent += `\n\n${rationaleBlock}`;
  }

  // v4: Negative-example framing of past attempts
  if (attemptHistory && attemptHistory.length > 0) {
    userContent += `\n\n${formatAttemptHistoryForPrompt(attemptHistory)}`;
  }

  return [
    { role: 'system', content: prompt },
    { role: 'user', content: userContent },
  ];
}

// ---------------------------------------------------------------------------
// RTL Designer: lint fix
// ---------------------------------------------------------------------------

export function buildRTLLintFixMessages(
  moduleName: string,
  lintOutput: string,
  rtlCode: string,
  hdlStandard?: string,
  attemptHistory?: AttemptRecord[],
): Message[] {
  let prompt = RTL_DESIGNER_PROMPT;
  if (hdlStandard) {
    prompt += `\n\n${getHdlSyntaxRules(hdlStandard)}`;
  }

  let content = `Fix lint errors in module "${moduleName}".

Lint output:
${lintOutput}

Current RTL code:
\`\`\`
${rtlCode}
\`\`\``;

  if (attemptHistory && attemptHistory.length > 0) {
    content += `\n\n${formatAttemptHistoryForPrompt(attemptHistory)}`;
  }

  content += `\n\nProvide the complete corrected file.`;

  return [
    { role: 'system', content: prompt },
    { role: 'user', content },
  ];
}

// ---------------------------------------------------------------------------
// RTL Designer: debug fix (checker-based, with tb_suspect ability)
// ---------------------------------------------------------------------------

export function buildRTLDebugFixMessages(
  moduleName: string,
  checkerOutput: string,
  rtlCode: string,
  funcDescription: string,
  attemptHistory?: AttemptRecord[],
  vcdData?: string,
  designRationale?: DesignRationale,
): Message[] {
  let userContent = `Module "${moduleName}" failed unit test.

Checker errors:
${checkerOutput}`;

  // v3: Include VCD waveform data when available (fallback debug)
  if (vcdData) {
    userContent += `\n\nVCD waveform data around error time:\n\`\`\`\n${vcdData}\n\`\`\`\nUse the waveform to trace signal transitions and identify the root cause.`;
  }

  userContent += `\n\nModule functional description:\n${funcDescription}`;

  // v3.2: Architect rationale — placed near the spec so debug fixes don't
  // accidentally undo cross-cutting choices (e.g. "switch to fanout because
  // simpler" when handshake mandates valid/ready for backpressure).
  const rationaleBlock = formatDesignRationale(designRationale);
  if (rationaleBlock) {
    userContent += `\n\n${rationaleBlock}`;
  }

  userContent += `\n\nCurrent RTL code:\n\`\`\`\n${rtlCode}\n\`\`\``;

  // v4: Negative-example framing of past attempts (placed at end, immediately
  // before the LLM responds, so the "DO NOT repeat" framing is fresh).
  if (attemptHistory && attemptHistory.length > 0) {
    userContent += `\n\n${formatAttemptHistoryForPrompt(attemptHistory)}`;
  }

  return [
    { role: 'system', content: RTL_DESIGNER_DEBUG_PROMPT },
    { role: 'user', content: userContent },
  ];
}

/**
 * When Designer is about to question TB, also show verification requirements
 * so they can compare TB expectations against Architect's spec.
 */
export function buildRTLDebugWithVerifReqMessages(
  moduleName: string,
  checkerOutput: string,
  rtlCode: string,
  funcDescription: string,
  verificationReqs: string,
  attemptHistory?: AttemptRecord[],
  vcdData?: string,
  designRationale?: DesignRationale,
): Message[] {
  let userContent = `Module "${moduleName}" failed unit test.

Checker errors:
${checkerOutput}`;

  // v3: Include VCD waveform data when available (fallback debug)
  if (vcdData) {
    userContent += `\n\nVCD waveform data around error time:\n\`\`\`\n${vcdData}\n\`\`\`\nUse the waveform to trace signal transitions and identify the root cause.`;
  }

  userContent += `\n\nModule functional description:\n${funcDescription}

Verification requirements (from Architect):
${verificationReqs}`;

  // v3.2: Architect rationale — placed before the RTL so it's part of the
  // spec context the Designer reasons against, not after the code.
  const rationaleBlock = formatDesignRationale(designRationale);
  if (rationaleBlock) {
    userContent += `\n\n${rationaleBlock}`;
  }

  userContent += `\n\nCurrent RTL code:\n\`\`\`\n${rtlCode}\n\`\`\`

If the checker expectations don't match the verification requirements, you may flag tb_suspect.`;

  // v4: Negative-example framing of past attempts at end of user message
  if (attemptHistory && attemptHistory.length > 0) {
    userContent += `\n\n${formatAttemptHistoryForPrompt(attemptHistory)}`;
  }

  return [
    { role: 'system', content: RTL_DESIGNER_DEBUG_PROMPT },
    { role: 'user', content: userContent },
  ];
}

// ---------------------------------------------------------------------------
// VE: generate UT testbench + test cases
// ---------------------------------------------------------------------------

export function buildVEUnitTBMessages(
  moduleName: string,
  portDefs: PortDef[],
  utVerificationReqs: string,
  interfaceContracts?: InterfaceContract[],
  p2Spec?: { functionalSpec?: string; fsmDescription?: string; timingNotes?: string; boundaryConditions?: string[] },
  globalParameters?: Record<string, number | string>,
): Message[] {
  let userContent = `Generate unit testbench and test cases for module "${moduleName}".

Module ports:
${formatPortDefs(portDefs)}`;

  // Include P2 functional spec so VE can write accurate checkers
  if (p2Spec?.functionalSpec) {
    userContent += `\n\nFunctional specification (use this to write correct checker logic):
${p2Spec.functionalSpec}`;
  }
  if (p2Spec?.fsmDescription) {
    userContent += `\n\nFSM description:
${p2Spec.fsmDescription}`;
  }
  if (p2Spec?.timingNotes) {
    userContent += `\n\nTiming behavior:
${p2Spec.timingNotes}`;
  }
  if (p2Spec?.boundaryConditions?.length) {
    userContent += `\n\nBoundary conditions (MUST be covered by test cases):
${p2Spec.boundaryConditions.map(bc => `- ${bc}`).join('\n')}`;
  }

  userContent += `\n\nVerification requirements:
${utVerificationReqs}`;

  // v3: Include interface contracts for protocol checkers
  if (interfaceContracts?.length) {
    userContent += `\n\nInterface contracts (add protocol checkers for these interfaces):\n${formatInterfaceContracts(interfaceContracts)}`;
  }

  // Global parameters — use these instead of hardcoding values
  if (globalParameters && Object.keys(globalParameters).length > 0) {
    const paramLines = Object.entries(globalParameters).map(([k, v]) => `  ${k} = ${v}`).join('\n');
    userContent += '\n\nGlobal parameters (use parameter names from design_params, do NOT hardcode values):\n' + paramLines;
  }

  return [
    { role: 'system', content: VE_UT_PROMPT },
    { role: 'user', content: userContent },
  ];
}

// ---------------------------------------------------------------------------
// VE: review TB after Designer's tb_suspect
// ---------------------------------------------------------------------------

export function buildVETBReviewMessages(
  moduleName: string,
  designerReason: string,
  tbCode: string,
  verificationReqs: string,
  tcs: Array<{ path: string; content: string }>,
  functionalSpec?: string,
): Message[] {
  const tcSection = tcs.length > 0
    ? `\n\nTest case file(s) — these are included into the TB via \`\`\`include "PLACEHOLDER_TC"\`\`\` at compile time.  They contain the stimulus and scenario; the bug may be in a TC rather than the TB.\n${tcs
        .map(tc => `\`\`\`systemverilog ${tc.path}\n${tc.content}\n\`\`\``)
        .join('\n\n')}`
    : '\n\n(No test case files found for this module.)';

  return [
    { role: 'system', content: VE_TB_REVIEW_PROMPT },
    {
      role: 'user',
      content: `RTL Designer questioned the testbench for module "${moduleName}".

Designer's reason: ${designerReason}

Testbench code (hw/dv/ut/sim/tb/tb_${moduleName}.sv):
\`\`\`systemverilog
${tbCode}
\`\`\`${tcSection}

Verification requirements (from Architect):
${verificationReqs}${functionalSpec ? `\n\nFunctional specification (from Architect P2):\n${functionalSpec}` : ''}`,
    },
  ];
}

// ---------------------------------------------------------------------------
// VE: generate ST testbench
// ---------------------------------------------------------------------------

export function buildVESystemTBMessages(
  stVerificationReqs: string,
  allModulePorts: Array<{ name: string; ports: PortDef[] }>,
  topModuleName: string,
  interfaceContracts?: InterfaceContract[],
  globalParameters?: Record<string, number | string>,
): Message[] {
  const moduleInfo = allModulePorts.map(m =>
    `${m.name}:\n${formatPortDefs(m.ports)}`
  ).join('\n\n');

  let userContent = `Generate system testbench for top module "${topModuleName}".

System test requirements:
${stVerificationReqs}

Module port definitions:
${moduleInfo}`;

  // v3: Include all interface contracts for protocol verification
  if (interfaceContracts?.length) {
    userContent += `\n\nInterface contracts (add protocol checkers for inter-module interfaces):\n${formatInterfaceContracts(interfaceContracts)}`;
  }

  // Global parameters — use these instead of hardcoding values
  if (globalParameters && Object.keys(globalParameters).length > 0) {
    const paramLines = Object.entries(globalParameters).map(([k, v]) => `  ${k} = ${v}`).join('\n');
    userContent += '\n\nGlobal parameters (use parameter names from design_params, do NOT hardcode values):\n' + paramLines;
  }

  return [
    { role: 'system', content: VE_ST_PROMPT },
    { role: 'user', content: userContent },
  ];
}

// ---------------------------------------------------------------------------
// Designer: select VCD signals to examine for waveform debug
// ---------------------------------------------------------------------------

export function buildSignalSelectMessages(
  moduleName: string,
  checkerOutput: string,
  signalList: string[],
  funcDescription: string,
): Message[] {
  return [
    {
      role: 'system',
      content: `You are the RTL Designer debugging a simulation failure using VCD waveforms.
Given the checker errors and the full list of available signals, select the signals most relevant to diagnosing the root cause.

Reply with ONLY a JSON array of signal names (hierarchical, as shown in the list). Select 10-25 signals.
Include: failing signals, their direct drivers/consumers, clock, reset, and any FSM state or control signals that could explain the error.

Example: ["tb.dut.clk", "tb.dut.rst_n", "tb.dut.data_out", "tb.dut.state"]`,
    },
    {
      role: 'user',
      content: `Module: ${moduleName}

Checker errors:
${checkerOutput}

Module functional description:
${funcDescription}

Available signals (${signalList.length} total):
${signalList.join('\n')}`,
    },
  ];
}

// ---------------------------------------------------------------------------
// VE: fix compilation errors in TB/TC (v3)
// ---------------------------------------------------------------------------

export function buildVECompileFixMessages(
  moduleName: string,
  compileErrors: string,
  tbCode: string,
  tcs: Array<{ path: string; content: string }>,
  extraContext?: string,
  attemptHistory?: AttemptRecord[],
): Message[] {
  const tcSection = tcs.length > 0
    ? `\n\nTest case file(s) — included into the TB during compile; errors may be in a TC:\n${tcs
        .map(tc => `\`\`\`systemverilog ${tc.path}\n${tc.content}\n\`\`\``)
        .join('\n\n')}`
    : '';

  let content = `Fix compilation errors in testbench/test case for module "${moduleName}".

Compilation errors:
${compileErrors}

Testbench (hw/dv/ut/sim/tb/tb_${moduleName}.sv):
\`\`\`systemverilog
${tbCode}
\`\`\`${tcSection}`;

  if (extraContext) {
    content += `\n\n${extraContext}`;
  }

  // v4: Negative-example framing of past attempts
  if (attemptHistory && attemptHistory.length > 0) {
    content += `\n\n${formatAttemptHistoryForPrompt(attemptHistory)}`;
  }

  return [
    { role: 'system', content: VE_COMPILE_FIX_PROMPT },
    { role: 'user', content },
  ];
}

// ---------------------------------------------------------------------------
// Spec-Checker Audit: conclusive comparison of spec vs TB checker logic
// ---------------------------------------------------------------------------

export function buildSpecCheckerAuditMessages(
  moduleName: string,
  functionalSpec: string,
  checkerCode: string,
  checkerOutput: string,
  tcs: Array<{ path: string; content: string }>,
): Message[] {
  const tcSection = tcs.length > 0
    ? `\n\nTest case file(s) — provide stimulus that drives the DUT; expected values in the checker are computed against these inputs:\n${tcs
        .map(tc => `\`\`\`systemverilog ${tc.path}\n${tc.content}\n\`\`\``)
        .join('\n\n')}`
    : '';

  return [
    { role: 'system', content: SPEC_CHECKER_AUDIT_PROMPT },
    {
      role: 'user',
      content: `Audit the testbench checker for module "${moduleName}".

Functional specification (from Architect P2):
${functionalSpec}

Testbench checker code:
\`\`\`systemverilog
${checkerCode}
\`\`\`${tcSection}

Checker failure output:
${checkerOutput}`,
    },
  ];
}

// ---------------------------------------------------------------------------
// Self-diagnosis: pre-infra-debug root cause hypothesis (Phase 2a)
// ---------------------------------------------------------------------------

/**
 * Build messages for the gated self-diagnosis call. The diagnostic agent
 * receives the module's spec, the most recent error, and the full attempt
 * history rendered with the same negative-example framing the retry
 * prompts use, so it sees what's been tried and where it failed.
 */
export function buildSelfDiagnosisMessages(
  moduleName: string,
  spec: string,
  recentError: string,
  attemptHistory: AttemptRecord[],
): Message[] {
  const historyBlock = attemptHistory.length > 0
    ? `\n\n${formatAttemptHistoryForPrompt(attemptHistory)}`
    : '\n\n(No structured attempt history available.)';

  return [
    { role: 'system', content: SELF_DIAGNOSE_PROMPT },
    {
      role: 'user',
      content: `Module under diagnosis: ${moduleName}

Module specification:
${spec}

Most recent error encountered:
${recentError.slice(0, 2000)}${historyBlock}

Form a hypothesis about the root cause. Output JSON only.`,
    },
  ];
}

// ---------------------------------------------------------------------------
// ST triage: Designer determines failure source (v3)
// ---------------------------------------------------------------------------

export function buildSTTriageMessages(
  stCheckerOutput: string,
  topModuleCode: string,
  subModulePorts: Array<{ name: string; ports: PortDef[] }>,
): Message[] {
  const moduleInfo = subModulePorts.map(m =>
    `${m.name}:\n${formatPortDefs(m.ports)}`
  ).join('\n\n');

  return [
    { role: 'system', content: ST_TRIAGE_PROMPT },
    {
      role: 'user',
      content: `System test failure — determine the root cause.

Checker output:
${stCheckerOutput}

Top module code:
\`\`\`
${topModuleCode}
\`\`\`

Sub-module port definitions:
${moduleInfo}`,
    },
  ];
}

// ---------------------------------------------------------------------------
// BE: constraint generation + synthesis
// ---------------------------------------------------------------------------

export function buildBEConstraintsMessages(
  designIndex: DesignIndex,
  targetDevice: string,
): Message[] {
  return [
    { role: 'system', content: BE_PROMPT },
    {
      role: 'user',
      content: `Generate constraint files for the design.

Target: ${targetDevice}
Top module: ${designIndex.topModules[0] ?? 'top'}

Design:\n${formatDesignIndexBrief(designIndex)}`,
    },
  ];
}

export function buildBESynthScriptMessages(
  topModule: string,
  targetDevice: string,
  filelistPath = 'hw/src/filelist/design.f',
): Message[] {
  return [
    { role: 'system', content: BE_PROMPT },
    {
      role: 'user',
      content: `Generate a synthesis script.

Top module: ${topModule}
Target: ${targetDevice}
Design filelist: ${filelistPath}
Constraints: hw/syn/constraints.sdc

Write a Yosys script at hw/syn/synth.ys that:
1. Reads all files from the filelist
2. Synthesizes with the top module
3. Runs stat for area report
4. Writes netlist to hw/syn/netlist.v`,
    },
  ];
}

export function buildBETimingAnalysisMessages(
  synthesisReport: string,
  designIndex: DesignIndex,
): Message[] {
  return [
    { role: 'system', content: BE_PROMPT },
    {
      role: 'user',
      content: `Analyze synthesis results and provide a report.

Include: resource utilization, timing (critical paths, WNS/TNS), recommendations.
If timing violations found, suggest specific register insertion locations.

Design:\n${formatDesignIndexBrief(designIndex)}

Synthesis output:
${synthesisReport.slice(0, 8000)}`,
    },
  ];
}
