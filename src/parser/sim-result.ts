/**
 * Structured result of a runSimulation action.
 *
 * Replaces scattered `output.includes('TEST PASSED')` / `extractFailingTC` /
 * `isCompileError` / `classifyCompileError` calls in the orchestrator with a
 * single pure parser. All sim-output heuristics live here.
 *
 * The optional ParseOptions argument lets callers pass user-configured
 * pass/fail/compile patterns (DebugConfig.passPatterns / failPatterns) in
 * the future. By default the parser uses the historical hardcoded patterns
 * so behavior is preserved without any call-site changes.
 */

export type SimVerdict = 'pass' | 'fail' | 'compile_error';

export interface CompileErrorInfo {
  /** Which side the compile error references — drives debug routing. */
  source: 'rtl' | 'tb' | 'unknown';
  /** Raw error message for LLM context. */
  message: string;
}

export interface SimResult {
  verdict: SimVerdict;
  /** Failing TC filename, set when verdict='fail' and the runner emitted FAILING_TC. */
  failingTC?: string;
  /** Compile-error details, set when verdict='compile_error'. */
  compileError?: CompileErrorInfo;
  /** Original sim output, preserved for LLM debug context. */
  rawOutput: string;
}

export interface ParseOptions {
  /** Regex source strings; matched case-insensitively. Treated as additive — defaults always apply. */
  passPatterns?: string[];
  /** Reserved for future use; current parser only needs pass + compile detection. */
  failPatterns?: string[];
  /** Substrings (lowercased) that indicate a compile failure. */
  compilePatterns?: string[];
}

const DEFAULT_COMPILE_PATTERNS: readonly string[] = [
  'syntax error',
  'compilation error',
  'undeclared',
  'undefined module',
  'cannot find',
  'include file',
  'not found',
  'no such file',
  'could not open',
  'i give up',
  'no top level modules',
  'unable to bind',
  'unknown module type',
  'error(s) during elaboration',
];

const RUNTIME_INDICATORS: readonly string[] = [
  'test passed',
  'test failed',
  '$finish',
  'vcd info',
];

const ERROR_LINE_RE = /error|warning|syntax|undeclared|not found|unable/i;
const FILE_REF_RE = /([\w/._-]+\.s?v)\s*:\s*\d+/g;

function classifyCompileSource(rawOutput: string): 'rtl' | 'tb' | 'unknown' {
  const rtlFiles = new Set<string>();
  const tbFiles = new Set<string>();

  for (const line of rawOutput.split('\n')) {
    if (!ERROR_LINE_RE.test(line)) continue;
    let match: RegExpExecArray | null;
    FILE_REF_RE.lastIndex = 0;
    while ((match = FILE_REF_RE.exec(line)) !== null) {
      const filePath = match[1];
      if (/hw\/src\//.test(filePath)) {
        rtlFiles.add(filePath);
      } else if (/hw\/dv\//.test(filePath) || /\btb_/.test(filePath) || /\btc_/.test(filePath)) {
        tbFiles.add(filePath);
      }
    }
  }

  if (rtlFiles.size > 0 && tbFiles.size === 0) return 'rtl';
  if (tbFiles.size > 0 && rtlFiles.size === 0) return 'tb';
  return 'unknown';
}

function hasPassMatch(rawOutput: string, extra?: string[]): boolean {
  if (/\bTEST PASSED\b/.test(rawOutput) || /\bPASSED\b/.test(rawOutput)) return true;
  if (!extra || extra.length === 0) return false;
  for (const pat of extra) {
    try {
      if (new RegExp(pat, 'i').test(rawOutput)) return true;
    } catch {
      // Ignore bad regex strings — defaults still apply.
    }
  }
  return false;
}

export function parseSimResult(rawOutput: string, opts?: ParseOptions): SimResult {
  const lower = rawOutput.toLowerCase();
  const compilePatterns = opts?.compilePatterns ?? DEFAULT_COMPILE_PATTERNS;
  const hasCompileIndicators = compilePatterns.some(p => lower.includes(p));
  const hasRuntimeOutput =
    RUNTIME_INDICATORS.some(p => lower.includes(p)) ||
    /\btime\s*=?\s*\d/.test(lower);

  if (hasCompileIndicators && !hasRuntimeOutput) {
    return {
      verdict: 'compile_error',
      compileError: { source: classifyCompileSource(rawOutput), message: rawOutput },
      rawOutput,
    };
  }

  const failingMatch = rawOutput.match(/FAILING_TC:\s*(\S+)/);
  if (failingMatch) {
    return { verdict: 'fail', failingTC: failingMatch[1], rawOutput };
  }

  if (hasPassMatch(rawOutput, opts?.passPatterns)) {
    return { verdict: 'pass', rawOutput };
  }

  return { verdict: 'fail', rawOutput };
}
