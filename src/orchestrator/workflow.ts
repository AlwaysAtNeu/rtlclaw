/**
 * Workflow engine for RTL-Claw v2.
 *
 * Orchestrates the complete design workflow by calling stage modules in sequence.
 * This replaces the god-class orchestrator's inline stage logic.
 *
 * Flow: Architect P1 → [per module: Architect P2 → RTL → Lint → VE UT → Debug] → VE ST → (optional BE) → Summary
 */

import type {
  DesignIndex,
  WorkflowState,
  ModuleStatus,
  ArchitectPhase1Output,
  ArchitectPhase2Output,
  PortDef,
} from '../agents/types.js';
import type { StageContext, OutputChunk } from '../stages/types.js';

// Stage imports
import { runArchitectPhase1, convertToDesignIndex } from '../stages/architect-p1.js';
import { runArchitectPhase2 } from '../stages/architect-p2.js';
import { writeModule, fixLintErrors } from '../stages/rtl-writer.js';
import { generateUTTestbench } from '../stages/ve-ut.js';
import { generateSTTestbench } from '../stages/ve-st.js';
import { runBEStage } from '../stages/be.js';
import { generateSummary } from '../stages/summary.js';

// Stub for removed debug-loop stage (logic now inlined in orchestrator)
function checkSimResult(output: string): string {
  return (output.includes('TEST PASSED') || output.includes('PASSED')) ? 'PASSED' : 'FAILED';
}
async function* runDebugLoop(
  _ctx: StageContext, _mod: ModuleStatus, _simResult: string,
): AsyncGenerator<OutputChunk> {
  yield { type: 'error', content: 'Debug loop not available (use orchestrator v2 instead)' };
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MODULE_LINE_LIMIT = 1024;

// ---------------------------------------------------------------------------
// Workflow engine
// ---------------------------------------------------------------------------

export class WorkflowEngine {
  private workflowState: WorkflowState | null = null;

  getState(): WorkflowState | null {
    return this.workflowState;
  }

  // -----------------------------------------------------------------------
  // Full new-project workflow
  // -----------------------------------------------------------------------

  async *executeNewProject(
    ctx: StageContext,
    requirement: string,
  ): AsyncGenerator<OutputChunk> {
    // ── Phase 1: Architect global architecture ──
    yield { type: 'progress', content: 'Designing architecture...' };

    let phase1Output: ArchitectPhase1Output | null = null;
    for await (const chunk of runArchitectPhase1(ctx, requirement)) {
      if (chunk.metadata?.phase1Output) {
        phase1Output = chunk.metadata.phase1Output as ArchitectPhase1Output;
      }
      yield chunk;
    }

    if (!phase1Output) {
      yield { type: 'error', content: 'Failed to get architecture from Architect.' };
      return;
    }

    // Build design index from Phase 1
    ctx.designIndex = convertToDesignIndex(phase1Output);
    ctx.phase1Output = phase1Output;

    // Save design index
    try {
      await ctx.executeAction({ type: 'updateIndex', payload: { index: ctx.designIndex } });
    } catch { /* best effort */ }

    // Initialize workflow state
    this.workflowState = this.initWorkflowState(requirement, phase1Output);
    await this.persistState(ctx);

    // ── Per-module loop ──
    yield* this.executeModuleLoop(ctx);

    // ── System test ──
    yield* this.executeSystemTest(ctx);

    // ── Optional BE ──
    if (!ctx.autoMode) {
      const answer = await ctx.askUser('Verification complete. Proceed with synthesis? (y/n)');
      if (/^y/i.test(answer.trim())) {
        yield* runBEStage(ctx);
      }
    }

    // ── Summary ──
    if (this.workflowState) {
      for (const chunk of generateSummary(this.workflowState)) {
        yield chunk;
      }
    }

    yield { type: 'status', content: 'Workflow complete.' };
    this.workflowState = null;
  }

  // -----------------------------------------------------------------------
  // Additive change: add module(s) to existing project
  // -----------------------------------------------------------------------

  async *executeAdditiveChange(
    ctx: StageContext,
    requirement: string,
  ): AsyncGenerator<OutputChunk> {
    // Run Phase 1 to get updated architecture
    yield* this.executeNewProject(ctx, requirement);
  }

  // -----------------------------------------------------------------------
  // Spec change: re-evaluate architecture then cascade
  // -----------------------------------------------------------------------

  async *executeSpecChange(
    ctx: StageContext,
    requirement: string,
  ): AsyncGenerator<OutputChunk> {
    yield* this.executeNewProject(ctx, requirement);
  }

  // -----------------------------------------------------------------------
  // Module redo: redesign + rewrite a specific module
  // -----------------------------------------------------------------------

  async *executeModuleRedo(
    ctx: StageContext,
    requirement: string,
    moduleName: string,
  ): AsyncGenerator<OutputChunk> {
    if (!ctx.phase1Output) {
      yield { type: 'error', content: 'No architecture available. Run a full workflow first.' };
      return;
    }

    // Phase 2 for the specific module with updated requirements
    yield { type: 'progress', content: `Redesigning ${moduleName}...` };

    let phase2: ArchitectPhase2Output | null = null;
    for await (const chunk of runArchitectPhase2(ctx, ctx.phase1Output, moduleName)) {
      if (chunk.metadata?.phase2Output) {
        phase2 = chunk.metadata.phase2Output as ArchitectPhase2Output;
      }
      yield chunk;
    }

    if (!phase2) {
      yield { type: 'error', content: `Failed to get detailed design for ${moduleName}.` };
      return;
    }

    // Create a mini workflow state for this module
    const mod: ModuleStatus = {
      name: moduleName,
      file: `hw/src/hdl/${moduleName}.v`,
      lintPassed: false,
      utPassed: false,
      sameErrorRetries: 0,
      totalIterations: 0,
      tbSuspectCount: 0,
      status: 'pending',
      phase2Design: phase2,
      lintAttempts: 0,
      veCompileAttempts: 0,
      debugHistory: [],
    };

    yield* this.processOneModule(ctx, mod);

    // Re-test dependent modules
    const dependents = this.findDependentModules(moduleName, ctx.designIndex);
    if (dependents.length > 0) {
      yield { type: 'status', content: `Re-testing dependent modules: ${dependents.join(', ')}` };
      for (const dep of dependents) {
        yield { type: 'progress', content: `Re-testing ${dep}...` };
        // Re-run UT for dependent
        try {
          const simResult = await ctx.executeAction({
            type: 'runSimulation',
            payload: { module: dep, testType: 'ut' },
          });
          const result = checkSimResult(simResult);
          if (result === 'pass') {
            yield { type: 'status', content: `UT passed: ${dep}` };
          } else {
            yield { type: 'status', content: `UT failed: ${dep} (may need fixing)` };
          }
        } catch {
          yield { type: 'status', content: `UT skipped: ${dep} (simulation unavailable)` };
        }
      }
    }
  }

  // -----------------------------------------------------------------------
  // Resume from saved state
  // -----------------------------------------------------------------------

  async *resumeWorkflow(ctx: StageContext, savedState: WorkflowState): AsyncGenerator<OutputChunk> {
    this.workflowState = savedState;
    if (savedState.phase1Output) {
      ctx.phase1Output = savedState.phase1Output;
    }
    yield { type: 'status', content: `Resuming: ${this.describeState()}` };
    yield* this.executeModuleLoop(ctx);
    yield* this.executeSystemTest(ctx);
    yield { type: 'status', content: 'Workflow complete.' };
    this.workflowState = null;
  }

  // -----------------------------------------------------------------------
  // Per-module loop
  // -----------------------------------------------------------------------

  private async *executeModuleLoop(ctx: StageContext): AsyncGenerator<OutputChunk> {
    if (!this.workflowState || !ctx.phase1Output) return;

    const modules = this.workflowState.moduleStatuses;
    const startIdx = this.workflowState.currentModuleIndex;

    for (let i = startIdx; i < modules.length; i++) {
      const mod = modules[i]!;
      if (mod.status === 'done' || mod.status === 'skipped') continue;

      this.workflowState.currentModuleIndex = i;
      await this.persistState(ctx);

      yield { type: 'progress', content: `Module ${mod.name} (${i + 1}/${modules.length})` };

      // Phase 2: detailed design
      if (!mod.phase2Design) {
        mod.status = 'designing';
        let phase2: ArchitectPhase2Output | null = null;
        for await (const chunk of runArchitectPhase2(ctx, ctx.phase1Output, mod.name)) {
          if (chunk.metadata?.phase2Output) {
            phase2 = chunk.metadata.phase2Output as ArchitectPhase2Output;
          }
          yield chunk;
        }
        if (!phase2) {
          yield { type: 'error', content: `Failed to get detailed design for ${mod.name}. Skipping.` };
          mod.status = 'skipped';
          continue;
        }
        mod.phase2Design = phase2;
      }

      yield* this.processOneModule(ctx, mod);
      await this.persistState(ctx);
    }
  }

  // -----------------------------------------------------------------------
  // Process a single module: RTL → Lint → VE UT → Debug
  // -----------------------------------------------------------------------

  private async *processOneModule(
    ctx: StageContext,
    mod: ModuleStatus,
  ): AsyncGenerator<OutputChunk> {
    const phase2 = mod.phase2Design!;

    // ── RTL code generation ──
    mod.status = 'writing';
    yield { type: 'progress', content: `Writing ${mod.name}...` };

    const depPorts = this.getDependentModulePorts(mod.name, ctx.designIndex);

    for await (const chunk of writeModule(ctx, phase2, depPorts)) {
      yield chunk;
    }

    // Module size check
    try {
      const content = await ctx.readFile(mod.file);
      const lineCount = content.split('\n').length;
      if (lineCount > MODULE_LINE_LIMIT) {
        yield { type: 'status', content: `Warning: ${mod.name} is ${lineCount} lines (limit ${MODULE_LINE_LIMIT}). Consider splitting.` };
      }
    } catch { /* file may not exist yet if write failed */ }

    // ── Lint ──
    mod.status = 'linting';
    yield { type: 'progress', content: `Linting ${mod.name}...` };

    let lintPassed = false;
    const MAX_LINT_RETRIES = 3;
    for (let attempt = 0; attempt < MAX_LINT_RETRIES; attempt++) {
      try {
        const lintResult = await ctx.executeAction({
          type: 'lintCode',
          payload: { file: mod.file },
        });
        if (!lintResult.includes('error') && !lintResult.includes('Error')) {
          lintPassed = true;
          yield { type: 'status', content: `Lint passed: ${mod.name}` };
          break;
        }
        yield { type: 'status', content: `Lint errors in ${mod.name}, fixing (attempt ${attempt + 1})...` };
        const fixed = await fixLintErrors(ctx, mod.name, lintResult);
        if (!fixed) {
          yield { type: 'status', content: `Lint fix failed for ${mod.name}` };
          break;
        }
      } catch {
        yield { type: 'status', content: `Lint skipped: ${mod.name} (tool unavailable)` };
        lintPassed = true; // Don't block on missing lint tool
        break;
      }
    }
    mod.lintPassed = lintPassed;

    // ── VE: generate UT testbench + TC ──
    mod.status = 'testing';
    yield { type: 'progress', content: `Generating UT for ${mod.name}...` };

    const modEntry = ctx.designIndex.modules.find(m => m.name === mod.name);
    const ports = modEntry?.ports ?? [];
    const utReqs = phase2.utVerification;
    const utReqsStr = [
      'Scenarios: ' + utReqs.scenarios.join('; '),
      'Edge cases: ' + utReqs.edgeCases.join('; '),
      'Expected: ' + utReqs.expectedBehavior.join('; '),
    ].join('\n');

    for await (const chunk of generateUTTestbench(ctx, mod.name, ports, utReqsStr)) {
      yield chunk;
    }

    // ── Simulate each TC ──
    yield { type: 'progress', content: `Simulating UT for ${mod.name}...` };

    try {
      const simResult = await ctx.executeAction({
        type: 'runSimulation',
        payload: { module: mod.name, testType: 'ut' },
      });

      const result = checkSimResult(simResult);
      if (result === 'pass') {
        mod.utPassed = true;
        mod.status = 'done';
        yield { type: 'status', content: `UT passed: ${mod.name}` };
        return;
      }

      // ── Debug loop ──
      yield { type: 'status', content: `UT failed for ${mod.name}, entering debug loop...` };
      for await (const chunk of runDebugLoop(ctx, mod, simResult)) {
        yield chunk;
      }

      if (mod.utPassed) {
        mod.status = 'done';
        yield { type: 'status', content: `UT passed after debug: ${mod.name}` };
      } else {
        mod.status = 'failed';
        yield { type: 'status', content: `UT still failing: ${mod.name}` };
      }
    } catch (err) {
      yield { type: 'status', content: `Simulation skipped: ${mod.name} (${err instanceof Error ? err.message : err})` };
      mod.utPassed = false;
      mod.status = 'failed';
    }
  }

  // -----------------------------------------------------------------------
  // System test
  // -----------------------------------------------------------------------

  private async *executeSystemTest(ctx: StageContext): AsyncGenerator<OutputChunk> {
    if (!this.workflowState || !ctx.phase1Output) return;

    const passedModules = this.workflowState.moduleStatuses.filter(m => m.status === 'done');
    const failedModules = this.workflowState.moduleStatuses.filter(m => m.status === 'failed' || m.status === 'skipped');

    if (failedModules.length > 0) {
      yield { type: 'status', content: `Warning: ${failedModules.length} module(s) not passing: ${failedModules.map(m => m.name).join(', ')}` };
    }

    if (passedModules.length < 2) {
      yield { type: 'status', content: 'Skipping system test (need at least 2 passing modules).' };
      return;
    }

    yield { type: 'progress', content: 'Generating system test...' };

    const stReqs = ctx.phase1Output.stVerification;
    const stReqsStr = [
      'Scenarios: ' + stReqs.scenarios.join('; '),
      'Integration paths: ' + stReqs.integrationPaths.join('; '),
    ].join('\n');

    const allPorts = ctx.designIndex.modules.map(m => ({
      name: m.name,
      ports: m.ports,
    }));
    const topModule = ctx.designIndex.topModules[0] ?? 'top';

    for await (const chunk of generateSTTestbench(ctx, stReqsStr, allPorts, topModule)) {
      yield chunk;
    }

    // Run ST simulation
    yield { type: 'progress', content: 'Running system test...' };
    try {
      const simResult = await ctx.executeAction({
        type: 'runSimulation',
        payload: { testType: 'st' },
      });
      const result = checkSimResult(simResult);
      if (result === 'pass') {
        yield { type: 'status', content: 'System test PASSED' };
      } else {
        yield { type: 'status', content: 'System test FAILED. Check logs for details.' };
      }
    } catch (err) {
      yield { type: 'status', content: `System test skipped: ${err instanceof Error ? err.message : err}` };
    }
  }

  // -----------------------------------------------------------------------
  // Helpers
  // -----------------------------------------------------------------------

  private initWorkflowState(
    goal: string,
    phase1: ArchitectPhase1Output,
  ): WorkflowState {
    const moduleStatuses: ModuleStatus[] = phase1.dependencyOrder.map(name => {
      const mod = phase1.modules.find(m => m.name === name);
      return {
        name,
        file: `hw/src/hdl/${name}.v`,
        lintPassed: false,
        utPassed: false,
        sameErrorRetries: 0,
        totalIterations: 0,
        tbSuspectCount: 0,
        status: 'pending' as const,
        lintAttempts: 0,
        veCompileAttempts: 0,
        debugHistory: [],
      };
    });

    return {
      plan: {
        goal,
        scope: 'standard',
        steps: [
          { id: 1, stage: 'architect_p1', description: 'Design architecture', status: 'done' },
          { id: 2, stage: 'rtl', description: 'Generate RTL code', status: 'pending' },
          { id: 3, stage: 've_ut', description: 'Unit verification', status: 'pending' },
          { id: 4, stage: 've_st', description: 'System verification', status: 'pending' },
        ],
        currentStep: 2,
      },
      phase1Output: phase1,
      moduleStatuses,
      currentModuleIndex: 0,
      lastUpdated: new Date().toISOString(),
    };
  }

  private getDependentModulePorts(
    moduleName: string,
    designIndex: DesignIndex,
  ): Array<{ name: string; ports: PortDef[] }> {
    const mod = designIndex.modules.find(m => m.name === moduleName);
    if (!mod?.instances?.length) return [];

    return mod.instances
      .map(inst => {
        const dep = designIndex.modules.find(m => m.name === inst.moduleName);
        return dep ? { name: dep.name, ports: dep.ports } : null;
      })
      .filter((d): d is { name: string; ports: PortDef[] } => d !== null);
  }

  private findDependentModules(moduleName: string, designIndex: DesignIndex): string[] {
    return designIndex.modules
      .filter(m => m.instances?.some(inst => inst.moduleName === moduleName))
      .map(m => m.name);
  }

  private async persistState(ctx: StageContext): Promise<void> {
    if (this.workflowState) {
      this.workflowState.lastUpdated = new Date().toISOString();
      await ctx.saveState(this.workflowState).catch(() => {});
    }
  }

  private describeState(): string {
    if (!this.workflowState) return 'No active workflow';
    const { moduleStatuses, currentModuleIndex } = this.workflowState;
    const done = moduleStatuses.filter(m => m.status === 'done').length;
    return `${done}/${moduleStatuses.length} modules done, current: ${moduleStatuses[currentModuleIndex]?.name ?? 'unknown'}`;
  }
}
