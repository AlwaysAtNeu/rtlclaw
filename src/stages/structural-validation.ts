/**
 * Structural validation for Architect Phase 1 output (v3).
 *
 * Pure logic — no LLM calls. Validates:
 *  - Acyclic dependency graph
 *  - All instantiated modules exist
 *  - Unique module names
 *  - Top modules exist in module list
 *  - Interface contract producer/consumer modules exist
 *  - Interface contract signal names exist in corresponding module port lists
 */

import type { ArchitectPhase1Output } from '../agents/types.js';

export interface ValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

export function validatePhase1Structure(
  phase1: ArchitectPhase1Output,
): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const moduleNames = new Set(phase1.modules.map(m => m.name));

  // 1. Unique module names
  const nameCounts = new Map<string, number>();
  for (const mod of phase1.modules) {
    nameCounts.set(mod.name, (nameCounts.get(mod.name) ?? 0) + 1);
  }
  for (const [name, count] of nameCounts) {
    if (count > 1) {
      errors.push(`Duplicate module name: "${name}" appears ${count} times`);
    }
  }

  // 2. Top modules exist in modules[]
  for (const top of phase1.topModules) {
    if (!moduleNames.has(top)) {
      errors.push(`Top module "${top}" not found in modules list`);
    }
  }

  // 3. All instantiated modules exist
  for (const mod of phase1.modules) {
    for (const inst of mod.instances) {
      if (!moduleNames.has(inst.moduleName)) {
        errors.push(
          `Module "${mod.name}" instantiates "${inst.moduleName}" which does not exist in modules list`,
        );
      }
    }
  }

  // 4. Dependency order contains all modules
  const depSet = new Set(phase1.dependencyOrder);
  for (const mod of phase1.modules) {
    if (!depSet.has(mod.name)) {
      warnings.push(
        `Module "${mod.name}" not found in dependencyOrder`,
      );
    }
  }

  // 5. Acyclic dependency graph (topological sort check)
  const cycleError = checkForCycles(phase1);
  if (cycleError) {
    errors.push(cycleError);
  }

  // 6. Interface contract validation (v3)
  if (phase1.interfaceContracts?.length) {
    for (const contract of phase1.interfaceContracts) {
      // Producer exists
      if (!moduleNames.has(contract.producer)) {
        errors.push(
          `Interface contract "${contract.name}": producer "${contract.producer}" not found in modules list`,
        );
      }

      // Consumers exist
      for (const consumer of contract.consumers) {
        if (!moduleNames.has(consumer)) {
          errors.push(
            `Interface contract "${contract.name}": consumer "${consumer}" not found in modules list`,
          );
        }
      }

      // Signal names exist in corresponding module port lists
      const producerMod = phase1.modules.find(m => m.name === contract.producer);
      if (producerMod) {
        const producerPortNames = new Set(producerMod.ports.map(p => p.name));
        for (const sig of contract.signals) {
          // Check if signalMapping provides an override
          const mappedName = contract.signalMapping?.[contract.producer]?.[sig.name] ?? sig.name;
          if (!producerPortNames.has(mappedName)) {
            errors.push(
              `Interface contract "${contract.name}": signal "${sig.name}" (mapped: "${mappedName}") not found in producer "${contract.producer}" ports`,
            );
          }
        }
      }

      for (const consumerName of contract.consumers) {
        const consumerMod = phase1.modules.find(m => m.name === consumerName);
        if (consumerMod) {
          const consumerPortNames = new Set(consumerMod.ports.map(p => p.name));
          for (const sig of contract.signals) {
            const mappedName = contract.signalMapping?.[consumerName]?.[sig.name] ?? sig.name;
            if (!consumerPortNames.has(mappedName)) {
              errors.push(
                `Interface contract "${contract.name}": signal "${sig.name}" (mapped: "${mappedName}") not found in consumer "${consumerName}" ports`,
              );
            }
          }
        }
      }
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}

/**
 * Check for cycles in the module dependency graph using DFS.
 * Returns an error message if a cycle is found, null otherwise.
 */
function checkForCycles(phase1: ArchitectPhase1Output): string | null {
  // Build adjacency list: module → modules it depends on (instantiates)
  const adj = new Map<string, string[]>();
  for (const mod of phase1.modules) {
    adj.set(
      mod.name,
      mod.instances.map(i => i.moduleName),
    );
  }

  const visited = new Set<string>();
  const inStack = new Set<string>();

  function dfs(node: string, path: string[]): string | null {
    if (inStack.has(node)) {
      const cycleStart = path.indexOf(node);
      const cycle = path.slice(cycleStart).concat(node);
      return `Cyclic dependency detected: ${cycle.join(' → ')}`;
    }
    if (visited.has(node)) return null;

    visited.add(node);
    inStack.add(node);
    path.push(node);

    for (const dep of adj.get(node) ?? []) {
      const result = dfs(dep, path);
      if (result) return result;
    }

    path.pop();
    inStack.delete(node);
    return null;
  }

  for (const mod of phase1.modules) {
    const result = dfs(mod.name, []);
    if (result) return result;
  }

  return null;
}
