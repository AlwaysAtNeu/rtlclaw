/**
 * VE Unit Test stage for RTL-Claw v2.
 *
 * Generates unit testbenches and test cases, reviews TBs when questioned
 * by the RTL Designer (tb_suspect mechanism), and adds VCD dumping as
 * a fallback debug aid.
 *
 * BLACK-BOX principle: the VE never receives RTL source code — only port
 * definitions and verification requirements from the Architect.
 */

import type { PortDef } from '../agents/types.js';
import type { Message } from '../llm/types.js';
import type { StageContext, OutputChunk } from './types.js';
import {
  buildVEUnitTBMessages,
  buildVETBReviewMessages,
  buildVECompileFixMessages,
  buildSpecCheckerAuditMessages,
} from '../agents/context-builder.js';

function promptChars(msgs: Message[]): number {
  return msgs.reduce((sum, m) => sum + m.content.length, 0);
}

// ---------------------------------------------------------------------------
// Helper: parse fenced code blocks from LLM output
// ---------------------------------------------------------------------------

/**
 * Extracts all fenced code blocks that carry a filename annotation.
 *
 * Supported formats:
 *   ```sv:path/to/file.sv          (lang:path)
 *   ```systemverilog path/to/file  (lang path)
 *   ```verilog // file: path.v     (comment-style)
 *
 * Blocks without an identifiable path are still returned with an empty
 * `path` — the caller decides how to handle them.
 */
export function parseLLMCodeBlocks(
  text: string,
): Array<{ path: string; content: string; lang: string }> {
  const results: Array<{ path: string; content: string; lang: string }> = [];

  // Regex: ``` optionally followed by lang and/or path, then content until ```
  const blockRe = /```(\S*?)(?:[:\s]\s*(.+?))?\s*\n([\s\S]*?)```/g;
  let match: RegExpExecArray | null;

  while ((match = blockRe.exec(text)) !== null) {
    const rawLang = (match[1] ?? '').replace(/:.*/, '').trim();
    let rawPath = (match[2] ?? '').trim();
    const content = match[3] ?? '';

    // Normalise lang tag
    const lang = rawLang || 'sv';

    // Try to extract path from the first line of the annotation
    // e.g.  "// file: hw/dv/ut/sim/tb/tb_foo.sv"
    if (!rawPath) {
      const commentPath = content.match(
        /^\/\/\s*(?:file|FILE|path|PATH)\s*:\s*(\S+)/,
      );
      if (commentPath) {
        rawPath = commentPath[1];
      }
    }

    // Also handle ``` lang:path format where the path was absorbed into lang
    if (!rawPath && match[1]?.includes(':')) {
      rawPath = match[1].split(':').slice(1).join(':');
    }

    results.push({ path: rawPath, content: content.trimEnd(), lang });
  }

  return results;
}

// ---------------------------------------------------------------------------
// 1. Generate UT testbench + test cases
// ---------------------------------------------------------------------------

/**
 * Generate a unit testbench and one or more test-case files for a single
 * module.  Yields status {@link OutputChunk}s so the UI can show progress.
 *
 * Writes:
 *   hw/dv/ut/sim/tb/tb_{module}.sv   — testbench
 *   hw/dv/ut/sim/tc/tc_{module}_*.sv — test case(s)
 */
export async function* generateUTTestbench(
  ctx: StageContext,
  moduleName: string,
  portDefs: PortDef[],
  utVerificationReqs: string,
  p2Spec?: { functionalSpec?: string; fsmDescription?: string; timingNotes?: string; boundaryConditions?: string[] },
): AsyncGenerator<OutputChunk> {
  yield {
    type: 'status',
    content: `[VE-UT] Generating unit testbench for ${moduleName}...`,
  };

  const messages = buildVEUnitTBMessages(moduleName, portDefs, utVerificationReqs, undefined, p2Spec);

  const startMs = Date.now();
  const response = await ctx.llm.complete(messages, { temperature: 0.2 });
  const durationMs = Date.now() - startMs;

  const blocks = parseLLMCodeBlocks(response.content);
  const hasCode = blocks.length > 0;

  // Log the LLM call
  if (ctx.logTrace) {
    await ctx.logTrace({
      timestamp: new Date().toISOString(),
      role: 'VerificationEngineer',
      promptTokens: response.usage.promptTokens,
      completionTokens: response.usage.completionTokens,
      durationMs,
      taskContext: `ve-ut:generate:${moduleName}`,
      promptChars: promptChars(messages),
      responseChars: response.content.length,
      hasCodeBlock: hasCode,
      retryCount: response.retryCount,
      summary: hasCode
        ? `generated ${blocks.length} TB/TC file(s) for ${moduleName}`
        : `no code blocks in VE response for ${moduleName}`,
      promptContent: messages,
      responseContent: response.content,
    });
  }

  if (!hasCode) {
    yield {
      type: 'error',
      content: `[VE-UT] LLM response for ${moduleName} contained no code blocks.`,
    };
    return;
  }

  // Categorise blocks into TB and TC files
  const tbDir = `hw/dv/ut/sim/tb`;
  const tcDir = `hw/dv/ut/sim/tc`;
  let tbWritten = false;
  let tcCount = 0;

  for (const block of blocks) {
    const isTB =
      block.path.includes('/tb/') ||
      block.path.startsWith('tb_') ||
      block.path.includes(`tb_${moduleName}`) ||
      (!block.path && !tbWritten); // first unnamed block assumed to be TB

    if (isTB && !tbWritten) {
      const tbPath = block.path || `${tbDir}/tb_${moduleName}.sv`;
      const normalised = tbPath.startsWith('hw/')
        ? tbPath
        : `${tbDir}/tb_${moduleName}.sv`;

      await ctx.executeAction({
        type: 'writeFile',
        payload: { path: normalised, content: block.content },
      });

      tbWritten = true;
      yield {
        type: 'progress',
        content: `[VE-UT] Wrote testbench: ${normalised}`,
        metadata: { file: normalised },
      };
    } else {
      // Test case file
      tcCount++;
      const tcPath = block.path?.startsWith('hw/')
        ? block.path
        : block.path && block.path.includes('tc_')
          ? `${tcDir}/${block.path.split('/').pop()}`
          : `${tcDir}/tc_${moduleName}_${tcCount}.sv`;

      await ctx.executeAction({
        type: 'writeFile',
        payload: { path: tcPath, content: block.content },
      });

      yield {
        type: 'progress',
        content: `[VE-UT] Wrote test case: ${tcPath}`,
        metadata: { file: tcPath },
      };
    }
  }

  // Fallback: if we did not write a TB from blocks, write the whole response
  if (!tbWritten) {
    const fallbackPath = `${tbDir}/tb_${moduleName}.sv`;
    await ctx.executeAction({
      type: 'writeFile',
      payload: { path: fallbackPath, content: response.content },
    });
    yield {
      type: 'progress',
      content: `[VE-UT] Wrote raw TB (no code blocks parsed): ${fallbackPath}`,
      metadata: { file: fallbackPath },
    };
  }

  yield {
    type: 'status',
    content: `[VE-UT] Testbench generation complete for ${moduleName} (${tcCount} test case(s)).`,
  };
}

// ---------------------------------------------------------------------------
// 2. Review TB after Designer's tb_suspect
// ---------------------------------------------------------------------------

/**
 * Review the current testbench after the RTL Designer flagged `tb_suspect`.
 *
 * Returns whether the TB was deemed correct, and if not the path to the
 * fixed testbench file.
 */
export async function reviewTB(
  ctx: StageContext,
  moduleName: string,
  designerReason: string,
  verificationReqs: string,
): Promise<{ tbCorrect: boolean; fixedTBPath?: string; reason?: string }> {
  // Read current TB — try .sv first, then .v
  const tbPathSV = `hw/dv/ut/sim/tb/tb_${moduleName}.sv`;
  const tbPathV = `hw/dv/ut/sim/tb/tb_${moduleName}.v`;

  let tbCode: string;
  let tbPath: string;
  try {
    tbCode = await ctx.readFile(tbPathSV);
    tbPath = tbPathSV;
  } catch {
    tbCode = await ctx.readFile(tbPathV);
    tbPath = tbPathV;
  }

  const messages = buildVETBReviewMessages(
    moduleName,
    designerReason,
    tbCode,
    verificationReqs,
  );

  const startMs = Date.now();
  const response = await ctx.llm.complete(messages, { temperature: 0.1 });
  const durationMs = Date.now() - startMs;

  if (ctx.logTrace) {
    await ctx.logTrace({
      timestamp: new Date().toISOString(),
      role: 'VerificationEngineer',
      promptTokens: response.usage.promptTokens,
      completionTokens: response.usage.completionTokens,
      durationMs,
      taskContext: `ve-ut:review-tb:${moduleName}`,
      promptChars: promptChars(messages),
      responseChars: response.content.length,
      retryCount: response.retryCount,
      summary: `TB review for ${moduleName} (${response.content.length} chars response)`,
      promptContent: messages,
      responseContent: response.content,
    });
  }

  const text = response.content.toLowerCase();

  // Heuristic: if the response says the TB is correct / no changes needed
  const correctIndicators = [
    'testbench is correct',
    'tb is correct',
    'no changes needed',
    'no fix needed',
    'no issues found',
    'testbench looks correct',
  ];

  const tbIsCorrect = correctIndicators.some((ind) => text.includes(ind));

  if (tbIsCorrect) {
    // Extract VE's reasoning for why TB is correct
    const reason = response.content.length > 0
      ? response.content.slice(0, 500).trim()
      : 'TB deemed correct (no detailed reason provided)';
    return { tbCorrect: true, reason };
  }

  // Extract VE's reasoning (text before code blocks, or full response)
  const reasonMatch = response.content.match(/^([\s\S]*?)```/);
  const fixReason = reasonMatch?.[1]?.trim() || 'TB had issues (see fixed code)';

  // VE provided a fix — extract and write it
  const blocks = parseLLMCodeBlocks(response.content);
  if (blocks.length > 0) {
    const fixedContent = blocks[0].content;
    await ctx.executeAction({
      type: 'writeFile',
      payload: { path: tbPath, content: fixedContent },
    });
    return { tbCorrect: false, fixedTBPath: tbPath, reason: fixReason };
  }

  // Could not parse a code block — write the full response as best-effort fix
  await ctx.executeAction({
    type: 'writeFile',
    payload: { path: tbPath, content: response.content },
  });
  return { tbCorrect: false, fixedTBPath: tbPath, reason: fixReason };
}

// ---------------------------------------------------------------------------
// 3. Add VCD dump to existing TB
// ---------------------------------------------------------------------------

/**
 * Modify the current testbench to include `$dumpfile` / `$dumpvars` so a
 * VCD waveform can be produced for debug.  Returns `true` on success.
 */
export async function addVCDToTB(
  ctx: StageContext,
  moduleName: string,
  _failingSignals: string[],
): Promise<boolean> {
  // Read current TB
  const tbPathSV = `hw/dv/ut/sim/tb/tb_${moduleName}.sv`;
  const tbPathV = `hw/dv/ut/sim/tb/tb_${moduleName}.v`;

  let tbCode: string;
  let tbPath: string;
  try {
    tbCode = await ctx.readFile(tbPathSV);
    tbPath = tbPathSV;
  } catch {
    try {
      tbCode = await ctx.readFile(tbPathV);
      tbPath = tbPathV;
    } catch {
      return false;
    }
  }

  // Already has VCD dump — skip
  if (tbCode.includes('$dumpfile') || tbCode.includes('$dumpvars')) {
    return true;
  }

  // Deterministic insertion: find the TB module name and insert after `initial begin`
  const tbModMatch = tbCode.match(/module\s+(\w+)/);
  const tbModName = tbModMatch ? tbModMatch[1] : `tb_${moduleName}`;

  // Insert $dumpfile/$dumpvars after the first `initial begin`
  const initialIdx = tbCode.indexOf('initial begin');
  if (initialIdx < 0) return false;

  const insertPos = tbCode.indexOf('\n', initialIdx);
  if (insertPos < 0) return false;

  const vcdSnippet = `\n    $dumpfile("wave.vcd");\n    $dumpvars(0, ${tbModName});`;
  const updatedCode = tbCode.slice(0, insertPos) + vcdSnippet + tbCode.slice(insertPos);

  await ctx.executeAction({
    type: 'writeFile',
    payload: { path: tbPath, content: updatedCode },
  });

  return true;
}

// ---------------------------------------------------------------------------
// 4. Fix TB/TC compilation errors (v3)
// ---------------------------------------------------------------------------

/**
 * Fix compilation errors in TB/TC files by calling the VE LLM.
 * Returns true if a fix was applied.
 */
export async function fixCompileErrors(
  ctx: StageContext,
  moduleName: string,
  compileErrors: string,
): Promise<boolean> {
  // Read current TB
  const tbPathSV = `hw/dv/ut/sim/tb/tb_${moduleName}.sv`;
  const tbPathV = `hw/dv/ut/sim/tb/tb_${moduleName}.v`;

  let tbCode: string;
  let tbPath: string;
  try {
    tbCode = await ctx.readFile(tbPathSV);
    tbPath = tbPathSV;
  } catch {
    try {
      tbCode = await ctx.readFile(tbPathV);
      tbPath = tbPathV;
    } catch {
      return false;
    }
  }

  // Build extra context for include-path / file-not-found errors
  let extraContext: string | undefined;
  const errLower = compileErrors.toLowerCase();
  const isIncludeError = /include file|not found|no such file|could not open|no top level modules/i.test(errLower);
  if (isIncludeError) {
    const parts: string[] = [];
    // List project file structure for path resolution
    try {
      const { readdirSync, existsSync } = await import('node:fs');
      const path = await import('node:path');
      const projectPath = ctx.projectPath;
      const listDir = (rel: string): string[] => {
        const abs = path.join(projectPath, rel);
        if (!existsSync(abs)) return [];
        try {
          return readdirSync(abs).map(f => `${rel}/${f}`);
        } catch { return []; }
      };
      const dirs = ['hw/src/hdl', 'hw/src/macro', 'hw/src/filelist', 'hw/dv/ut/sim/tb', 'hw/dv/ut/sim/tc'];
      const fileList: string[] = [];
      for (const d of dirs) fileList.push(...listDir(d));
      if (fileList.length > 0) {
        parts.push(`Project file structure:\n${fileList.join('\n')}`);
      }
    } catch { /* ignore */ }

    // Read filelist if it exists
    try {
      const filelist = await ctx.readFile(ctx.filelistPath);
      parts.push(`Design filelist (${ctx.filelistPath}):\n${filelist}`);
    } catch { /* ignore */ }

    // Try to read the RTL source file for reference
    for (const ext of ['.sv', '.v']) {
      try {
        const rtlCode = await ctx.readFile(`hw/src/hdl/${moduleName}${ext}`);
        parts.push(`RTL source (hw/src/hdl/${moduleName}${ext}):\n\`\`\`\n${rtlCode}\n\`\`\``);
        break;
      } catch { /* try next */ }
    }

    if (parts.length > 0) {
      extraContext = parts.join('\n\n');
    }
  }

  const messages = buildVECompileFixMessages(moduleName, compileErrors, tbCode, extraContext);

  const startMs = Date.now();
  const response = await ctx.llm.complete(messages, { temperature: 0.1 });
  const durationMs = Date.now() - startMs;

  const blocks = parseLLMCodeBlocks(response.content);

  if (ctx.logTrace) {
    await ctx.logTrace({
      timestamp: new Date().toISOString(),
      role: 'VerificationEngineer',
      promptTokens: response.usage.promptTokens,
      completionTokens: response.usage.completionTokens,
      durationMs,
      taskContext: `ve-ut:compile-fix:${moduleName}`,
      promptChars: promptChars(messages),
      responseChars: response.content.length,
      hasCodeBlock: blocks.length > 0,
      retryCount: response.retryCount,
      summary: blocks.length > 0
        ? `compile fix applied (${blocks.length} file(s)) for ${moduleName}`
        : `no code in compile fix response for ${moduleName}`,
      promptContent: messages,
      responseContent: response.content,
    });
  }

  // Write ALL code blocks from the response (LLM may fix multiple files)
  if (blocks.length > 0) {
    for (const block of blocks) {
      const targetPath = block.path?.startsWith('hw/') ? block.path : tbPath;
      await ctx.executeAction({
        type: 'writeFile',
        payload: { path: targetPath, content: block.content },
      });
    }
    return true;
  }

  return false;
}

// ---------------------------------------------------------------------------
// Spec-Checker Audit: conclusive diagnosis of checker correctness
// ---------------------------------------------------------------------------

export interface SpecCheckerAuditResult {
  checkerCorrect: boolean;
  analysis: string;
  mismatch?: string;
  specClause?: string;
  recommendation: 'fix_tb' | 'fix_rtl';
}

/**
 * Audits whether a TB checker correctly implements the functional spec.
 * Returns a conclusive judgment — not a guess.
 */
export async function auditSpecVsChecker(
  ctx: StageContext,
  moduleName: string,
  functionalSpec: string,
  checkerCode: string,
  checkerOutput: string,
): Promise<SpecCheckerAuditResult> {
  const messages = buildSpecCheckerAuditMessages(
    moduleName, functionalSpec, checkerCode, checkerOutput,
  );

  const startMs = Date.now();
  const response = await ctx.llm.complete(messages, { temperature: 0.1 });
  const durationMs = Date.now() - startMs;

  if (ctx.logTrace) {
    await ctx.logTrace({
      timestamp: new Date().toISOString(),
      role: 'VerificationAuditor',
      promptTokens: response.usage.promptTokens,
      completionTokens: response.usage.completionTokens,
      durationMs,
      taskContext: `spec-audit:${moduleName}`,
      promptChars: promptChars(messages),
      responseChars: response.content.length,
      retryCount: response.retryCount,
      summary: `spec-checker audit for ${moduleName}`,
      promptContent: messages,
      responseContent: response.content,
    });
  }

  // Parse JSON from response (may be wrapped in code fences)
  const jsonMatch = response.content.match(/```(?:json)?\s*\n?([\s\S]*?)```/)
    ?? response.content.match(/\{[\s\S]*"checkerCorrect"[\s\S]*\}/);
  if (jsonMatch) {
    try {
      const raw = jsonMatch[1] ?? jsonMatch[0];
      const parsed = JSON.parse(raw);
      return {
        checkerCorrect: !!parsed.checkerCorrect,
        analysis: parsed.analysis ?? '',
        mismatch: parsed.mismatch,
        specClause: parsed.specClause,
        recommendation: parsed.recommendation === 'fix_tb' ? 'fix_tb' : 'fix_rtl',
      };
    } catch { /* fall through */ }
  }

  // Fallback: couldn't parse, assume RTL needs fix (safer default)
  return {
    checkerCorrect: true,
    analysis: response.content.slice(0, 500),
    recommendation: 'fix_rtl',
  };
}
