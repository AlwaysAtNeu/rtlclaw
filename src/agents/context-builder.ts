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
  InterfaceContract,
} from './types.js';
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

  return [
    { role: 'system', content: ARCHITECT_P2_PROMPT },
    {
      role: 'user',
      content: `Global architecture:\n${globalSummary}\n\nTop modules: ${phase1Output.topModules.join(', ')}\nDependency order: ${phase1Output.dependencyOrder.join(' -> ')}\n\nProvide detailed design for:\n${modDetail}${contractsSection}`,
    },
  ];
}

// ---------------------------------------------------------------------------
// RTL Designer: write module
// ---------------------------------------------------------------------------

export function buildRTLWriteMessages(
  phase2Design: ArchitectPhase2Output,
  dependentModulePorts: Array<{ name: string; ports: PortDef[] }>,
  hdlStandard?: string,
  interfaceContracts?: InterfaceContract[],
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
): Message[] {
  let prompt = RTL_DESIGNER_PROMPT;
  if (hdlStandard) {
    prompt += `\n\n${getHdlSyntaxRules(hdlStandard)}`;
  }

  return [
    { role: 'system', content: prompt },
    {
      role: 'user',
      content: `Fix lint errors in module "${moduleName}".

Lint output:
${lintOutput}

Current RTL code:
\`\`\`
${rtlCode}
\`\`\`

Provide the complete corrected file.`,
    },
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
  debugHistory?: string[],
  vcdData?: string,
): Message[] {
  let userContent = `Module "${moduleName}" failed unit test.

Checker errors:
${checkerOutput}`;

  // v3: Include VCD waveform data when available (fallback debug)
  if (vcdData) {
    userContent += `\n\nVCD waveform data around error time:\n\`\`\`\n${vcdData}\n\`\`\`\nUse the waveform to trace signal transitions and identify the root cause.`;
  }

  userContent += `\n\nModule functional description:\n${funcDescription}`;

  // v3: Include debug history so Designer doesn't repeat fixes
  if (debugHistory?.length) {
    userContent += `\n\nPrevious fix attempts:\n${debugHistory.map((h, i) => `  ${i + 1}. ${h}`).join('\n')}`;
  }

  userContent += `\n\nCurrent RTL code:\n\`\`\`\n${rtlCode}\n\`\`\``;

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
  debugHistory?: string[],
  vcdData?: string,
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

  // v3: Include debug history so Designer doesn't repeat fixes
  if (debugHistory?.length) {
    userContent += `\n\nPrevious fix attempts:\n${debugHistory.map((h, i) => `  ${i + 1}. ${h}`).join('\n')}`;
  }

  userContent += `\n\nCurrent RTL code:\n\`\`\`\n${rtlCode}\n\`\`\`

If the checker expectations don't match the verification requirements, you may flag tb_suspect.`;

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
): Message[] {
  return [
    { role: 'system', content: VE_TB_REVIEW_PROMPT },
    {
      role: 'user',
      content: `RTL Designer questioned the testbench for module "${moduleName}".

Designer's reason: ${designerReason}

Testbench code:
\`\`\`
${tbCode}
\`\`\`

Verification requirements (from Architect):
${verificationReqs}`,
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
  extraContext?: string,
): Message[] {
  let content = `Fix compilation errors in testbench for module "${moduleName}".

Compilation errors:
${compileErrors}

Testbench/test case code:
\`\`\`
${tbCode}
\`\`\``;

  if (extraContext) {
    content += `\n\n${extraContext}`;
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
): Message[] {
  return [
    { role: 'system', content: SPEC_CHECKER_AUDIT_PROMPT },
    {
      role: 'user',
      content: `Audit the testbench checker for module "${moduleName}".

Functional specification (from Architect P2):
${functionalSpec}

Testbench checker code:
\`\`\`
${checkerCode}
\`\`\`

Checker failure output:
${checkerOutput}`,
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
