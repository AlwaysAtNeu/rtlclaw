/**
 * Error signature extraction.
 *
 * Pulls structured tags from EDA tool output (verilator's %Error-WIDTH,
 * iverilog's "Unable to bind ...", checker mismatches, etc.) so the
 * orchestrator can do exact-fingerprint match for repeat / oscillation
 * detection — instead of fuzzy substring match on free-form error text.
 *
 * The fingerprint combines tool + tag + normalized location + a
 * normalized message slice, hashed to a short stable string.
 */

import { createHash } from 'node:crypto';
import path from 'node:path';
import type { ErrorSignature } from '../agents/types.js';

/**
 * Verilator emits errors as:
 *   %Error-WIDTH: file.sv:24:5: ... message ...
 *   %Error: file.sv:5:10: syntax error, ...      (no tag)
 *   %Warning-UNUSED: ...                          (treat warnings same way for fingerprint)
 */
const VERILATOR_RE = /%(?:Error|Warning)(?:-([A-Z][A-Z0-9_]*))?\s*:\s*([^\s:]+\.[a-zA-Z]+):(\d+)(?::\d+)?:\s*([^\n]*)/;

/**
 * Iverilog emits errors as:
 *   file.sv:5: syntax error
 *   file.sv:5: error: I/O port ...
 *   file.sv: error: Unable to bind wire/reg/memory `x' in `y'
 */
const IVERILOG_RE = /(\S+\.s?vh?)\s*:\s*(\d+)?\s*:\s*(?:error|warning)?\s*:?\s*([^\n]*)/i;

/**
 * Checker output from UT testbenches typically looks like:
 *   ERROR @ time 100: signal_x = 8'h00, expected 8'hFF
 *   FAIL: scenario "reset_release" — out_y stuck low at time 50
 */
const CHECKER_RE = /(?:^|\n)\s*(ERROR|FAIL|MISMATCH)\b[^\n]*/i;

/**
 * Iverilog message → tag classification. Order matters: more specific first.
 */
function classifyIverilogMessage(message: string): string {
  const m = message.toLowerCase();
  if (m.includes('unable to bind')) return 'UNRESOLVED';
  if (m.includes('unknown module type')) return 'UNRESOLVED';
  if (m.includes('already defined') || m.includes('was already defined')) return 'MODDUP';
  if (m.includes('duplicate')) return 'MODDUP';
  if (m.includes('include file') && m.includes('not found')) return 'INCLUDE';
  if (m.includes('cannot find') || m.includes('no such file') || m.includes('cannot open')) return 'FILE';
  if (m.includes('syntax error')) return 'SYNTAX';
  if (m.includes('port') && (m.includes('incompatible') || m.includes('different'))) return 'PORTDIFF';
  if (m.includes('width')) return 'WIDTH';
  if (m.includes('undeclared')) return 'UNDECLARED';
  if (m.includes('no top level modules')) return 'NOTOP';
  if (m.includes('elaboration')) return 'ELAB';
  if (m.includes('i give up')) return 'FATAL';
  return 'GENERIC';
}

/**
 * Lightweight non-crypto normalization used both for fingerprint hashing
 * and for substring fallback equality. Mirrors what orchestrator did
 * historically as `normalizeError()` but lives here so the same shape can
 * be reused across tools.
 */
function normalizeForFingerprint(text: string): string {
  return text
    .replace(/\b\d+\s*'\s*[bhdoBHDO]\s*[0-9a-fA-F_xzXZ?]+/g, "N'X")
    .replace(/\b0x[0-9a-fA-F]+\b/gi, '0xN')
    .replace(/\btime\s+\d+/gi, 'time N')
    .replace(/#\s*\d+/g, '#N')
    .replace(/\b\d+\b/g, 'N')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200);
}

function shortHash(s: string): string {
  return createHash('sha1').update(s).digest('hex').slice(0, 12);
}

function buildFingerprint(tool: string, tag: string, location: string | undefined, normalizedMsg: string): string {
  return shortHash(`${tool}|${tag}|${location ?? ''}|${normalizedMsg}`);
}

/**
 * Extract the most informative error signature from a raw EDA tool output
 * blob. If multiple errors are present, prefers the first verilator
 * %Error-TAG hit, then first iverilog file:line, then checker patterns.
 */
export function extractErrorSignature(raw: string): ErrorSignature {
  if (!raw || !raw.trim()) {
    return { tool: 'unknown', tag: 'EMPTY', fingerprint: shortHash('empty') };
  }

  const verilator = VERILATOR_RE.exec(raw);
  if (verilator) {
    const tag = verilator[1] ?? 'GENERIC';
    const loc = `${path.basename(verilator[2]!)}:${verilator[3]}`;
    const normMsg = normalizeForFingerprint(verilator[4] ?? '');
    return {
      tool: 'verilator',
      tag,
      location: loc,
      fingerprint: buildFingerprint('verilator', tag, loc, normMsg),
    };
  }

  const iverilog = IVERILOG_RE.exec(raw);
  if (iverilog) {
    const tag = classifyIverilogMessage(iverilog[3] ?? '');
    const loc = iverilog[2] ? `${path.basename(iverilog[1]!)}:${iverilog[2]}` : path.basename(iverilog[1]!);
    const normMsg = normalizeForFingerprint(iverilog[3] ?? '');
    return {
      tool: 'iverilog',
      tag,
      location: loc,
      fingerprint: buildFingerprint('iverilog', tag, loc, normMsg),
    };
  }

  const checker = CHECKER_RE.exec(raw);
  if (checker) {
    const normMsg = normalizeForFingerprint(checker[0]);
    return {
      tool: 'checker',
      tag: 'MISMATCH',
      fingerprint: buildFingerprint('checker', 'MISMATCH', undefined, normMsg),
    };
  }

  const normMsg = normalizeForFingerprint(raw);
  return {
    tool: 'unknown',
    tag: 'GENERIC',
    fingerprint: buildFingerprint('unknown', 'GENERIC', undefined, normMsg),
  };
}

/** Compact one-line signature display: "verilator/WIDTH @ counter.sv:24" */
export function formatSignature(sig: ErrorSignature | undefined): string {
  if (!sig) return '(no signature)';
  const loc = sig.location ? ` @ ${sig.location}` : '';
  return `${sig.tool}/${sig.tag}${loc}`;
}
