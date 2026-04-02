/**
 * Agent type definitions for RTL-Claw v3.
 *
 * Key v3 additions over v2:
 *  - Interface contracts (inter-module protocol/timing/data format)
 *  - Top ports and global parameters for auto-generated top module
 *  - ST triage diagnosis
 *  - Enhanced debug history and attempt counters
 */

// ---------------------------------------------------------------------------
// Agent roles (4 roles, no PM)
// ---------------------------------------------------------------------------

export enum AgentRole {
  Architect = 'Architect',
  RTLDesigner = 'RTLDesigner',
  VerificationEngineer = 'VerificationEngineer',
  BackendEngineer = 'BackendEngineer',
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

export type ActionType =
  | 'writeFile'
  | 'runCommand'
  | 'askUser'
  | 'lintCode'
  | 'runSimulation'
  | 'updateIndex'
  | 'synthesize';

export interface Action {
  type: ActionType;
  payload: Record<string, unknown>;
}

export interface AgentResponse {
  content: string;
  actions: Action[];
  artifacts: string[];
}

// ---------------------------------------------------------------------------
// Design Index (unified type shared by hdl-parser and project manager)
// ---------------------------------------------------------------------------

export interface PortDef {
  name: string;
  direction: 'input' | 'output' | 'inout';
  width: number;
  widthExpr: string;
}

export interface ParamDef {
  name: string;
  defaultValue: string;
}

export interface InstanceDef {
  moduleName: string;
  instanceName: string;
  file: string;
  line: number;
}

export interface ModuleEntry {
  name: string;
  file: string;
  language: 'verilog' | 'systemverilog' | 'vhdl';
  ports: PortDef[];
  params: ParamDef[];
  instances: InstanceDef[];
  estimatedLines?: number;
  semanticSummary?: string;
}

export interface HierarchyNode {
  moduleName: string;
  instanceName: string;
  children: HierarchyNode[];
}

export interface DesignIndex {
  modules: ModuleEntry[];
  hierarchy: HierarchyNode[];
  topModules: string[];
  timestamp: string;
}

// ---------------------------------------------------------------------------
// Interface contracts (v3: inter-module protocol definitions)
// ---------------------------------------------------------------------------

export interface InterfaceContractSignal {
  name: string;
  direction: 'input' | 'output';
  width: number;
  widthExpr?: string;
  description?: string;
}

export interface InterfaceContract {
  name: string;
  protocol: string;
  producer: string;
  consumers: string[];
  signals: InterfaceContractSignal[];
  timing: string;
  dataFormat?: string;
  signalMapping?: Record<string, Record<string, string>>;
}

// ---------------------------------------------------------------------------
// Top-level ports (v3: for auto-generated top module)
// ---------------------------------------------------------------------------

export interface TopPort {
  name: string;
  direction: 'input' | 'output' | 'inout';
  width: number;
  widthExpr?: string;
  mappedTo?: string;
}

// ---------------------------------------------------------------------------
// Global parameters (v3: auto-generated design_params.vh)
// ---------------------------------------------------------------------------

export type GlobalParameters = Record<string, number | string>;

// ---------------------------------------------------------------------------
// ST triage diagnosis (v3: route ST failures)
// ---------------------------------------------------------------------------

export interface STTriageDiagnosis {
  fix_location: 'module' | 'connection' | 'unknown';
  module_name?: string;
  diagnosis: string;
}

// ---------------------------------------------------------------------------
// Architect Phase 1 output
// ---------------------------------------------------------------------------

export interface ModuleVerificationReq {
  /** Key functional scenarios to verify */
  scenarios: string[];
  /** Important boundary/edge cases */
  edgeCases: string[];
  /** Expected behavior descriptions */
  expectedBehavior: string[];
}

export interface ArchitectModuleBrief {
  name: string;
  description: string;
  ports: PortDef[];
  params: ParamDef[];
  instances: Array<{ moduleName: string; instanceName: string }>;
  estimatedLines: number;
}

export interface ArchitectPhase1Output {
  modules: ArchitectModuleBrief[];
  topModules: string[];
  dependencyOrder: string[];
  clockDomains?: Array<{ name: string; frequencyMhz: number }>;
  resetStrategy?: string;
  pipelineStages?: Record<string, number>;
  /** System test verification requirements */
  stVerification: {
    scenarios: string[];
    integrationPaths: string[];
  };
  /** v3: Inter-module interface contracts */
  interfaceContracts?: InterfaceContract[];
  /** v3: Top-level port definitions for auto-generated top module */
  topPorts?: TopPort[];
  /** v3: Global design parameters for design_params.vh generation */
  globalParameters?: GlobalParameters;
  /** v3.1: Filelist(s) defined by Architect — names, paths, purposes, initial content */
  filelists?: FilelistSpec[];
}

/** v3.1: Filelist specification from Architect P1 */
export interface FilelistSpec {
  /** Filelist name identifier (e.g., "rtl", "sim") */
  name: string;
  /** Relative path within project (e.g., "hw/src/filelist/rtl.f") */
  path: string;
  /** Purpose of this filelist */
  purpose: 'rtl' | 'simulation' | 'synthesis' | 'other';
  /** Brief description */
  description: string;
  /** Initial content lines (e.g., +incdir+ directives) — module files are appended later */
  initialContent?: string[];
}

// ---------------------------------------------------------------------------
// Architect Phase 2 output (per-module detailed design)
// ---------------------------------------------------------------------------

export interface ArchitectPhase2Output {
  moduleName: string;
  /** Detailed functional specification */
  functionalSpec: string;
  /** FSM descriptions if applicable */
  fsmDescription?: string;
  /** Timing requirements */
  timingNotes?: string;
  /** Boundary conditions and special handling */
  boundaryConditions?: string[];
  /** UT verification requirements */
  utVerification: ModuleVerificationReq;
}

// ---------------------------------------------------------------------------
// Task planning (v2: no PM, no 'small' scope)
// ---------------------------------------------------------------------------

export type PlanScope = 'standard' | 'with_be';

export type StageId =
  | 'architect_p1'
  | 'architect_p2'
  | 'rtl'
  | 'lint'
  | 've_ut'
  | 've_st'
  | 'be'
  | 'summary';

export interface TaskStep {
  id: number;
  stage: StageId;
  description: string;
  status: 'pending' | 'running' | 'done' | 'failed' | 'skipped';
  result?: string;
}

export interface TaskPlan {
  goal: string;
  scope: PlanScope;
  steps: TaskStep[];
  currentStep: number;
}

// ---------------------------------------------------------------------------
// Workflow state (persisted for crash recovery)
// ---------------------------------------------------------------------------

export interface ModuleStatus {
  name: string;
  file: string;
  lintPassed: boolean;
  utPassed: boolean;
  sameErrorRetries: number;
  totalIterations: number;
  /** Count of tb_suspect flags raised by Designer for this module */
  tbSuspectCount: number;
  status: 'pending' | 'designing' | 'writing' | 'linting' | 'testing' | 'done' | 'failed' | 'skipped';
  /** Phase 2 design for this module (populated before RTL writing) */
  phase2Design?: ArchitectPhase2Output;
  /** v3: Lint fix attempt counter (independent, cap at 4+4) */
  lintAttempts: number;
  /** v3: VE compile error fix attempt counter (cap at 4) */
  veCompileAttempts: number;
  /** v3: Debug fix summaries for context minimization */
  debugHistory: string[];
}

export interface WorkflowState {
  plan: TaskPlan;
  /** Phase 1 architecture output */
  phase1Output?: ArchitectPhase1Output;
  moduleStatuses: ModuleStatus[];
  currentModuleIndex: number;
  lastUpdated: string;
  /** v3: Confirmed requirements from requirements gathering */
  confirmedRequirements?: string;
  /** v3: Per-module Phase 2 outputs for crash recovery */
  p2Outputs?: Record<string, ArchitectPhase2Output>;
  /** v3: Per-module debug history (fix summaries) */
  debugHistory?: Record<string, string[]>;
  /** v3: Per-module lint attempt counters */
  lintAttempts?: Record<string, number>;
  /** v3: Per-module VE compile error attempt counters */
  veCompileAttempts?: Record<string, number>;
}

// ---------------------------------------------------------------------------
// Intent classification (v2: no PM stages)
// ---------------------------------------------------------------------------

export type UserIntent =
  | 'new_project'
  | 'additive_change'
  | 'spec_change'
  | 'module_redo'
  | 'question'
  | 'general';

export interface IntentClassification {
  intent: UserIntent;
  scope: PlanScope;
  reasoning: string;
}

// ---------------------------------------------------------------------------
// Debug types
// ---------------------------------------------------------------------------

export interface CheckerError {
  signal: string;
  expected: string;
  actual: string;
  timeNs: number;
  raw: string;
  /** Module name if identifiable from signal path */
  moduleName?: string;
}

export interface DebugDiagnosis {
  /** 'fix' = Designer provides RTL fix, 'tb_suspect' = Designer questions TB */
  diagnosis: 'fix' | 'tb_suspect';
  reason?: string;
  /** Fixed code content (when diagnosis is 'fix') */
  fixedCode?: string;
  /** Target file path for the fix */
  targetFile?: string;
  /** v3: One-line description of the fix applied */
  fix_summary?: string;
}

export interface DebugFixHistory {
  iteration: number;
  error: string;
  diagnosis: DebugDiagnosis['diagnosis'];
  fixed: boolean;
}
