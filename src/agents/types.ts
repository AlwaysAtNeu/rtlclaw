/**
 * Agent type definitions for RTL-Claw v3.
 *
 * Key v3 additions over v2:
 *  - Interface contracts (inter-module protocol/timing/data format)
 *  - Top ports and global parameters for auto-generated top module
 *  - ST triage diagnosis
 *  - Enhanced debug history and attempt counters
 *
 * v4 (feedback signal): debugHistory: string[] is replaced by
 * attemptHistory: AttemptRecord[] — structured attempt records carrying
 * tool-tagged error signatures, code diffs, and authorship for use as
 * negative-example context in retry prompts and oscillation detection.
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

/**
 * Project actions executed by the runtime.
 *
 * Contract notes:
 * - writeFile with `append: true` (or `appendLine`) is idempotent — the runtime
 *   does line-based dedup before appending. Callers may call repeatedly with
 *   the same line and trust the filelist will not accumulate duplicates.
 */
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
  /**
   * v3.2: Cross-cutting design rationale — short prose capturing WHY for
   * handshake / clocking / reset choices. Distinct from `clockDomains`
   * (structural list) and `resetStrategy` (single line): these survive into
   * P2 generation and the Designer's RTL write/debug context so downstream
   * roles share the Architect's intent on edge cases.
   */
  designRationale?: DesignRationale;
}

/** v3.2: Architect rationale for cross-cutting design choices. */
export interface DesignRationale {
  /** WHY this handshake/dataflow protocol — e.g., "valid/ready everywhere because…" */
  handshake?: string;
  /** WHY this clocking scheme — e.g., "single 100MHz domain because no async sources…" */
  clockDomains?: string;
  /** WHY this reset scheme — e.g., "async assert / sync deassert because…" */
  resetStrategy?: string;
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

/**
 * Per-module workflow state.
 *
 * IMPORTANT (Phase 2b): when adding a new field here, decide whether it
 * should be reset on a P2 redo and update `resetModuleForRedo()` in
 * orchestrator.ts accordingly. Counters and per-attempt tracking should
 * generally reset (the new spec invalidates them); cross-revision
 * accumulators like `pastRevisions` (in WorkflowState, not here) should not.
 *
 * Special case: `tbSuspectCount` resets on redo because the new P2 spec
 * may change ports / FSM, forcing TB to be rewritten — old tb_suspect
 * judgments no longer apply, and not resetting would unfairly penalize
 * the new TB right out of the gate.
 */
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
  /**
   * v4: Structured per-attempt records across all retry-bearing stages
   * (rtl_write / lint_fix / compile_fix / debug_fix / tb_audit_fix /
   *  infra_debug). Carries error signature, diff, author, summary so that
   *  (a) downstream prompts can present it as negative examples, and
   *  (b) the orchestrator can detect repeating / alternating patterns
   *      via fingerprint match instead of fuzzy substring match.
   */
  attemptHistory: AttemptRecord[];
  /**
   * v4 (Phase 2a): once-per-module flag for the self-diagnose LLM call.
   * The diagnosis is gated to fire at most once per module's lifetime,
   * just before the first functional infrastructure-debug escalation,
   * so it doesn't blindly inherit the surface error.
   *
   * Distinct from `lastDiagnosis` below: `selfDiagnoseRun=true` AND
   * `lastDiagnosis=undefined` means "we tried but the LLM output didn't
   * parse" — gate stays closed (don't retry), but no hypothesis available.
   */
  selfDiagnoseRun?: boolean;
  /**
   * v4 (Phase 2a/2b): cached structured result of the most recent
   * selfDiagnose call. Populated only when the diagnosis LLM returned a
   * parseable JSON answer; left undefined on parse failure. Phase 2b's
   * P2-redo path reads `lastDiagnosis.rootCauseHypothesis` as the source
   * for `PastRevisionEntry.diagnosisSnapshot`.
   */
  lastDiagnosis?: SelfDiagnosis;
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
  /** v3: Per-module lint attempt counters */
  lintAttempts?: Record<string, number>;
  /** v3: Per-module VE compile error attempt counters */
  veCompileAttempts?: Record<string, number>;
  /** v4: Schema version. State without this field is treated as legacy and discarded on load. */
  schemaVersion?: number;
  /**
   * v4 Phase 2b: per-project revision budget. Tracks remaining P1/P2
   * revisions to prevent unbounded upstream re-planning loops. Initialized
   * by the orchestrator to {p1: 2, p2: {}} when a workflow starts; per-module
   * P2 entries are lazily initialized to DEFAULT_REVISION_BUDGET.p2PerModule
   * on first access.
   */
  revisionBudget?: RevisionBudget;
  /**
   * v4 Phase 2b: history of upstream revisions that have been applied for
   * each module. Used by the upstream prompt builder to remind the agent
   * what it has already proposed and what failed under each prior version,
   * preventing it from looping back to a known-bad spec.
   */
  pastRevisions?: Record<string, PastRevisionEntry[]>;
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

// ---------------------------------------------------------------------------
// v4: Attempt records (structured retry feedback)
// ---------------------------------------------------------------------------

/**
 * Schema version for WorkflowState. Bumped when types.ts shape changes in a
 * way old state.json files cannot be loaded — the loader checks this and
 * discards state with a missing/lower version.
 */
export const WORKFLOW_STATE_SCHEMA_VERSION = 4;

/**
 * Stages that produce retry attempts. Used to label AttemptRecord so the
 * orchestrator and prompts can reason about routing history (e.g. "all 3
 * recent attempts were rtl_lint_fix" → escalate to infra).
 */
export type AttemptStage =
  | 'rtl_write'
  | 'rtl_lint_fix'
  | 'rtl_compile_fix'
  | 'rtl_debug_fix'
  | 've_tb_write'
  | 've_tb_compile_fix'
  | 've_tb_audit_fix'
  | 'infra_debug';

/**
 * Who produced the change. user='unknown' for state migrated from
 * pre-v4 string history. user='user' is reserved for Phase 2 (manual edit
 * detection); Phase 1 only emits 'llm', 'infra', or 'unknown'.
 */
export type AttemptAuthor = 'llm' | 'user' | 'infra' | 'unknown';

/**
 * Tool-tagged error signature, used both for human-readable display
 * ("WIDTH @ counter.sv:24") and as a stable fingerprint for repeat /
 * oscillation detection.
 */
export interface ErrorSignature {
  /** Originating tool: 'verilator' | 'iverilog' | 'checker' | 'unknown' */
  tool: string;
  /** Tag pulled from the tool's structured output (verilator %Error-WIDTH → 'WIDTH'). 'unknown' if no recognizable tag. */
  tag: string;
  /** First file:line cited (basename only, no absolute paths). May be omitted if not parseable. */
  location?: string;
  /** Stable short hash combining tool+tag+location+normalized-message. Used for fingerprint equality. */
  fingerprint: string;
}

/**
 * One retry attempt across a stage. Stored on ModuleStatus.attemptHistory
 * and consumed by:
 *   (a) prompt builders — formatted as negative examples for the next attempt
 *   (b) oscillation detector — fingerprint sequence determines escalation
 *   (c) trace logs — toLogString-formatted into per-module summaries
 *
 * Semantic of errorRaw: the error this attempt was triggered to fix
 * (i.e. the *pre-attempt* state, what the LLM saw). The "result of this
 * attempt" is implicitly the next record's errorRaw, or success if no
 * later record exists.
 */
export interface AttemptRecord {
  /** Monotonic attempt index within this module (1-based). */
  n: number;
  /** Which stage produced this attempt. */
  stage: AttemptStage;
  /** Who wrote the change. */
  author: AttemptAuthor;
  /** ISO-8601 timestamp. */
  ts: string;
  /** Pre-attempt error this attempt was responding to. Empty for the very first attempt (rtl_write of a fresh module). */
  errorRaw?: string;
  /** Structured signature of errorRaw. Drives fingerprint match. */
  errorSig?: ErrorSignature;
  /** Short summary of what this attempt did (e.g. "added explicit casting for sig_a"). LLM-provided when available, otherwise rule-derived. */
  summary?: string;
  /** Unified diff (capped) of the file change introduced by this attempt. May be empty for non-file-modifying stages. */
  diff?: string;
  /** Path to the primary file changed (relative to project root). */
  file?: string;
}

/**
 * Stage functions produce records without `n`/`ts` (those are assigned by
 * orchestrator's recordAttempt helper, which has access to the module's
 * full history). This keeps stages decoupled from the monotonic counter.
 */
export type PartialAttemptRecord = Omit<AttemptRecord, 'n' | 'ts'>;

/** Standard return shape for stage functions that perform one fix attempt. */
export interface StageAttemptResult {
  /** Whether the attempt produced usable output (e.g., LLM returned code). */
  ok: boolean;
  /** The attempt's structured record, ready for orchestrator to enroll. */
  record: PartialAttemptRecord;
}

// ---------------------------------------------------------------------------
// v4 Phase 2a: Self-diagnosis (gated, pre-infra-debug)
// ---------------------------------------------------------------------------

/**
 * Output of selfDiagnose. Deliberately *no* routing field — the orchestrator
 * decides routes based on its own state and budget. Diagnosis only carries
 * semantic content for downstream agents to consume.
 */
export interface SelfDiagnosis {
  /**
   * What the diagnostic LLM thinks is *actually* broken. Forces a step back
   * from the surface error toward a hypothesis about root cause.
   */
  rootCauseHypothesis: string;
  /**
   * Optional supplementary context (e.g., "spec mentions feature X but RTL
   * does not implement it", "all attempts target sig_a, but error originates
   * from sig_b in the upstream module").
   */
  additionalContext?: string;
  /** LLM's confidence in its own hypothesis. */
  confidence: 'low' | 'medium' | 'high';
}

// ---------------------------------------------------------------------------
// v4 Phase 2b: Cross-stage failure feedback + revision budget
// ---------------------------------------------------------------------------

/**
 * Pattern that triggered the report — used for telemetry/UX and the
 * upstream prompt's framing. Distinct from `AttemptStage` because this is
 * about *why* we're escalating, not *which stage* did the work.
 *
 * Phase 2b first cut: only 'repeating', 'alternating', and 'infra_unresolved'
 * are populated. A separate 'persistent_cap' value was considered for "ran
 * out of attempts without a fingerprint pattern" but was dropped because it
 * is functionally equivalent to 'infra_unresolved' on the route into
 * tryP2Redo (we only get there if infra-debug failed). Re-add only if
 * telemetry shows the distinction is decision-relevant.
 */
export type FailurePatternKind =
  | 'repeating'           // same fingerprint ≥3 times in recent history
  | 'alternating'         // A/B/A/B fingerprint pattern
  | 'infra_unresolved';   // infra-debug ran but reported UNRESOLVED

/**
 * One past upstream-revision episode. Critical: feedback alone is
 * insufficient — without `attemptHistorySnapshot` showing what was tried
 * under the prior revised spec, the upstream agent may propose a
 * superficially different revision that turns out equivalent.
 *
 * Schema is split into two audiences:
 *   - `outcome` is what the upstream architect sees (decision-relevant)
 *   - `stopReason` is internal telemetry (budget tuning, never shown to LLM)
 */
export interface PastRevisionEntry {
  /**
   * Which upstream agent was revised. Phase 2b first cut populates only
   * 'p2'; the 'p1' value is reserved for Phase 3 (project-level architecture
   * revision) and intentionally kept in the union so future entries don't
   * require a schema migration. No 'p1' entries should appear until Phase 3.
   */
  target: 'p1' | 'p2';
  /**
   * Snapshot of the attemptHistory at the time the revision was proposed
   * (already formatted via formatAttemptHistoryForPrompt with the
   * 'spec_revision' framing). Used to show the upstream agent: "under that
   * prior revision, here's what we tried and how it failed."
   */
  attemptHistorySnapshot: string;
  /**
   * Snapshot of the SelfDiagnosis hypothesis at the time of this revision,
   * if Phase 2a had run. Crucial for cross-revision pattern detection: if
   * the same hypothesis recurs across multiple revisions, the issue is
   * likely structural (kick to P1) rather than spec-level (kick to P2).
   * Stored verbatim — do not summarize.
   */
  diagnosisSnapshot?: string;
  /**
   * Architect-facing outcome of the revision. Three terminal values plus
   * undefined for "redo still in progress":
   *   - 'resolved'                      — module passed UT after this redo
   *   - 'progressed_but_not_resolved'   — error class shifted but still failing
   *   - 'no_progress'                   — fully equivalent to no revision
   *                                       (covers exhausted attempts, cap
   *                                       reached, and revisionNotHelpful)
   *   - undefined                       — entry created at revision-request
   *                                       time, redo not yet finished. The
   *                                       outer loop fills outcome at redo
   *                                       completion via pastRevisions.at(-1).
   * errors_exhausted vs cap_reached differ for budget telemetry but are
   * equivalent for the architect's decision; both map to 'no_progress'.
   */
  outcome?: 'resolved' | 'progressed_but_not_resolved' | 'no_progress';
  /**
   * Internal telemetry: what stopped attempts under this revision. Used
   * to analyze whether budget defaults are right; never shown to LLM.
   *
   * Phase 2b first cut: only 'revision_not_helpful' is populated (by the
   * revisionNotHelpful path). Differentiating exhausted-attempts vs
   * cap-reached vs infra-unresolved is deferred until telemetry shows that
   * distinction has practical value — adding unused enum values now would
   * be a schema-debt commitment with no implementation behind it.
   */
  stopReason?: 'revision_not_helpful';
  /**
   * Architect's human-readable explanation when revisionNotHelpful=true.
   * Critical for Phase 3 P1 redo: "P2 said this module needs structural
   * changes because <declaredReason>". Without this, P1 would have to
   * reverse-engineer the rationale from attemptHistorySnapshot alone.
   */
  declaredReason?: string;
  /** ISO-8601. */
  appliedAt: string;
}

/**
 * Structured handoff from a failing stage to an upstream agent for
 * re-planning. The orchestrator assembles this; consumers are upstream
 * prompt builders (P1 revision, P2 revision).
 */
export interface FailureReport {
  /** Stage that ran out of options. */
  reportingStage:
    | 'rtl_writer'
    | 'lint'
    | 'ut_debug'
    | 'st'
    | 'infra_debug';
  /** Module name (project-wide for ST connection failures). */
  module: string;
  /** What pattern triggered the escalation. */
  patternKind: FailurePatternKind;
  /**
   * Pre-rendered attempt history (via formatAttemptHistoryForPrompt) — the
   * canonical "what we tried and what failed" block for the upstream prompt.
   */
  attemptHistorySnapshot: string;
  /**
   * Optional self-diagnosis hypothesis (Phase 2a output). Consumers should
   * tolerate this being undefined — when 2a hasn't run for this module,
   * the report still contains structural info from attemptHistorySnapshot.
   */
  rootCauseHypothesis?: string;
  /** Past revisions that have already been tried for this scope. */
  pastRevisions: PastRevisionEntry[];
  /** Where the orchestrator routed this report. */
  suggestedTarget: 'p1' | 'p2' | 'manual';
  /** ISO-8601 timestamp the report was assembled. */
  ts: string;
}

/**
 * Per-project upstream-revision budget. Hard caps enforce convergence:
 * without these, a P2 revision can keep being requested for the same
 * module, looping indefinitely if each new spec just shifts the surface
 * error rather than fixing root cause.
 *
 * Defaults are deliberately conservative; telemetry on `budget_exhausted`
 * trace events should drive future tuning. p1 is *project-level total*,
 * not per-trigger — multiple modules sharing the budget is intentional.
 */
export interface RevisionBudget {
  /** Project-level cap on P1 architecture revisions across all modules. */
  p1: number;
  /** Per-module cap on P2 detail-design revisions. */
  p2: Record<string, number>;
}

/** Default budget assigned to fresh workflow state. */
export const DEFAULT_REVISION_BUDGET: { p1: number; p2PerModule: number } = {
  p1: 2,
  p2PerModule: 1,
};
