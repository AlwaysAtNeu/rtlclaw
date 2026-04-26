/**
 * Minimal unified-style diff for AttemptRecord.diff fields.
 *
 * We intentionally avoid a full Myers diff: for the way these diffs are
 * consumed (LLM prompt context, "you JUST tried X — got error Y"), what
 * matters is showing the *changed region*, not perfect line-level alignment.
 *
 * Strategy: trim common prefix + suffix lines, render the residual hunk on
 * each side, cap output length so token budget stays sane.
 */

const DEFAULT_HUNK_LINE_CAP = 30;

/**
 * Compute a compact diff between two file-content strings. Returns a string
 * suitable for embedding in a prompt under "you tried this:" framing.
 *
 * Special cases:
 *   - before empty → returns "[NEW FILE: <n> lines]" + first 20 lines
 *   - after empty (deletion) → returns "[FILE EMPTIED]"
 *   - no change → returns "[NO CHANGE]"
 */
export function computeDiff(
  before: string,
  after: string,
  hunkLineCap: number = DEFAULT_HUNK_LINE_CAP,
): string {
  if (!before && !after) return '[NO CHANGE]';
  if (!before) {
    const lines = after.split('\n');
    const head = lines.slice(0, 20).map(l => `+ ${l}`).join('\n');
    const tail = lines.length > 20 ? `\n+ ... (+${lines.length - 20} more lines)` : '';
    return `[NEW FILE: ${lines.length} lines]\n${head}${tail}`;
  }
  if (!after) return '[FILE EMPTIED]';
  if (before === after) return '[NO CHANGE]';

  const beforeLines = before.split('\n');
  const afterLines = after.split('\n');

  // Common prefix
  let prefixLen = 0;
  const minLen = Math.min(beforeLines.length, afterLines.length);
  while (prefixLen < minLen && beforeLines[prefixLen] === afterLines[prefixLen]) {
    prefixLen++;
  }

  // Common suffix (not extending into prefix region)
  let suffixLen = 0;
  while (
    suffixLen < beforeLines.length - prefixLen &&
    suffixLen < afterLines.length - prefixLen &&
    beforeLines[beforeLines.length - 1 - suffixLen] === afterLines[afterLines.length - 1 - suffixLen]
  ) {
    suffixLen++;
  }

  const beforeChanged = beforeLines.slice(prefixLen, beforeLines.length - suffixLen);
  const afterChanged = afterLines.slice(prefixLen, afterLines.length - suffixLen);

  const startLine = prefixLen + 1;
  const beforeEnd = prefixLen + beforeChanged.length;
  const afterEnd = prefixLen + afterChanged.length;

  const halfCap = Math.max(5, Math.floor(hunkLineCap / 2));
  const beforeRendered = renderHunk(beforeChanged, '-', halfCap);
  const afterRendered = renderHunk(afterChanged, '+', halfCap);

  const header = `@@ before lines ${startLine}-${beforeEnd} (${beforeChanged.length}), ` +
    `after lines ${startLine}-${afterEnd} (${afterChanged.length}) @@`;
  return `${header}\n${beforeRendered}\n${afterRendered}`;
}

function renderHunk(lines: string[], prefix: '+' | '-', cap: number): string {
  if (lines.length === 0) return `${prefix} (no lines on this side)`;
  if (lines.length <= cap) return lines.map(l => `${prefix} ${l}`).join('\n');
  const headCount = Math.ceil(cap * 0.6);
  const tailCount = cap - headCount;
  const head = lines.slice(0, headCount).map(l => `${prefix} ${l}`).join('\n');
  const tail = lines.slice(lines.length - tailCount).map(l => `${prefix} ${l}`).join('\n');
  const omitted = lines.length - headCount - tailCount;
  return `${head}\n${prefix} ... (${omitted} lines omitted)\n${tail}`;
}
