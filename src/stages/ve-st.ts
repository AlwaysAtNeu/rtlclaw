/**
 * VE System Test stage for RTL-Claw v2.
 *
 * Generates system-level testbenches and test cases that exercise the
 * integrated design through the top module.  Unlike UT, system tests
 * can exercise cross-module interactions and integration paths.
 */

import type { PortDef, InterfaceContract } from '../agents/types.js';
import type { StageContext, OutputChunk } from './types.js';
import { buildVESystemTBMessages } from '../agents/context-builder.js';
import { parseLLMCodeBlocks } from './ve-ut.js';

// ---------------------------------------------------------------------------
// Generate ST testbench + test cases
// ---------------------------------------------------------------------------

/**
 * Generate a system testbench and test-case files for the top-level module.
 * Yields status {@link OutputChunk}s for UI progress.
 *
 * Writes:
 *   hw/dv/st/sim/tb/tb_{topModule}.sv   — system testbench
 *   hw/dv/st/sim/tc/tc_{topModule}_*.sv — system test case(s)
 */
export async function* generateSTTestbench(
  ctx: StageContext,
  stVerificationReqs: string,
  allModulePorts: Array<{ name: string; ports: PortDef[] }>,
  topModuleName: string,
  interfaceContracts?: InterfaceContract[],
  globalParameters?: Record<string, number | string>,
): AsyncGenerator<OutputChunk> {
  yield {
    type: 'status',
    content: `[VE-ST] Generating system testbench for ${topModuleName}...`,
  };

  const messages = buildVESystemTBMessages(
    stVerificationReqs,
    allModulePorts,
    topModuleName,
    interfaceContracts,
    globalParameters,
  );

  const startMs = Date.now();
  const response = await ctx.llm.complete(messages, { temperature: 0.2 });
  const durationMs = Date.now() - startMs;

  if (ctx.logTrace) {
    await ctx.logTrace({
      timestamp: new Date().toISOString(),
      role: 'VerificationEngineer',
      promptTokens: response.usage.promptTokens,
      completionTokens: response.usage.completionTokens,
      durationMs,
      taskContext: `ve-st:generate:${topModuleName}`,
    });
  }

  const blocks = parseLLMCodeBlocks(response.content);

  if (blocks.length === 0) {
    yield {
      type: 'error',
      content: `[VE-ST] LLM response for ${topModuleName} contained no code blocks.`,
    };
    return;
  }

  const tbDir = `hw/dv/st/sim/tb`;
  const tcDir = `hw/dv/st/sim/tc`;
  let tbWritten = false;
  let tcCount = 0;

  for (const block of blocks) {
    const isTB =
      block.path.includes('/tb/') ||
      block.path.startsWith('tb_') ||
      block.path.includes(`tb_${topModuleName}`) ||
      (!block.path && !tbWritten);

    if (isTB && !tbWritten) {
      const tbPath = block.path?.startsWith('hw/')
        ? block.path
        : `${tbDir}/tb_${topModuleName}.sv`;

      await ctx.executeAction({
        type: 'writeFile',
        payload: { path: tbPath, content: block.content },
      });

      tbWritten = true;
      yield {
        type: 'progress',
        content: `[VE-ST] Wrote system testbench: ${tbPath}`,
        metadata: { file: tbPath },
      };
    } else {
      tcCount++;
      const tcPath = block.path?.startsWith('hw/')
        ? block.path
        : block.path && block.path.includes('tc_')
          ? `${tcDir}/${block.path.split('/').pop()}`
          : `${tcDir}/tc_${topModuleName}_${tcCount}.sv`;

      await ctx.executeAction({
        type: 'writeFile',
        payload: { path: tcPath, content: block.content },
      });

      yield {
        type: 'progress',
        content: `[VE-ST] Wrote system test case: ${tcPath}`,
        metadata: { file: tcPath },
      };
    }
  }

  // Fallback: if no TB was identified, write the full response
  if (!tbWritten) {
    const fallbackPath = `${tbDir}/tb_${topModuleName}.sv`;
    await ctx.executeAction({
      type: 'writeFile',
      payload: { path: fallbackPath, content: response.content },
    });
    yield {
      type: 'progress',
      content: `[VE-ST] Wrote raw system TB (no code blocks parsed): ${fallbackPath}`,
      metadata: { file: fallbackPath },
    };
  }

  yield {
    type: 'status',
    content: `[VE-ST] System testbench generation complete for ${topModuleName} (${tcCount} test case(s)).`,
  };
}
