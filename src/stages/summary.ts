/**
 * Summary report generation for RTL-Claw v2.
 *
 * Template-based (no LLM calls). Generates a text report summarizing
 * the workflow: module statuses, pass/fail counts, completed steps,
 * and outstanding issues.
 */

import type { WorkflowState, ModuleStatus } from '../agents/types.js';
import type { OutputChunk } from './types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function statusIcon(status: ModuleStatus['status']): string {
  switch (status) {
    case 'done':    return 'PASS';
    case 'failed':  return 'FAIL';
    case 'skipped': return 'SKIP';
    default:        return status.toUpperCase();
  }
}

function padRight(str: string, len: number): string {
  return str.length >= len ? str : str + ' '.repeat(len - str.length);
}

function padLeft(str: string, len: number): string {
  return str.length >= len ? str : ' '.repeat(len - str.length) + str;
}

function yesNo(val: boolean): string {
  return val ? 'yes' : 'no';
}

// ---------------------------------------------------------------------------
// Summary generator
// ---------------------------------------------------------------------------

export function* generateSummary(workflowState: WorkflowState): Generator<OutputChunk> {
  const { plan, moduleStatuses } = workflowState;
  const lines: string[] = [];

  // ---- Header ----
  lines.push('='.repeat(64));
  lines.push('  RTL-Claw v2 -- Workflow Summary Report');
  lines.push('='.repeat(64));
  lines.push('');

  // ---- Goal ----
  lines.push(`Goal: ${plan.goal}`);
  lines.push(`Scope: ${plan.scope}`);
  lines.push('');

  // ---- Module status table ----
  lines.push('--- Module Status ---');
  lines.push('');

  const nameWidth = Math.max(12, ...moduleStatuses.map(m => m.name.length));
  const header =
    padRight('Module', nameWidth) +
    ' | ' +
    padLeft('Lint', 6) +
    ' | ' +
    padLeft('UT', 6) +
    ' | ' +
    padLeft('Status', 10);
  const sep =
    '-'.repeat(nameWidth) +
    '-+-' +
    '-'.repeat(6) +
    '-+-' +
    '-'.repeat(6) +
    '-+-' +
    '-'.repeat(10);

  lines.push(header);
  lines.push(sep);

  for (const mod of moduleStatuses) {
    lines.push(
      padRight(mod.name, nameWidth) +
        ' | ' +
        padLeft(yesNo(mod.lintPassed), 6) +
        ' | ' +
        padLeft(yesNo(mod.utPassed), 6) +
        ' | ' +
        padLeft(statusIcon(mod.status), 10),
    );
  }

  lines.push('');

  // ---- Pass / fail counts ----
  const total = moduleStatuses.length;
  const passed = moduleStatuses.filter(m => m.status === 'done').length;
  const failed = moduleStatuses.filter(m => m.status === 'failed').length;
  const skipped = moduleStatuses.filter(m => m.status === 'skipped').length;
  const pending = total - passed - failed - skipped;

  lines.push('--- Results ---');
  lines.push('');
  lines.push(`  Total modules : ${total}`);
  lines.push(`  Passed        : ${passed}`);
  lines.push(`  Failed        : ${failed}`);
  lines.push(`  Skipped       : ${skipped}`);
  if (pending > 0) {
    lines.push(`  Pending       : ${pending}`);
  }
  lines.push('');

  // ---- Workflow steps ----
  const completedSteps = plan.steps.filter(s => s.status === 'done');
  const failedSteps = plan.steps.filter(s => s.status === 'failed');

  lines.push('--- Workflow Steps ---');
  lines.push('');

  for (const step of plan.steps) {
    const marker =
      step.status === 'done'    ? '[x]' :
      step.status === 'failed'  ? '[!]' :
      step.status === 'skipped' ? '[-]' :
      step.status === 'running' ? '[>]' :
      '[ ]';
    lines.push(`  ${marker} Step ${step.id}: ${step.description} (${step.status})`);
  }

  lines.push('');
  lines.push(`  Completed: ${completedSteps.length} / ${plan.steps.length}`);
  if (failedSteps.length > 0) {
    lines.push(`  Failed: ${failedSteps.length}`);
  }
  lines.push('');

  // ---- Outstanding issues ----
  const issueModules = moduleStatuses.filter(
    m => m.status === 'failed' || m.status === 'skipped',
  );

  if (issueModules.length > 0) {
    lines.push('--- Outstanding Issues ---');
    lines.push('');

    for (const mod of issueModules) {
      const reason =
        mod.status === 'failed'
          ? `Failed after ${mod.totalIterations} debug iterations (${mod.sameErrorRetries} same-error retries)`
          : 'Skipped by user';
      lines.push(`  * ${mod.name}: ${reason}`);

      if (!mod.lintPassed) {
        lines.push(`    - Lint not passed`);
      }
      if (!mod.utPassed) {
        lines.push(`    - Unit test not passed`);
      }
      if (mod.tbSuspectCount > 0) {
        lines.push(`    - Testbench suspected ${mod.tbSuspectCount} time(s)`);
      }
    }

    lines.push('');
  }

  // ---- Footer ----
  lines.push('='.repeat(64));
  lines.push(`  Report generated: ${workflowState.lastUpdated}`);
  lines.push('='.repeat(64));

  yield { type: 'text', content: lines.join('\n') };
}
