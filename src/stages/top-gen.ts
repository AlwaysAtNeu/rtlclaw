/**
 * Top module auto-generation (v3).
 *
 * Deterministic (no LLM) — generates a purely structural top module that:
 *  - Declares top-level ports from topPorts
 *  - Instantiates all child modules with u_ prefix
 *  - Wires inter-module signals from interface contracts
 *  - Auto-wires infrastructure signals (clk/rst) by port name matching
 *  - Includes design_params
 */

import type {
  ArchitectPhase1Output,
  InterfaceContract,
  TopPort,
} from '../agents/types.js';
import type { StageContext, OutputChunk } from './types.js';

/**
 * Generate a top-level module for the given top module name.
 */
export async function* generateTopModule(
  ctx: StageContext,
  phase1: ArchitectPhase1Output,
  topModuleName: string,
  hdlStandard?: string,
): AsyncGenerator<OutputChunk> {
  yield { type: 'progress', content: `Generating top module "${topModuleName}"...` };

  const topMod = phase1.modules.find(m => m.name === topModuleName);
  if (!topMod) {
    yield { type: 'error', content: `Top module "${topModuleName}" not found in architecture.` };
    return;
  }

  const isSV = hdlStandard?.startsWith('sv');
  const ext = isSV ? '.sv' : '.v';
  const topPorts = phase1.topPorts ?? [];
  const contracts = phase1.interfaceContracts ?? [];
  const childModules = topMod.instances.map(i => {
    const mod = phase1.modules.find(m => m.name === i.moduleName);
    return { instanceName: i.instanceName, moduleName: i.moduleName, mod };
  });

  const lines: string[] = [];

  // Header
  lines.push('// Auto-generated top module — do not edit manually');
  if (isSV) {
    lines.push('import design_params_pkg::*;');
  } else {
    lines.push('`include "design_params.vh"');
  }
  lines.push('');

  // Module declaration
  lines.push(`module ${topModuleName} (`);
  const portLines = generatePortDeclarations(topPorts, !!isSV);
  lines.push(portLines);
  lines.push(');');
  lines.push('');

  // Internal wire declarations from interface contracts
  const wireLines = generateWireDeclarations(contracts, !!isSV);
  if (wireLines.length > 0) {
    lines.push('  // Inter-module wires from interface contracts');
    lines.push(...wireLines);
    lines.push('');
  }

  // Instance declarations
  for (const child of childModules) {
    if (!child.mod) {
      lines.push(`  // WARNING: module "${child.moduleName}" not found in architecture`);
      continue;
    }

    const instName = child.instanceName.startsWith('u_')
      ? child.instanceName
      : `u_${child.moduleName}`;

    lines.push(`  ${child.moduleName} ${instName} (`);

    const connections = generatePortConnections(
      child.moduleName,
      child.mod.ports,
      contracts,
      topPorts,
    );
    lines.push(connections);
    lines.push('  );');
    lines.push('');
  }

  lines.push('endmodule');
  lines.push('');

  const filePath = `hw/src/hdl/${topModuleName}${ext}`;
  const content = lines.join('\n');

  await ctx.executeAction({
    type: 'writeFile',
    payload: { path: filePath, content },
  });

  // Append to filelist
  await ctx.executeAction({
    type: 'writeFile',
    payload: {
      path: 'hw/src/filelist/design.f',
      content: filePath,
      append: true,
    },
  });

  yield {
    type: 'status',
    content: `Top module generated: ${filePath}`,
    metadata: { file: filePath },
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function generatePortDeclarations(topPorts: TopPort[], isSV: boolean): string {
  if (topPorts.length === 0) return '';

  const lines = topPorts.map((p, i) => {
    const comma = i < topPorts.length - 1 ? ',' : '';
    const widthStr = p.widthExpr || (p.width > 1 ? `[${p.width - 1}:0]` : '');
    const typeStr = isSV ? '' : (p.direction === 'output' ? ' reg' : '');
    // For top module ports in auto-gen, we don't use 'reg' — purely structural
    return `  ${p.direction} ${widthStr} ${p.name}${comma}`.replace(/\s+/g, ' ').trim();
  });

  return lines.map(l => `  ${l}`).join('\n');
}

function generateWireDeclarations(
  contracts: InterfaceContract[],
  isSV: boolean,
): string[] {
  const lines: string[] = [];
  const declaredWires = new Set<string>();

  for (const contract of contracts) {
    for (const sig of contract.signals) {
      // Wire name: contract_name + signal_name for uniqueness
      const wireName = `${contract.name}_${sig.name}`;
      if (declaredWires.has(wireName)) continue;
      declaredWires.add(wireName);

      const widthStr = sig.widthExpr || (sig.width > 1 ? `[${sig.width - 1}:0]` : '');
      const keyword = isSV ? 'logic' : 'wire';
      lines.push(`  ${keyword} ${widthStr} ${wireName};`.replace(/\s+/g, ' ').trimEnd() + '');
    }
  }

  return lines;
}

function generatePortConnections(
  moduleName: string,
  ports: Array<{ name: string; direction: string; width: number; widthExpr?: string }>,
  contracts: InterfaceContract[],
  topPorts: TopPort[],
): string {
  const topPortNames = new Set(topPorts.map(p => p.name));
  const infraPatterns = ['clk', 'rst', 'rst_n', 'reset', 'reset_n'];

  // Build a mapping: port_name → wire_name from contracts
  const contractWireMap = new Map<string, string>();
  for (const contract of contracts) {
    for (const sig of contract.signals) {
      const mappedName = contract.signalMapping?.[moduleName]?.[sig.name] ?? sig.name;
      const wireName = `${contract.name}_${sig.name}`;

      if (contract.producer === moduleName || contract.consumers.includes(moduleName)) {
        contractWireMap.set(mappedName, wireName);
      }
    }
  }

  const connections = ports.map((port, i) => {
    const comma = i < ports.length - 1 ? ',' : '';
    let connectedTo: string;

    if (contractWireMap.has(port.name)) {
      // Connected via interface contract wire
      connectedTo = contractWireMap.get(port.name)!;
    } else if (topPortNames.has(port.name)) {
      // Connected directly to top port (same name)
      connectedTo = port.name;
    } else if (infraPatterns.some(p => port.name === p || port.name.startsWith(p + '_'))) {
      // Infrastructure signal — auto-wire by name
      connectedTo = port.name;
    } else {
      // Mapped to top port via mappedTo
      const topPort = topPorts.find(tp => tp.mappedTo === `${moduleName}.${port.name}`);
      connectedTo = topPort ? topPort.name : port.name;
    }

    return `    .${port.name}(${connectedTo})${comma}`;
  });

  return connections.join('\n');
}
