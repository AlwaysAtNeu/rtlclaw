/**
 * Stage execution types for RTL-Claw v2.
 */

import type { LLMBackend } from '../llm/base.js';
import type {
  DesignIndex,
  Action,
  WorkflowState,
  ArchitectPhase1Output,
} from '../agents/types.js';

// ---------------------------------------------------------------------------
// Output chunks (yielded by stages for UI display)
// ---------------------------------------------------------------------------

export type OutputChunkType = 'text' | 'progress' | 'status' | 'error' | 'confirm' | 'code';

export interface OutputChunk {
  type: OutputChunkType;
  content: string;
  metadata?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Stage context (passed to every stage function)
// ---------------------------------------------------------------------------

export interface StageContext {
  llm: LLMBackend;
  projectPath: string;
  designIndex: DesignIndex;
  phase1Output?: ArchitectPhase1Output;
  autoMode: boolean;
  /** Filelist path relative to project root */
  filelistPath: string;

  /** Execute a project action (writeFile, lintCode, runSimulation, etc.) */
  executeAction: (action: Action) => Promise<string>;
  /** Ask the user a question and wait for answer */
  askUser: (question: string) => Promise<string>;
  /** Read a file from the project (relative path) */
  readFile: (relativePath: string) => Promise<string>;
  /** Save workflow state for crash recovery */
  saveState: (state: WorkflowState) => Promise<void>;
  /** Log an LLM trace entry */
  logTrace?: (entry: LLMTraceEntry) => Promise<void>;
  /** Abort signal for cancelling in-flight operations (Esc) */
  signal?: AbortSignal;
}

// ---------------------------------------------------------------------------
// LLM trace entry
// ---------------------------------------------------------------------------

export interface LLMTraceEntry {
  timestamp: string;
  role: string;
  promptTokens: number;
  completionTokens: number;
  durationMs: number;
  taskContext?: string;
  /**
   * Module name — used to group trace files per module for readability.
   * For pre-module-split stages (intent classification, architect P1), pass '_global'
   * explicitly so the choice of "no module context" is visible at the call site
   * rather than being a silent fallback.
   */
  module: string;
  /** Debug iteration number (1-based) for debug fix / simulation entries */
  iteration?: number;
  /** Prompt size in characters (for diagnosing token estimation issues) */
  promptChars?: number;
  /** Response size in characters */
  responseChars?: number;
  /** Whether the response contained extractable code blocks */
  hasCodeBlock?: boolean;
  /** Whether the LLM call required retries (and how many) */
  retryCount?: number;
  /** Brief summary of what happened (for quick scanning) */
  summary?: string;
  /** Event type for non-LLM trace entries (e.g. 'simulation', 'debug_loop') */
  event?: string;
  /** Full prompt messages (for deep debugging — written to separate detail files) */
  promptContent?: Array<{ role: string; content: string }>;
  /** Full LLM response text (for deep debugging) */
  responseContent?: string;
}
