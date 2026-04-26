/**
 * AttemptRecord helpers — construction, prompt formatting, log display.
 *
 * Two consumers drive the formatting choices here:
 *
 *  (1) Prompt builders (formatAttemptHistoryForPrompt) — frame past
 *      attempts as *negative examples* with strong "DO NOT repeat" wording
 *      and "you JUST tried" pronouns for recent attempts. LLMs treat
 *      passive context dumps as reference material; explicit framing
 *      shifts behavior more reliably than adding more context.
 *
 *  (2) Logs / UI (attemptToLogString) — short single-line representation
 *      for trace summaries and TUI display. Avoids dumping diffs.
 */

import type { AttemptRecord, AttemptStage } from '../agents/types.js';
import { formatSignature } from './error-signature.js';

// ---------------------------------------------------------------------------
// Construction
// ---------------------------------------------------------------------------

/**
 * Build a new AttemptRecord with monotonic `n` and a fresh `ts`.
 * Caller supplies the structural fields. Use this rather than constructing
 * AttemptRecord literals so monotonicity is enforced in one place.
 */
export function newAttemptRecord(
  history: AttemptRecord[],
  partial: Omit<AttemptRecord, 'n' | 'ts'>,
): AttemptRecord {
  return {
    n: history.length + 1,
    ts: new Date().toISOString(),
    ...partial,
  };
}

// ---------------------------------------------------------------------------
// Display
// ---------------------------------------------------------------------------

/** Short one-line representation for trace/UI display. */
export function attemptToLogString(rec: AttemptRecord): string {
  const sig = rec.errorSig ? formatSignature(rec.errorSig) : '(no error)';
  const summary = rec.summary ? ` — ${truncate(rec.summary, 80)}` : '';
  return `#${rec.n} [${rec.stage}/${rec.author}] ${sig}${summary}`;
}

// ---------------------------------------------------------------------------
// Prompt formatting (negative-example framing)
// ---------------------------------------------------------------------------

export interface PromptFormatOptions {
  /** Number of most-recent attempts to render with full diff/error blocks. */
  recentFull?: number;
  /** Maximum older attempts to summarize as bullets after the recent full block. */
  maxOlder?: number;
  /** Per-attempt diff line cap when rendering recent full blocks. */
  diffLineCap?: number;
  /**
   * Audience-aware framing.
   *  - 'avoid_repeat' (default): for code-fixing agents. Tells them
   *    these specific moves failed — don't repeat them. Uses second-person
   *    ("You JUST tried") because the agent is the one making the moves.
   *  - 'spec_revision': for the architect on a P2 redo. Tells the architect
   *    these failures occurred under the *previous spec* — its job is to
   *    revise the spec so this *class* of failures becomes unreachable, not
   *    to avoid these specific code edits. Uses third-person.
   */
  framing?: 'avoid_repeat' | 'spec_revision';
}

const DEFAULT_RECENT_FULL = 2;
const DEFAULT_MAX_OLDER = 6;
const DEFAULT_DIFF_LINE_CAP = 30;
const DEFAULT_FRAMING: 'avoid_repeat' = 'avoid_repeat';

/**
 * Render attempt history as a prompt block with explicit negative-example
 * framing. Empty history returns an empty string so callers can append
 * unconditionally.
 *
 * Layout:
 *   === Previous attempts on this module (DO NOT repeat these failed approaches) ===
 *
 *   You JUST tried (attempt #N, [stage] by author @ time):
 *     - Triggered by: <signature>
 *     - Summary: <summary>
 *     - Diff:
 *       <unified-style hunk>
 *
 *   Earlier in this session (attempts #A-#B, all <stage>/<author>):
 *     1. <signature> — <summary>
 *     2. ...
 *
 *   === End previous attempts ===
 */
export function formatAttemptHistoryForPrompt(
  history: AttemptRecord[],
  opts: PromptFormatOptions = {},
): string {
  if (history.length === 0) return '';

  const recentFull = opts.recentFull ?? DEFAULT_RECENT_FULL;
  const maxOlder = opts.maxOlder ?? DEFAULT_MAX_OLDER;
  const diffLineCap = opts.diffLineCap ?? DEFAULT_DIFF_LINE_CAP;
  const framing = opts.framing ?? DEFAULT_FRAMING;

  const recents = history.slice(Math.max(0, history.length - recentFull));
  const olderEnd = history.length - recents.length;
  const olderStart = Math.max(0, olderEnd - maxOlder);
  const olders = history.slice(olderStart, olderEnd);

  const parts: string[] = [];
  if (framing === 'avoid_repeat') {
    parts.push('=== Previous attempts on this module (DO NOT repeat these failed approaches) ===');
  } else {
    parts.push('=== Attempts that ran under the previous spec ===');
    parts.push('(These failed under the old design — your revision should make this *class* of failures unreachable, not avoid these specific code edits.)');
  }

  if (recents.length > 0) {
    parts.push('');
    // The very last recent attempt gets the strongest framing
    const last = recents[recents.length - 1]!;
    parts.push(formatRecentBlock(last, true, diffLineCap, framing));

    // Earlier "recent" attempts (between full-block and older-bullets) get
    // moderate framing
    for (let i = recents.length - 2; i >= 0; i--) {
      parts.push('');
      parts.push(formatRecentBlock(recents[i]!, false, diffLineCap, framing));
    }
  }

  if (olders.length > 0) {
    parts.push('');
    parts.push(formatOlderBullets(olders));
  }

  parts.push('');
  parts.push(framing === 'avoid_repeat' ? '=== End previous attempts ===' : '=== End attempts under previous spec ===');
  return parts.join('\n');
}

function formatRecentBlock(
  rec: AttemptRecord,
  isVeryLast: boolean,
  diffCap: number,
  framing: 'avoid_repeat' | 'spec_revision',
): string {
  const time = rec.ts.slice(11, 19); // HH:MM:SS
  let lead: string;
  if (framing === 'avoid_repeat') {
    lead = isVeryLast
      ? `You JUST tried (attempt #${rec.n}, [${rec.stage}] by ${rec.author} @ ${time}):`
      : `Just before that, attempt #${rec.n} [${rec.stage}] by ${rec.author} @ ${time}:`;
  } else {
    // spec_revision: third-person, architect didn't try anything itself
    lead = isVeryLast
      ? `Most recent attempt (#${rec.n}, [${rec.stage}] by ${rec.author} @ ${time}):`
      : `Earlier attempt #${rec.n} [${rec.stage}] by ${rec.author} @ ${time}:`;
  }
  const lines: string[] = [lead];
  lines.push(`  - Triggered by: ${formatSignature(rec.errorSig)}`);
  if (rec.summary) lines.push(`  - Summary: ${truncate(rec.summary, 200)}`);
  if (rec.diff) {
    lines.push('  - Diff:');
    lines.push(indent(capDiff(rec.diff, diffCap), '    '));
  }
  return lines.join('\n');
}

function formatOlderBullets(olders: AttemptRecord[]): string {
  // Group by stage for the header so the LLM sees patterns like "all 3
  // earlier attempts were rtl_lint_fix"
  const stages = new Set(olders.map(r => r.stage));
  const stageList = stages.size === 1
    ? `all ${[...stages][0]}`
    : `mixed: ${[...stages].join(', ')}`;
  const first = olders[0]!.n;
  const last = olders[olders.length - 1]!.n;
  const header = olders.length === 1
    ? `Earlier in this session (attempt #${first}, ${stageList}):`
    : `Earlier in this session (attempts #${first}-#${last}, ${stageList}):`;

  const bullets = olders.map(r => {
    const sig = formatSignature(r.errorSig);
    const summary = r.summary ? ` — ${truncate(r.summary, 80)}` : '';
    return `  ${r.n}. ${sig}${summary} (failed)`;
  });
  return [header, ...bullets].join('\n');
}

// ---------------------------------------------------------------------------
// Small string helpers
// ---------------------------------------------------------------------------

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + '…';
}

function indent(s: string, prefix: string): string {
  return s.split('\n').map(l => `${prefix}${l}`).join('\n');
}

function capDiff(diff: string, cap: number): string {
  const lines = diff.split('\n');
  if (lines.length <= cap) return diff;
  const headCount = Math.ceil(cap * 0.6);
  const tailCount = cap - headCount;
  const head = lines.slice(0, headCount).join('\n');
  const tail = lines.slice(lines.length - tailCount).join('\n');
  const omitted = lines.length - headCount - tailCount;
  return `${head}\n... (${omitted} diff lines omitted)\n${tail}`;
}

// ---------------------------------------------------------------------------
// Oscillation detection (used by orchestrator)
// ---------------------------------------------------------------------------

export interface OscillationResult {
  kind: 'none' | 'repeating' | 'alternating';
  /**
   * Hint string ready to embed into the next stage's prompt context.
   * Empty when kind === 'none'.
   */
  hint: string;
  /** Stage labels involved in the detected pattern, for telemetry. */
  stages: AttemptStage[];
}

/**
 * Inspect the tail of attemptHistory for repeating or alternating
 * fingerprint patterns. Returns:
 *   - 'repeating'   — same fingerprint appears N or more times in the last
 *                     `window` records (consecutive or not). Surface fixes
 *                     are not addressing the root cause.
 *   - 'alternating' — A/B alternation (≥2 swaps) — strongly suggests a
 *                     structural issue (port width / timing / protocol),
 *                     not a typo.
 *   - 'none'        — neither.
 *
 * `hint` is a prompt-ready string the orchestrator can pass into
 * runInfraDebug's spec parameter so the agent receiving the escalation
 * knows *why* it was escalated, not just the surface error.
 */
export function detectOscillation(
  history: AttemptRecord[],
  window: number = 6,
  repeatThreshold: number = 3,
): OscillationResult {
  if (history.length < repeatThreshold) {
    return { kind: 'none', hint: '', stages: [] };
  }

  const tail = history.slice(Math.max(0, history.length - window));
  const fps = tail.map(r => r.errorSig?.fingerprint ?? `__no_sig_${r.n}__`);

  // Repeating: count occurrences of each fingerprint
  const counts = new Map<string, number>();
  for (const fp of fps) counts.set(fp, (counts.get(fp) ?? 0) + 1);
  for (const [fp, count] of counts.entries()) {
    if (count >= repeatThreshold) {
      const matching = tail.filter(r => (r.errorSig?.fingerprint ?? `__no_sig_${r.n}__`) === fp);
      // Pick the first record that actually has a signature so the hint
      // text reads as a real signature; defensively fall back to the head
      // of the matching list (formatSignature handles undefined).
      const sig = matching.find(r => r.errorSig)?.errorSig ?? matching[0]!.errorSig;
      const stages = uniq(matching.map(r => r.stage));
      const hint =
        `Previous ${count} attempts all hit the same error class (${formatSignature(sig)}). ` +
        `Surface fixes have not addressed the root cause. ` +
        `Consider whether the issue lies in another file/module rather than at the cited location, ` +
        `or whether the testbench/checker itself encodes a wrong expectation.`;
      return { kind: 'repeating', hint, stages };
    }
  }

  // Alternating: A/B/A/B with at least 2 swaps in the tail
  if (tail.length >= 4) {
    let swaps = 0;
    let alternating = true;
    for (let i = 1; i < tail.length; i++) {
      if (fps[i] === fps[i - 1]) {
        // consecutive same — break alternating pattern
        alternating = false;
        break;
      }
      if (i >= 2 && fps[i] !== fps[i - 2]) {
        // not the A/B/A/B pattern
        alternating = false;
        break;
      }
      if (i >= 2) swaps++;
    }
    if (alternating && swaps >= 2) {
      const sigA = tail[tail.length - 2]!.errorSig;
      const sigB = tail[tail.length - 1]!.errorSig;
      const stages = uniq(tail.map(r => r.stage));
      const hint =
        `Previous attempts oscillated between two distinct errors: ` +
        `(A) ${formatSignature(sigA)} and (B) ${formatSignature(sigB)}. ` +
        `This alternating pattern suggests a structural issue (port width / timing / protocol mismatch ` +
        `between modules, or a contract violation between RTL and TB), not a localized typo. ` +
        `Investigate at the boundary level rather than the cited location.`;
      return { kind: 'alternating', hint, stages };
    }
  }

  return { kind: 'none', hint: '', stages: [] };
}

function uniq<T>(arr: T[]): T[] {
  return [...new Set(arr)];
}
