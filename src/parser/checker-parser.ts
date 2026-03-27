/**
 * Checker output parser for RTL-Claw v2.
 *
 * Parses structured error output from testbench checkers/assertions.
 * Expected format: ERROR: signal=xxx, expected=xxx, got=xxx, time=xxxns
 */

import type { CheckerError, DesignIndex } from '../agents/types.js';

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

const CHECKER_PATTERN =
  /ERROR:\s*signal\s*=\s*(\S+),\s*expected\s*=\s*(\S+),\s*got\s*=\s*(\S+),\s*time\s*=\s*(\d+(?:\.\d+)?)\s*ns/gi;

const GENERIC_ERROR_PATTERN =
  /(?:ERROR|FAIL|MISMATCH)[:\s]+(.+)/gi;

/**
 * Parse checker output lines from simulation output.
 */
export function parseCheckerOutput(simOutput: string): CheckerError[] {
  const errors: CheckerError[] = [];
  const seen = new Set<string>();

  // Parse structured checker format
  let match: RegExpExecArray | null;
  CHECKER_PATTERN.lastIndex = 0;
  while ((match = CHECKER_PATTERN.exec(simOutput)) !== null) {
    const key = `${match[1]}_${match[4]}`;
    if (seen.has(key)) continue;
    seen.add(key);

    errors.push({
      signal: match[1]!,
      expected: match[2]!,
      actual: match[3]!,
      timeNs: parseFloat(match[4]!),
      raw: match[0],
    });
  }

  // If no structured errors found, try generic patterns
  if (errors.length === 0) {
    GENERIC_ERROR_PATTERN.lastIndex = 0;
    while ((match = GENERIC_ERROR_PATTERN.exec(simOutput)) !== null) {
      errors.push({
        signal: '',
        expected: '',
        actual: '',
        timeNs: 0,
        raw: match[0],
      });
    }
  }

  return errors;
}

/**
 * Try to identify which module a checker error belongs to based on signal hierarchy.
 * Signal names like "dut.uart_tx.data_out" can be traced to module "uart_tx".
 */
export function identifyFailingModule(
  errors: CheckerError[],
  designIndex: DesignIndex,
): string | null {
  const moduleNames = new Set(designIndex.modules.map(m => m.name));

  for (const err of errors) {
    if (!err.signal) continue;

    // Check for hierarchical signal paths like "dut.module_name.signal"
    const parts = err.signal.split('.');
    for (const part of parts) {
      if (moduleNames.has(part)) {
        err.moduleName = part;
        return part;
      }
    }

    // Check if signal name matches a module's port name
    for (const mod of designIndex.modules) {
      const portMatch = mod.ports.find(p => err.signal.endsWith(p.name));
      if (portMatch) {
        err.moduleName = mod.name;
        return mod.name;
      }
    }
  }

  return null;
}

/**
 * Check if simulation output indicates pass or fail.
 */
export function checkSimResult(
  simOutput: string,
  passPatterns: string[] = ['\\bTEST PASSED\\b', '\\bPASS\\b'],
  failPatterns: string[] = ['\\bTEST FAILED\\b', '\\bFAIL\\b'],
): 'pass' | 'fail' | 'unknown' {
  for (const pat of failPatterns) {
    if (new RegExp(pat, 'i').test(simOutput)) return 'fail';
  }
  for (const pat of passPatterns) {
    if (new RegExp(pat, 'i').test(simOutput)) return 'pass';
  }
  return 'unknown';
}

/**
 * Format checker errors as a concise summary string for LLM consumption.
 */
export function formatCheckerErrors(errors: CheckerError[]): string {
  if (errors.length === 0) return 'No structured checker errors found.';

  const lines = errors.map((e, i) => {
    if (e.signal) {
      return `  ${i + 1}. signal=${e.signal}, expected=${e.expected}, got=${e.actual}, time=${e.timeNs}ns`;
    }
    return `  ${i + 1}. ${e.raw}`;
  });

  return `Checker errors (${errors.length}):\n${lines.join('\n')}`;
}
