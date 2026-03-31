/**
 * Backend Engineer stage for RTL-Claw v2.
 *
 * Handles constraint generation, synthesis script creation, synthesis execution,
 * and timing analysis with optional register insertion recommendations.
 */

import type { StageContext, OutputChunk } from './types.js';
import {
  buildBEConstraintsMessages,
  buildBESynthScriptMessages,
  buildBETimingAnalysisMessages,
} from '../agents/context-builder.js';

// ---------------------------------------------------------------------------
// Timing violation detection
// ---------------------------------------------------------------------------

const TIMING_VIOLATION_RE = /timing\s*violation|negative\s*slack|WNS\s*[<:]\s*-/i;

// ---------------------------------------------------------------------------
// BE Stage
// ---------------------------------------------------------------------------

export async function* runBEStage(ctx: StageContext): AsyncGenerator<OutputChunk> {
  // --- Step 1: Ask user for target device ---
  yield { type: 'status', content: 'Requesting target device information...' };

  const targetDevice = await ctx.askUser(
    'What is the target device for synthesis? (e.g., "Xilinx xc7a35t", "Intel Cyclone V", "ASIC 28nm")',
  );

  yield { type: 'text', content: `Target device: ${targetDevice}` };

  const topModule = ctx.designIndex.topModules[0] ?? 'top';

  // --- Step 2: Generate constraints ---
  yield { type: 'progress', content: 'Generating synthesis constraints...' };

  const constraintMsgs = buildBEConstraintsMessages(ctx.designIndex, targetDevice);
  const constraintResp = await ctx.llm.complete(constraintMsgs);
  const constraintContent = constraintResp.content;

  yield { type: 'text', content: constraintContent };

  // Write constraints file
  await ctx.executeAction({
    type: 'writeFile',
    payload: { path: 'hw/syn/constraints.sdc', content: constraintContent },
  });

  yield { type: 'status', content: 'Constraints written to hw/syn/constraints.sdc' };

  // --- Step 3: Generate synthesis script ---
  yield { type: 'progress', content: 'Generating synthesis script...' };

  const synthScriptMsgs = buildBESynthScriptMessages(topModule, targetDevice, ctx.filelistPath);
  const synthScriptResp = await ctx.llm.complete(synthScriptMsgs);
  const synthScriptContent = synthScriptResp.content;

  yield { type: 'text', content: synthScriptContent };

  await ctx.executeAction({
    type: 'writeFile',
    payload: { path: 'hw/syn/synth.ys', content: synthScriptContent },
  });

  yield { type: 'status', content: 'Synthesis script written to hw/syn/synth.ys' };

  // --- Step 4: Run synthesis ---
  yield { type: 'progress', content: 'Running synthesis...' };

  const synthesisOutput = await ctx.executeAction({
    type: 'synthesize',
    payload: { script: 'hw/syn/synth.ys' },
  });

  yield { type: 'text', content: `Synthesis completed.\n\n${synthesisOutput}` };

  // --- Step 5: Analyze results ---
  yield { type: 'progress', content: 'Analyzing synthesis results...' };

  const analysisMsgs = buildBETimingAnalysisMessages(synthesisOutput, ctx.designIndex);
  const analysisResp = await ctx.llm.complete(analysisMsgs);
  const analysisContent = analysisResp.content;

  yield { type: 'text', content: analysisContent };

  // --- Step 6: Check for timing violations ---
  if (TIMING_VIOLATION_RE.test(synthesisOutput) || TIMING_VIOLATION_RE.test(analysisContent)) {
    yield {
      type: 'status',
      content: 'Timing violations detected in synthesis results.',
    };

    const userChoice = await ctx.askUser(
      'Timing violations were detected. Would you like the Backend Engineer to suggest register insertion points to fix timing? (yes/no)',
    );

    if (/^y(es)?$/i.test(userChoice.trim())) {
      yield { type: 'progress', content: 'Generating register insertion recommendations...' };
      yield {
        type: 'text',
        content: 'Register insertion recommendations are included in the analysis above. Please review the suggested pipeline stage insertions.',
      };
    } else {
      yield { type: 'status', content: 'Skipping register insertion. Proceeding with current results.' };
    }
  } else {
    yield { type: 'status', content: 'No timing violations detected. Synthesis stage complete.' };
  }
}
