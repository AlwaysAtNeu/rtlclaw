/**
 * Design parameters file generation (v3).
 *
 * Deterministic (no LLM) — generates design_params.vh (Verilog `define)
 * or design_params_pkg.sv (SystemVerilog package) from globalParameters.
 */

import type { ArchitectPhase1Output } from '../agents/types.js';
import type { StageContext, OutputChunk } from './types.js';

/** Append +incdir+ to filelist only if not already present. */
async function appendIncdirIfNeeded(ctx: StageContext, dir: string): Promise<void> {
  const incdirLine = `+incdir+${dir}`;
  try {
    const existing = await ctx.readFile(ctx.filelistPath);
    if (existing.includes(incdirLine)) return; // Already present
  } catch { /* filelist doesn't exist yet, proceed */ }

  await ctx.executeAction({
    type: 'writeFile',
    payload: { path: ctx.filelistPath, content: incdirLine, append: true },
  });
}

/**
 * Generate design_params file and append include dir to filelist.
 */
export async function* generateDesignParams(
  ctx: StageContext,
  phase1: ArchitectPhase1Output,
  hdlStandard?: string,
): AsyncGenerator<OutputChunk> {
  const params = phase1.globalParameters;
  if (!params || Object.keys(params).length === 0) {
    yield { type: 'status', content: 'No global parameters defined, skipping design_params generation.' };
    return;
  }

  const isSV = hdlStandard?.startsWith('sv');

  if (isSV) {
    yield* generateSVPackage(ctx, params);
  } else {
    yield* generateVerilogDefines(ctx, params);
  }
}

async function* generateVerilogDefines(
  ctx: StageContext,
  params: Record<string, number | string>,
): AsyncGenerator<OutputChunk> {
  const lines: string[] = [
    '// Auto-generated design parameters — do not edit manually',
    '`ifndef DESIGN_PARAMS_VH',
    '`define DESIGN_PARAMS_VH',
    '',
  ];

  for (const [key, value] of Object.entries(params)) {
    if (typeof value === 'number') {
      lines.push(`\`define ${key} ${value}`);
    } else {
      lines.push(`\`define ${key} ${value}`);
    }
  }

  lines.push('', '`endif // DESIGN_PARAMS_VH', '');

  const filePath = 'hw/src/macro/design_params.vh';
  const content = lines.join('\n');

  await ctx.executeAction({
    type: 'writeFile',
    payload: { path: filePath, content },
  });

  yield { type: 'progress', content: `Generated ${filePath} (${Object.keys(params).length} parameters)` };

  // Append +incdir+ to filelist (skip if already present from Architect's initialContent)
  await appendIncdirIfNeeded(ctx, 'hw/src/macro');

  yield { type: 'status', content: 'Design parameters file generated (Verilog `define format).' };
}

async function* generateSVPackage(
  ctx: StageContext,
  params: Record<string, number | string>,
): AsyncGenerator<OutputChunk> {
  const lines: string[] = [
    '// Auto-generated design parameters package — do not edit manually',
    'package design_params_pkg;',
    '',
  ];

  for (const [key, value] of Object.entries(params)) {
    if (typeof value === 'number') {
      lines.push(`  parameter ${key} = ${value};`);
    } else {
      lines.push(`  parameter ${key} = ${value};`);
    }
  }

  lines.push('', 'endpackage', '');

  const filePath = 'hw/src/macro/design_params_pkg.sv';
  const content = lines.join('\n');

  await ctx.executeAction({
    type: 'writeFile',
    payload: { path: filePath, content },
  });

  yield { type: 'progress', content: `Generated ${filePath} (${Object.keys(params).length} parameters)` };

  // Append to filelist
  await ctx.executeAction({
    type: 'writeFile',
    payload: {
      path: ctx.filelistPath,
      content: filePath,
      append: true,
    },
  });

  // Also add incdir for any `include usage (skip if already present)
  await appendIncdirIfNeeded(ctx, 'hw/src/macro');

  yield { type: 'status', content: 'Design parameters file generated (SystemVerilog package format).' };
}
