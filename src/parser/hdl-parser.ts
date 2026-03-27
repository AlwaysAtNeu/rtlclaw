/**
 * Static HDL structural parser for Verilog, SystemVerilog, and VHDL.
 * Uses regex-based parsing to extract module/entity structure without a full grammar.
 */

import { readFile, readdir, stat } from 'node:fs/promises';
import { join, extname, dirname, resolve } from 'node:path';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

// Re-export unified types from agents/types.ts for backward compatibility
import type { PortDef, ParamDef, InstanceDef, ModuleEntry, HierarchyNode, DesignIndex } from '../agents/types.js';

// Keep local aliases for parser internal use
export type PortInfo = PortDef;
export type ParamInfo = ParamDef;
export type InstanceInfo = InstanceDef;
export type ModuleInfo = ModuleEntry;
export type { HierarchyNode, DesignIndex };

/** Parser-internal build result (uses Map for efficient lookup) */
export interface ParsedIndex {
  modules: Map<string, ModuleInfo>;
  hierarchy: HierarchyNode[];
  fileManifest: string[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Strip single-line and block comments from HDL source. */
function stripComments(src: string, lang: 'verilog' | 'systemverilog' | 'vhdl'): string {
  if (lang === 'vhdl') {
    // VHDL uses -- for single-line comments, no block comments in VHDL-2008
    return src.replace(/--[^\n]*/g, '');
  }
  // Verilog / SystemVerilog: // and /* */
  return src
    .replace(/\/\/[^\n]*/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '');
}

function detectLanguage(filePath: string): 'verilog' | 'systemverilog' | 'vhdl' | null {
  const ext = extname(filePath).toLowerCase();
  switch (ext) {
    case '.v':
    case '.vh':
      return 'verilog';
    case '.sv':
    case '.svh':
      return 'systemverilog';
    case '.vhd':
    case '.vhdl':
      return 'vhdl';
    default:
      return null;
  }
}

/** Parse a width expression like [7:0] and return the width (8). */
function parseWidth(expr: string): { width: number; widthExpr: string } {
  if (!expr || expr.trim() === '') {
    return { width: 1, widthExpr: '' };
  }
  const m = expr.match(/\[\s*(\d+)\s*:\s*(\d+)\s*\]/);
  if (m) {
    const hi = parseInt(m[1], 10);
    const lo = parseInt(m[2], 10);
    return { width: Math.abs(hi - lo) + 1, widthExpr: expr.trim() };
  }
  // Could be a parameterised width – just store the expression
  return { width: 0, widthExpr: expr.trim() };
}

// ---------------------------------------------------------------------------
// Verilog / SystemVerilog parsing
// ---------------------------------------------------------------------------

function parseVerilogPorts(body: string): PortInfo[] {
  const ports: PortInfo[] = [];

  // ANSI-style port declarations: input/output/inout [wire|reg|logic] [signed|unsigned] [width] name
  // Use [ \t] (not \s) for comma separator to avoid matching across newlines
  const ansiRe = /\b(input|output|inout)\s+(?:(?:wire|reg|logic)\s+)?(?:(?:signed|unsigned)\s+)?(\[[^\]]*\])?\s*([A-Za-z_]\w*(?:[ \t]*,[ \t]*[A-Za-z_]\w*)*)/g;
  let m: RegExpExecArray | null;
  while ((m = ansiRe.exec(body)) !== null) {
    const direction = m[1] as PortInfo['direction'];
    const widthRaw = m[2] ?? '';
    const { width, widthExpr } = parseWidth(widthRaw);
    const names = m[3].split(',').map(n => n.trim()).filter(Boolean);
    for (const name of names) {
      ports.push({ name, direction, width, widthExpr });
    }
  }

  return ports;
}

function parseVerilogParams(header: string): ParamInfo[] {
  const params: ParamInfo[] = [];
  // #( parameter NAME = VALUE, ... )
  const paramBlockRe = /#\s*\(([\s\S]*?)\)/;
  const blockMatch = paramBlockRe.exec(header);
  if (!blockMatch) return params;

  const block = blockMatch[1];
  const paramRe = /parameter\s+(?:(?:int|integer|real|string|bit|logic|reg|signed|unsigned)\s+)?(?:\[[^\]]*\]\s*)?([A-Za-z_]\w*)\s*=\s*([^,)]+)/g;
  let m: RegExpExecArray | null;
  while ((m = paramRe.exec(block)) !== null) {
    params.push({ name: m[1].trim(), defaultValue: m[2].trim() });
  }
  return params;
}

function parseVerilogInstances(body: string, file: string): InstanceInfo[] {
  const instances: InstanceInfo[] = [];
  // Module instantiation: ModName #(...) instName (...);  or  ModName instName (...);
  // Exclude keywords that look like instantiations
  const keywords = new Set([
    'module', 'endmodule', 'input', 'output', 'inout', 'wire', 'reg', 'logic',
    'assign', 'always', 'initial', 'begin', 'end', 'if', 'else', 'case',
    'for', 'while', 'generate', 'endgenerate', 'function', 'endfunction',
    'task', 'endtask', 'parameter', 'localparam', 'integer', 'real', 'time',
    'genvar', 'default', 'posedge', 'negedge', 'or', 'and', 'not', 'buf',
    'pullup', 'pulldown', 'supply0', 'supply1', 'tri', 'wand', 'wor',
  ]);

  // Match: identifier (optional #(...)) identifier (...) ;
  const instRe = /\b([A-Za-z_]\w*)\s+(?:#\s*\([\s\S]*?\)\s*)?([A-Za-z_]\w*)\s*\(/g;
  const lines = body.split('\n');
  let offset = 0;

  for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
    const line = lines[lineIdx];
    // Quick pre-filter: skip lines that obviously aren't instantiations
    instRe.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = instRe.exec(line)) !== null) {
      const modName = m[1];
      const instName = m[2];
      if (!keywords.has(modName) && !keywords.has(instName)) {
        instances.push({
          moduleName: modName,
          instanceName: instName,
          file,
          line: lineIdx + 1,
        });
      }
    }
    offset += line.length + 1;
  }

  return instances;
}

function parseVerilogModules(src: string, filePath: string, lang: 'verilog' | 'systemverilog'): ModuleInfo[] {
  const clean = stripComments(src, lang);
  const modules: ModuleInfo[] = [];

  // Match: module name #(params) (ports); ... endmodule
  const moduleRe = /\bmodule\s+([A-Za-z_]\w*)\s*(#\s*\([\s\S]*?\))?\s*\(([\s\S]*?)\)\s*;([\s\S]*?)endmodule/g;
  let m: RegExpExecArray | null;
  while ((m = moduleRe.exec(clean)) !== null) {
    const name = m[1];
    const paramSection = m[2] ?? '';
    const portSection = m[3] ?? '';
    const body = m[4] ?? '';

    const ports = parseVerilogPorts(portSection + '\n' + body);
    const params = parseVerilogParams(paramSection);
    const instances = parseVerilogInstances(body, filePath);

    modules.push({
      name,
      file: filePath,
      language: lang,
      ports,
      params,
      instances,
    });
  }

  return modules;
}

// ---------------------------------------------------------------------------
// VHDL parsing
// ---------------------------------------------------------------------------

function parseVhdlPorts(portSection: string): PortInfo[] {
  const ports: PortInfo[] = [];
  // name : in/out/inout std_logic_vector(7 downto 0)
  const portRe = /([A-Za-z_]\w*(?:\s*,\s*[A-Za-z_]\w*)*)\s*:\s*(in|out|inout|buffer)\s+(\w+)(?:\s*\(\s*(\d+)\s+(?:downto|to)\s+(\d+)\s*\))?/gi;
  let m: RegExpExecArray | null;
  while ((m = portRe.exec(portSection)) !== null) {
    const names = m[1].split(',').map(n => n.trim()).filter(Boolean);
    const dirRaw = m[2].toLowerCase();
    const direction: PortInfo['direction'] =
      dirRaw === 'out' ? 'output' :
      dirRaw === 'inout' || dirRaw === 'buffer' ? 'inout' : 'input';

    let width = 1;
    let widthExpr = '';
    if (m[4] !== undefined && m[5] !== undefined) {
      const hi = parseInt(m[4], 10);
      const lo = parseInt(m[5], 10);
      width = Math.abs(hi - lo) + 1;
      widthExpr = `(${m[4]} downto ${m[5]})`;
    }

    for (const name of names) {
      ports.push({ name, direction, width, widthExpr });
    }
  }
  return ports;
}

function parseVhdlGenerics(genericSection: string): ParamInfo[] {
  const params: ParamInfo[] = [];
  const genRe = /([A-Za-z_]\w*)\s*:\s*\w+(?:\s*:=\s*([^;]+))?/g;
  let m: RegExpExecArray | null;
  while ((m = genRe.exec(genericSection)) !== null) {
    params.push({ name: m[1], defaultValue: (m[2] ?? '').trim() });
  }
  return params;
}

function parseVhdlInstances(archBody: string, file: string): InstanceInfo[] {
  const instances: InstanceInfo[] = [];
  // label : entity work.ModName or label : ModName port map (...)
  const instRe = /([A-Za-z_]\w*)\s*:\s*(?:entity\s+\w+\.)?([A-Za-z_]\w*)\s+(?:generic\s+map[\s\S]*?)?port\s+map/gi;
  let m: RegExpExecArray | null;
  while ((m = instRe.exec(archBody)) !== null) {
    instances.push({
      moduleName: m[2],
      instanceName: m[1],
      file,
      line: archBody.substring(0, m.index).split('\n').length,
    });
  }
  return instances;
}

function parseVhdlEntities(src: string, filePath: string): ModuleInfo[] {
  const clean = stripComments(src, 'vhdl');
  const modules: ModuleInfo[] = [];

  // Entity declaration
  const entityRe = /\bentity\s+([A-Za-z_]\w*)\s+is\s*([\s\S]*?)end\s+(?:entity\s+)?(?:\1\s*)?;/gi;
  let m: RegExpExecArray | null;
  while ((m = entityRe.exec(clean)) !== null) {
    const name = m[1];
    const entityBody = m[2];

    // Extract port section
    const portMatch = /port\s*\(([\s\S]*?)\)\s*;/i.exec(entityBody);
    const ports = portMatch ? parseVhdlPorts(portMatch[1]) : [];

    // Extract generic section
    const genMatch = /generic\s*\(([\s\S]*?)\)\s*;/i.exec(entityBody);
    const params = genMatch ? parseVhdlGenerics(genMatch[1]) : [];

    // Look for architecture body to find instances
    const archRe = new RegExp(
      `architecture\\s+\\w+\\s+of\\s+${name}\\s+is[\\s\\S]*?begin([\\s\\S]*?)end\\s+(?:architecture\\s+)?\\w+\\s*;`,
      'gi',
    );
    const archMatch = archRe.exec(clean);
    const instances = archMatch ? parseVhdlInstances(archMatch[1], filePath) : [];

    modules.push({
      name,
      file: filePath,
      language: 'vhdl',
      ports,
      params,
      instances,
    });
  }

  return modules;
}

// ---------------------------------------------------------------------------
// HDLParser class
// ---------------------------------------------------------------------------

const HDL_EXTENSIONS = new Set(['.v', '.vh', '.sv', '.svh', '.vhd', '.vhdl']);

export class HDLParser {
  /**
   * Parse a single HDL file and return extracted modules/entities.
   */
  async parseFile(filePath: string): Promise<ModuleInfo[]> {
    const absPath = resolve(filePath);
    const lang = detectLanguage(absPath);
    if (!lang) return [];

    const src = await readFile(absPath, 'utf-8');

    if (lang === 'vhdl') {
      return parseVhdlEntities(src, absPath);
    }
    return parseVerilogModules(src, absPath, lang);
  }

  /**
   * Parse a .f filelist and return the list of source file paths.
   * Supports: file paths (one per line), +incdir+, -f (nested filelists),
   * comments (// and #), and relative paths resolved from the filelist location.
   */
  async parseFilelist(fPath: string): Promise<string[]> {
    const absPath = resolve(fPath);
    const baseDir = dirname(absPath);
    const content = await readFile(absPath, 'utf-8');
    const files: string[] = [];

    for (const rawLine of content.split('\n')) {
      const line = rawLine.replace(/\/\/.*$/, '').replace(/#.*$/, '').trim();
      if (!line) continue;

      // Skip +incdir+ and similar plusargs
      if (line.startsWith('+')) continue;

      // Skip common flags
      if (line.startsWith('-D') || line.startsWith('-I') || line.startsWith('-y')) continue;

      // Nested filelist
      if (line.startsWith('-f')) {
        const nested = line.replace(/^-f\s+/, '').trim();
        if (nested) {
          const nestedPath = resolve(baseDir, nested);
          const nestedFiles = await this.parseFilelist(nestedPath);
          files.push(...nestedFiles);
        }
        continue;
      }

      // Skip other flags
      if (line.startsWith('-')) continue;

      // Must be a file path
      files.push(resolve(baseDir, line));
    }

    return files;
  }

  /**
   * Recursively scan a directory for HDL files and parse them all.
   */
  async parseProject(dir: string): Promise<ModuleInfo[]> {
    const absDir = resolve(dir);
    const files = await this.collectHdlFiles(absDir);
    const allModules: ModuleInfo[] = [];

    for (const f of files) {
      try {
        const mods = await this.parseFile(f);
        allModules.push(...mods);
      } catch {
        // Skip files that can't be parsed
      }
    }

    return allModules;
  }

  /**
   * Build a ParsedIndex from a list of file paths.
   */
  async buildIndex(files: string[]): Promise<ParsedIndex> {
    const modules = new Map<string, ModuleInfo>();
    const fileManifest: string[] = [];

    for (const f of files) {
      const absPath = resolve(f);
      fileManifest.push(absPath);

      try {
        const mods = await this.parseFile(absPath);
        for (const mod of mods) {
          modules.set(mod.name, mod);
        }
      } catch {
        // Skip unparseable files
      }
    }

    // Build hierarchy: find top-level modules (those never instantiated by others)
    const instantiatedModules = new Set<string>();
    for (const mod of modules.values()) {
      for (const inst of mod.instances) {
        instantiatedModules.add(inst.moduleName);
      }
    }

    const buildTree = (moduleName: string, instName: string, visited: Set<string>): HierarchyNode => {
      const node: HierarchyNode = { moduleName, instanceName: instName, children: [] };
      if (visited.has(moduleName)) return node; // prevent cycles
      visited.add(moduleName);

      const mod = modules.get(moduleName);
      if (mod) {
        for (const inst of mod.instances) {
          node.children.push(buildTree(inst.moduleName, inst.instanceName, new Set(visited)));
        }
      }
      return node;
    };

    const hierarchy: HierarchyNode[] = [];
    for (const mod of modules.values()) {
      if (!instantiatedModules.has(mod.name)) {
        hierarchy.push(buildTree(mod.name, mod.name, new Set()));
      }
    }

    return { modules, hierarchy, fileManifest };
  }

  /**
   * Convert ParsedIndex (with Map) to the unified DesignIndex (with array).
   */
  static toDesignIndex(parsed: ParsedIndex): DesignIndex {
    const modules = Array.from(parsed.modules.values());
    const topModules = parsed.hierarchy.map(h => h.moduleName);
    return {
      modules,
      hierarchy: parsed.hierarchy,
      topModules,
      timestamp: new Date().toISOString(),
    };
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  private async collectHdlFiles(dir: string): Promise<string[]> {
    const results: string[] = [];
    let entries: import('node:fs').Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return results;
    }

    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        const sub = await this.collectHdlFiles(fullPath);
        results.push(...sub);
      } else if (entry.isFile() && HDL_EXTENSIONS.has(extname(entry.name).toLowerCase())) {
        results.push(fullPath);
      }
    }
    return results;
  }
}
