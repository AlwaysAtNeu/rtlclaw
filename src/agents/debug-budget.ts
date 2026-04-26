/**
 * DebugBudget — encapsulates the per-debug-loop counters that previously
 * lived as scattered local variables inside `OrchestratorAgent.debugLoop`.
 *
 * Responsibility: track three independent budgets and expose pure decisions
 *
 *   1. Runtime same-error budget — `recordRuntimeError` / `exceededSameError`
 *      Drives "give up" / handleDebugExhausted when the same checker error
 *      repeats sameErrCap times.
 *
 *   2. Compile-error budget — `recordCompileError`
 *      Drives "escalate to infrastructure" when same compile error repeats
 *      compileSameCap times OR total compile rounds exceeds compileTotalCap.
 *
 *   3. VCD fallback trigger — `shouldEnableVCD`
 *      Fires after vcdThreshold consecutive identical runtime errors.
 *
 * Per-module persistent state (mod.totalIterations, mod.lintAttempts,
 * mod.tbSuspectCount, mod.sameErrorRetries) stays on ModuleStatus because
 * those survive across debugLoop re-entries (e.g. after recovery).
 */

const DEFAULTS = {
  sameErrCap: 8,
  iterCap: 32,
  vcdThreshold: 4,
  compileSameCap: 2,
  compileTotalCap: 5,
  tbSuspectCap: 3,
} as const;

export interface DebugBudgetConfig {
  sameErrorMaxRetries?: number;
  totalIterationCap?: number;
  vcdFallbackThreshold?: number;
  compileSameErrorCap?: number;
  compileTotalCap?: number;
  tbSuspectCap?: number;
}

export interface CompileTrackResult {
  sameCount: number;
  totalCount: number;
  shouldEscalate: boolean;
}

export interface RuntimeTrackResult {
  /** True if `normalized` matched the previously seen error verbatim. */
  isSame: boolean;
  /** Updated count of consecutive same-error rounds. */
  consecutiveSimilar: number;
  /** Updated total count for this specific normalized error. */
  totalForThisError: number;
}

export class DebugBudget {
  readonly iterCap: number;
  readonly sameErrCap: number;
  readonly vcdThreshold: number;
  readonly compileSameCap: number;
  readonly compileTotalCap: number;
  readonly tbSuspectCap: number;

  private errorCounts = new Map<string, number>();
  private lastNormalizedError = '';
  private consecutiveSimilar = 0;

  private compileSameErrorCount = 0;
  private compileTotalCount = 0;
  private lastCompileError = '';

  constructor(config: DebugBudgetConfig | undefined, initialNormalizedError: string) {
    this.iterCap = config?.totalIterationCap ?? DEFAULTS.iterCap;
    this.sameErrCap = config?.sameErrorMaxRetries ?? DEFAULTS.sameErrCap;
    this.vcdThreshold = config?.vcdFallbackThreshold ?? DEFAULTS.vcdThreshold;
    this.compileSameCap = config?.compileSameErrorCap ?? DEFAULTS.compileSameCap;
    this.compileTotalCap = config?.compileTotalCap ?? DEFAULTS.compileTotalCap;
    this.tbSuspectCap = config?.tbSuspectCap ?? DEFAULTS.tbSuspectCap;

    this.lastNormalizedError = initialNormalizedError;
    if (initialNormalizedError) {
      this.errorCounts.set(initialNormalizedError, 1);
    }
  }

  // ── Runtime error tracking ───────────────────────────────────────────────

  /**
   * Track a new runtime sim output. Updates errorCounts, consecutive-similar
   * counter, and lastNormalizedError, then returns the new state for callers
   * that need to log it.
   */
  recordRuntimeError(normalized: string): RuntimeTrackResult {
    let isSame: boolean;
    if (normalized !== this.lastNormalizedError) {
      this.lastNormalizedError = normalized;
      this.consecutiveSimilar = 0;
      isSame = false;
    } else {
      this.consecutiveSimilar++;
      isSame = true;
    }
    const total = (this.errorCounts.get(normalized) ?? 0) + 1;
    this.errorCounts.set(normalized, total);
    return { isSame, consecutiveSimilar: this.consecutiveSimilar, totalForThisError: total };
  }

  /** Total count of the most recently recorded normalized error. */
  sameCount(): number {
    return this.errorCounts.get(this.lastNormalizedError) ?? 0;
  }

  /** True when the current error has hit the same-error cap. */
  exceededSameError(): boolean {
    return this.sameCount() >= this.sameErrCap;
  }

  /** True when VCD should be enabled this iteration. */
  shouldEnableVCD(vcdAlreadyEnabled: boolean): boolean {
    return !vcdAlreadyEnabled && this.consecutiveSimilar >= this.vcdThreshold;
  }

  /** Reset only the consecutive-similar counter (used after enabling VCD). */
  resetConsecutiveSimilar(): void {
    this.consecutiveSimilar = 0;
  }

  /** Wipe runtime state when regression switches to a different failing TC. */
  resetForNewTC(): void {
    this.errorCounts.clear();
    this.consecutiveSimilar = 0;
    this.lastNormalizedError = '';
  }

  /** Reseed runtime state from an intermediate sim result (audit loop). */
  reseedFromError(normalized: string): void {
    this.lastNormalizedError = normalized;
    this.errorCounts.set(normalized, 1);
  }

  // ── Compile error tracking ───────────────────────────────────────────────

  /**
   * Track a compile-error round. Returns updated counts and an escalation
   * flag. Caller should escalate to Infrastructure Debug Agent if
   * `shouldEscalate` is true.
   */
  recordCompileError(normalized: string): CompileTrackResult {
    this.compileTotalCount++;
    if (normalized === this.lastCompileError) {
      this.compileSameErrorCount++;
    } else {
      this.compileSameErrorCount = 1;
      this.lastCompileError = normalized;
    }
    return {
      sameCount: this.compileSameErrorCount,
      totalCount: this.compileTotalCount,
      shouldEscalate:
        this.compileSameErrorCount > this.compileSameCap ||
        this.compileTotalCount > this.compileTotalCap,
    };
  }

  /** Reset compile state when infrastructure debug resolves the error. */
  resetCompile(): void {
    this.compileSameErrorCount = 0;
    this.compileTotalCount = 0;
    this.lastCompileError = '';
  }

  // ── Inspection ───────────────────────────────────────────────────────────

  getConsecutiveSimilar(): number { return this.consecutiveSimilar; }
  getLastNormalizedError(): string { return this.lastNormalizedError; }
  getCompileSameCount(): number { return this.compileSameErrorCount; }
  getCompileTotalCount(): number { return this.compileTotalCount; }
}
